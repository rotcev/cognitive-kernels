/**
 * Codex SDK bridge — wraps @openai/codex-sdk to implement Brain/BrainThread.
 *
 * Handles:
 * - Turn result normalization (Codex Turn → TurnResult)
 * - Per-thread MCP routing via two Codex instances (default + browser-capable)
 * - Sandbox mode mapping (orchestrator-read-only → read-only)
 * - Streaming event translation (ThreadEvent → StreamEvent)
 */

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Codex, type CodexOptions, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import type {
  Brain,
  BrainThread,
  ExtendedBrainThreadOptions,
  McpServerConfig,
  TurnResult,
  StreamEventCallback,
  StreamEventUsage,
} from "../types.js";
import {
  summarizeToolError,
  summarizeToolValue,
} from "./tool-event-utils.js";

const PRESERVED_CODEX_ENV_VARS = new Set([
  "CODEX_API_KEY",
  "CODEX_CI",
]);

type CodexIsolationOptions = {
  isolatedCodexHome?: string;
  sourceCodexHome?: string;
};

function defaultIsolatedCodexHome(): string {
  return process.env.COGNITIVE_KERNELS_CODEX_HOME
    ?? path.join(os.homedir(), ".cognitive-kernels", "codex-home");
}

// ─── OpenAI strict schema normalization ──────────────────────────────────────
// OpenAI structured outputs require `additionalProperties: false` on every object
// and all properties listed in `required`. This transform is applied only in the
// Codex SDK path so the Claude schemas stay untouched.

// OpenAI doesn't support bare `{}` (untyped) schemas. Use anyOf with JSON primitives.
const ANY_TYPE_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "object", additionalProperties: false, properties: {}, required: [] as string[] },
    { type: "array", items: { type: "string" } },
  ],
};

function isBarSchema(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  return keys.length === 0;
}

function strictifySchema(schema: unknown): unknown {
  if (schema === null || schema === undefined || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(strictifySchema);
  }

  const obj = schema as Record<string, unknown>;

  // Bare `{}` — no type, no properties — means "any value"
  if (isBarSchema(obj)) {
    return ANY_TYPE_SCHEMA;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      // Recurse into each property definition
      const props: Record<string, unknown> = {};
      for (const [propName, propDef] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = strictifySchema(propDef);
      }
      result[key] = props;
    } else if (key === "items") {
      result[key] = strictifySchema(value);
    } else {
      result[key] = value;
    }
  }

  // If this is an object type with properties, enforce strict mode
  if (result.type === "object" && result.properties) {
    result.additionalProperties = false;
    // OpenAI requires all properties in required — fill if not already complete
    const propNames = Object.keys(result.properties as Record<string, unknown>);
    result.required = propNames;
  }

  // Object type without properties (e.g. `{ type: "object" }` used for env maps)
  // needs empty properties + additionalProperties: false
  if (result.type === "object" && !result.properties) {
    result.properties = {};
    result.additionalProperties = false;
    result.required = [];
  }

  // Array type without items — OpenAI requires items on every array
  if (result.type === "array" && !result.items) {
    result.items = ANY_TYPE_SCHEMA;
  }

  return result;
}

// ─── Usage normalization ─────────────────────────────────────────────────────

function normalizeUsage(sdk: Usage): StreamEventUsage {
  return {
    inputTokens: sdk.input_tokens,
    outputTokens: sdk.output_tokens,
    totalCostUsd: 0,   // Codex SDK doesn't provide cost
    durationMs: 0,     // Codex SDK doesn't provide duration
    numTurns: 1,
  };
}

function buildAmbientEnvSnapshot(input?: Record<string, string>): Record<string, string> {
  const source = input ?? process.env;
  const snapshot: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }

  return snapshot;
}

function stripAmbientCodexSessionEnv(input: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith("CODEX_") && !PRESERVED_CODEX_ENV_VARS.has(key)) {
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function seedFileIfChanged(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) {
    return;
  }

  const sourceStat = statSync(sourcePath);
  const targetStat = existsSync(targetPath) ? statSync(targetPath) : null;

  if (!targetStat || sourceStat.mtimeMs > targetStat.mtimeMs || sourceStat.size !== targetStat.size) {
    copyFileSync(sourcePath, targetPath);
  }
}

function ensureIsolatedCodexHome(options: CodexIsolationOptions = {}): string {
  const isolatedCodexHome = options.isolatedCodexHome ?? defaultIsolatedCodexHome();
  const sourceCodexHome = options.sourceCodexHome
    ?? process.env.CODEX_HOME
    ?? path.join(os.homedir(), ".codex");

  mkdirSync(isolatedCodexHome, { recursive: true });

  if (path.resolve(sourceCodexHome) !== path.resolve(isolatedCodexHome)) {
    seedFileIfChanged(
      path.join(sourceCodexHome, "auth.json"),
      path.join(isolatedCodexHome, "auth.json"),
    );
  }

  // Keep the isolated home intentionally blank so spawned Codex workers only see
  // config we provide explicitly through the SDK.
  writeFileSync(path.join(isolatedCodexHome, "config.toml"), "", "utf8");

  return isolatedCodexHome;
}

export function prepareCodexCliEnvironment(
  input?: Record<string, string>,
  options: CodexIsolationOptions = {},
): Record<string, string> {
  const snapshot = buildAmbientEnvSnapshot(input);
  const sanitized = stripAmbientCodexSessionEnv(snapshot);
  sanitized.CODEX_HOME = ensureIsolatedCodexHome(options);
  return sanitized;
}

function withIsolatedDefaults(options: CodexOptions): CodexOptions {
  return {
    ...options,
    env: prepareCodexCliEnvironment(options.env as Record<string, string> | undefined),
    config: {
      ...(options.config ?? {}),
      mcp_servers: {},
    } as unknown as CodexOptions["config"],
  };
}

// ─── Model name remapping ───────────────────────────────────────────────────
// OS mode prompts may hardcode Claude model names (e.g. "haiku", "claude-sonnet-4-6").
// When running through the Codex SDK (OpenAI), remap them to valid model names.

const CLAUDE_MODEL_REMAP: Record<string, string> = {
  "haiku": "gpt-5.2",
  "claude-haiku-4-5-20251001": "gpt-5.2",
  "claude-sonnet-4-6": "gpt-5.3-codex",
  "sonnet": "gpt-5.3-codex",
  "claude-opus-4-6": "gpt-5.3-codex",
  "opus": "gpt-5.3-codex",
};

function remapModelForCodex(model: string | undefined): string | undefined {
  if (!model) return model;
  return CLAUDE_MODEL_REMAP[model] ?? model;
}

// ─── Sandbox mode mapping ────────────────────────────────────────────────────

function mapThreadOptions(options: Omit<ExtendedBrainThreadOptions, "mcpServers">): ThreadOptions {
  const mapped: ThreadOptions = {};
  if (options.model) mapped.model = remapModelForCodex(options.model);
  if (options.workingDirectory) mapped.workingDirectory = options.workingDirectory;
  // Product templates often start from fresh folders outside git.
  // Default to skipping the Codex CLI repo trust gate unless explicitly overridden.
  mapped.skipGitRepoCheck = options.skipGitRepoCheck ?? true;
  if (options.additionalDirectories) mapped.additionalDirectories = options.additionalDirectories;
  if (options.modelReasoningEffort) mapped.modelReasoningEffort = options.modelReasoningEffort;

  const sandbox = options.sandboxMode as string | undefined;
  if (sandbox === "orchestrator-read-only") {
    mapped.sandboxMode = "read-only";
  } else if (sandbox === "danger-full-access" || sandbox === "workspace-write" || sandbox === "read-only") {
    mapped.sandboxMode = sandbox;
  }

  return mapped;
}

// ─── Thread wrapper ──────────────────────────────────────────────────────────

import type { Thread } from "@openai/codex-sdk";

export class CodexBrainThread implements BrainThread {
  private readonly thread: Thread;

  constructor(thread: Thread) {
    this.thread = thread;
  }

  get id(): string | null {
    return this.thread.id;
  }

  async run(
    input: string,
    turnOptions?: { outputSchema?: unknown; agentLogPath?: string; onStreamEvent?: StreamEventCallback },
  ): Promise<TurnResult> {
    const sdkOpts = turnOptions?.outputSchema !== undefined
      ? { outputSchema: strictifySchema(turnOptions.outputSchema) }
      : undefined;

    if (turnOptions?.onStreamEvent) {
      return this.runWithStreaming(input, sdkOpts, turnOptions.onStreamEvent);
    }

    const turn = await this.thread.run(input, sdkOpts);
    return {
      finalResponse: turn.finalResponse,
      usage: turn.usage ? normalizeUsage(turn.usage) : undefined,
    };
  }

  private async runWithStreaming(
    input: string,
    sdkOpts: { outputSchema?: unknown } | undefined,
    onStream: StreamEventCallback,
  ): Promise<TurnResult> {
    const { events } = await this.thread.runStreamed(input, sdkOpts);

    let finalResponse = "";
    let usage: StreamEventUsage | undefined;
    const toolState = new Map<string, { toolName: string; argumentsSummary?: import("../types.js").StreamEventValue }>();

    for await (const event of events) {
      switch (event.type) {
        case "item.started":
        case "item.updated":
          if (event.item.type === "agent_message") {
            onStream({ type: "text_delta", text: event.item.text });
          } else if (event.item.type === "mcp_tool_call" && event.item.status === "in_progress") {
            const toolName = `${event.item.server}:${event.item.tool}`;
            const argumentsSummary = summarizeToolValue(event.item.arguments);
            toolState.set(event.item.id, { toolName, argumentsSummary });

            if (event.type === "item.started") {
              onStream({
                type: "tool_started",
                provider: "codex",
                toolName,
                toolUseId: event.item.id,
                argumentsSummary,
              });
            } else {
              onStream({
                type: "tool_progress",
                provider: "codex",
                toolName,
                toolUseId: event.item.id,
                argumentsSummary,
                elapsedSeconds: 0,
              });
            }
          }
          break;

        case "item.completed":
          if (event.item.type === "agent_message") {
            finalResponse = event.item.text;
          } else if (event.item.type === "mcp_tool_call") {
            const prior = toolState.get(event.item.id);
            const toolName = prior?.toolName ?? `${event.item.server}:${event.item.tool}`;
            const argumentsSummary = prior?.argumentsSummary ?? summarizeToolValue(event.item.arguments);

            if (event.item.status === "completed") {
              onStream({
                type: "tool_completed",
                provider: "codex",
                toolName,
                toolUseId: event.item.id,
                argumentsSummary,
                resultSummary: summarizeToolValue(event.item.result),
              });
            } else if (event.item.status === "failed") {
              onStream({
                type: "tool_failed",
                provider: "codex",
                toolName,
                toolUseId: event.item.id,
                argumentsSummary,
                error: summarizeToolError(event.item.error),
                resultSummary: summarizeToolValue(event.item.error),
              });
            }
          }
          break;

        case "turn.completed":
          usage = normalizeUsage(event.usage);
          onStream({ type: "usage", usage });
          break;

        case "turn.failed":
          throw new Error(`codex turn failed: ${event.error.message}`);

        case "error":
          throw new Error(`codex stream error: ${event.message}`);
      }
    }

    return { finalResponse, usage };
  }
}

// ─── Client wrapper ──────────────────────────────────────────────────────────

export class CodexBrain implements Brain {
  private readonly defaultCodex: Codex;
  private browserCodex: Codex | null = null;
  private readonly baseOptions: CodexOptions;
  private readonly browserMcpServers: Record<string, McpServerConfig> | null;

  constructor(options: CodexOptions, browserMcpServers?: Record<string, McpServerConfig>) {
    this.baseOptions = withIsolatedDefaults(options);
    this.defaultCodex = new Codex(this.baseOptions);
    this.browserMcpServers = browserMcpServers ?? null;
  }

  startThread(options: ExtendedBrainThreadOptions = {}): BrainThread {
    const { mcpServers, ...rest } = options;
    const mapped = mapThreadOptions(rest);

    const hasMcp = mcpServers && Object.keys(mcpServers).length > 0;
    const codex = hasMcp ? this.getOrCreateBrowserCodex() : this.defaultCodex;
    return new CodexBrainThread(codex.startThread(mapped));
  }

  /** Resume a thread by ID. Not yet part of Brain but exposed for future use. */
  resumeThread(id: string, options: ExtendedBrainThreadOptions = {}): BrainThread {
    const { mcpServers, ...rest } = options;
    const mapped = mapThreadOptions(rest);

    const hasMcp = mcpServers && Object.keys(mcpServers).length > 0;
    const codex = hasMcp ? this.getOrCreateBrowserCodex() : this.defaultCodex;
    return new CodexBrainThread(codex.resumeThread(id, mapped));
  }

  private getOrCreateBrowserCodex(): Codex {
    if (this.browserCodex) return this.browserCodex;

    if (!this.browserMcpServers) {
      // No browser MCP configured at construction — fall back to default
      return this.defaultCodex;
    }

    const mcpConfig: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(this.browserMcpServers)) {
      mcpConfig[name] = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      };
    }

    // CodexConfigObject is not exported; cast through unknown to satisfy the recursive type
    this.browserCodex = new Codex({
      ...this.baseOptions,
      config: {
        ...this.baseOptions.config,
        mcp_servers: mcpConfig,
      } as unknown as CodexOptions["config"],
    });

    return this.browserCodex;
  }
}
