import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WriteStream } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type {
  Brain,
  BrainRuntimeConfig,
  BrainThread,
  ExtendedBrainThreadOptions,
  TurnResult,
  StreamEventCallback,
  StreamEventUsage,
} from "../types.js";
import {
  isLikelyToolFailure,
  summarizeToolError,
  summarizeToolValue,
} from "./tool-event-utils.js";

type ClaudeToolState = {
  toolName: string;
  argumentsSummary?: import("../types.js").StreamEventValue;
};

function extractClaudeToolUses(message: unknown): Array<{ toolUseId: string; toolName: string; argumentsSummary?: import("../types.js").StreamEventValue }> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return [];
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const results: Array<{ toolUseId: string; toolName: string; argumentsSummary?: import("../types.js").StreamEventValue }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }

    const toolBlock = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (toolBlock.type !== "tool_use" || typeof toolBlock.id !== "string" || typeof toolBlock.name !== "string") {
      continue;
    }

    results.push({
      toolUseId: toolBlock.id,
      toolName: toolBlock.name,
      argumentsSummary: summarizeToolValue(toolBlock.input),
    });
  }

  return results;
}

function extractClaudeToolResult(message: unknown, fallback: unknown): {
  resultSummary?: import("../types.js").StreamEventValue;
  failed: boolean;
  error?: string;
} {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          continue;
        }

        const toolResultBlock = block as { type?: unknown; is_error?: unknown; content?: unknown };
        if (toolResultBlock.type !== "tool_result") {
          continue;
        }

        const failed = toolResultBlock.is_error === true || isLikelyToolFailure(toolResultBlock.content);
        return {
          failed,
          error: failed ? summarizeToolError(toolResultBlock.content) : undefined,
          resultSummary: summarizeToolValue(toolResultBlock.content),
        };
      }
    }
  }

  const failed = isLikelyToolFailure(fallback);
  return {
    failed,
    error: failed ? summarizeToolError(fallback) : undefined,
    resultSummary: summarizeToolValue(fallback),
  };
}

// ─── Mappings ─────────────────────────────────────────────────────────────────

function sandboxToPermissionMode(mode?: string): Options["permissionMode"] | null {
  switch (mode) {
    case "danger-full-access":
      return "bypassPermissions";
    case "workspace-write":
      return "dontAsk";
    default:
      return null;
  }
}

function effortMapping(effort?: string): Options["effort"] | undefined {
  switch (effort) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "high"; // "max" is not available for Claude.ai subscribers
    default:
      return undefined;
  }
}

function buildMcpServers(codexConfig: Record<string, unknown>): Record<string, McpStdioServerConfig> | undefined {
  const servers = codexConfig["mcp_servers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return undefined;
  }

  const result: Record<string, McpStdioServerConfig> = {};
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    if (!server || typeof server !== "object" || Array.isArray(server)) continue;
    const s = server as Record<string, unknown>;
    const entry: McpStdioServerConfig = { command: s["command"] as string };
    if (Array.isArray(s["args"])) entry.args = s["args"] as string[];
    if (s["env"] && typeof s["env"] === "object") entry.env = s["env"] as Record<string, string>;
    result[name] = entry;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function buildEnv(runtimeConfig: BrainRuntimeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "CLAUDECODE" && value !== undefined) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(runtimeConfig.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (runtimeConfig.apiKey) {
    env.ANTHROPIC_API_KEY = runtimeConfig.apiKey;
  }
  return env;
}

function openLogStream(logPath: string): WriteStream | null {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    return createWriteStream(logPath, { flags: "a" });
  } catch {
    return null;
  }
}

// ─── Public classes ───────────────────────────────────────────────────────────

/**
 * A single conversation thread backed by the Claude Agent SDK.
 * Maintains session ID across multiple `run()` calls to support multi-turn conversations.
 */
export class ClaudeBrainThread implements BrainThread {
  private _id: string | null = null;

  constructor(
    private readonly options: ExtendedBrainThreadOptions,
    private readonly runtimeConfig: BrainRuntimeConfig
  ) {}

  get id(): string | null {
    return this._id;
  }

  async run(input: string, turnOptions?: { outputSchema?: unknown; agentLogPath?: string; onStreamEvent?: StreamEventCallback }): Promise<TurnResult> {
    const logPath = turnOptions?.agentLogPath;
    const log = logPath ? openLogStream(logPath) : null;
    const ts = () => new Date().toISOString();
    const onStream = turnOptions?.onStreamEvent;

    const sdkOptions: Options = {
      cwd: this.options.workingDirectory,
      model: this.options.model,
      additionalDirectories: this.options.additionalDirectories,
      env: buildEnv(this.runtimeConfig),
      ...(this._id ? { resume: this._id } : {}),
      ...(onStream ? { includePartialMessages: true } : {})
    };

    const permMode = sandboxToPermissionMode(this.options.sandboxMode);
    if (permMode) {
      sdkOptions.permissionMode = permMode;
      if (this.options.sandboxMode === "danger-full-access") {
        sdkOptions.allowDangerouslySkipPermissions = true;
      }
    } else if (this.options.sandboxMode === "read-only") {
      sdkOptions.tools = ["Read", "Glob", "Grep"];
    } else if ((this.options.sandboxMode as string) === "orchestrator-read-only") {
      // Orchestrator has no native tools — it designs topology via structured output only.
      // Scout ephemerals (Haiku) handle information gathering.
      sdkOptions.tools = [];
    }

    const effort = effortMapping(this.options.modelReasoningEffort);
    if (effort !== undefined) {
      sdkOptions.effort = effort;
    }

    if (turnOptions?.outputSchema !== undefined) {
      sdkOptions.outputFormat = {
        type: "json_schema",
        schema: turnOptions.outputSchema as Record<string, unknown>
      };
    }

    // Merge global MCP servers (from config) with per-thread MCP servers.
    // Per-thread servers override global ones with the same name.
    const globalMcp = buildMcpServers(this.runtimeConfig.config);
    const threadMcp = this.options.mcpServers as Record<string, McpStdioServerConfig> | undefined;
    const mergedMcp = { ...globalMcp, ...threadMcp };
    if (Object.keys(mergedMcp).length > 0) {
      sdkOptions.mcpServers = mergedMcp;
    }

    if (log) {
      sdkOptions.stderr = (data: string) => {
        log.write(`${ts()} [stderr] ${data}`);
      };
    }

    const generator = query({ prompt: input, options: sdkOptions });

    let lastResult: {
      result: string;
      structured_output?: unknown;
      session_id: string;
      usage?: StreamEventUsage;
    } | null = null;
    let isError = false;
    let errorMessage = "";
    const toolState = new Map<string, ClaudeToolState>();

    try {
      for await (const message of generator) {
        if (log) {
          log.write(`${ts()} ${JSON.stringify(message)}\n`);
        }

        // Emit streaming events when callback is provided
        if (onStream) {
          if (message.type === "assistant") {
            for (const toolUse of extractClaudeToolUses(message.message)) {
              toolState.set(toolUse.toolUseId, {
                toolName: toolUse.toolName,
                argumentsSummary: toolUse.argumentsSummary,
              });
              onStream({
                type: "tool_started",
                provider: "claude",
                toolName: toolUse.toolName,
                toolUseId: toolUse.toolUseId,
                argumentsSummary: toolUse.argumentsSummary,
              });
            }
          } else if (message.type === "stream_event") {
            const evt = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
            if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
              onStream({ type: "text_delta", text: evt.delta.text });
            }
          } else if (message.type === "user" && message.parent_tool_use_id && message.tool_use_result !== undefined) {
            const prior = toolState.get(message.parent_tool_use_id);
            const toolName = prior?.toolName ?? "claude:unknown_tool";
            const result = extractClaudeToolResult(message.message, message.tool_use_result);
            if (result.failed) {
              onStream({
                type: "tool_failed",
                provider: "claude",
                toolName,
                toolUseId: message.parent_tool_use_id,
                argumentsSummary: prior?.argumentsSummary,
                resultSummary: result.resultSummary,
                error: result.error ?? "unknown tool error",
              });
            } else {
              onStream({
                type: "tool_completed",
                provider: "claude",
                toolName,
                toolUseId: message.parent_tool_use_id,
                argumentsSummary: prior?.argumentsSummary,
                resultSummary: result.resultSummary,
              });
            }
          } else if (message.type === "tool_progress") {
            const tp = message as { tool_name: string; tool_use_id: string; elapsed_time_seconds: number };
            const prior = toolState.get(tp.tool_use_id);
            if (!prior) {
              toolState.set(tp.tool_use_id, { toolName: tp.tool_name });
              onStream({
                type: "tool_started",
                provider: "claude",
                toolName: tp.tool_name,
                toolUseId: tp.tool_use_id,
              });
            }
            onStream({
              type: "tool_progress",
              provider: "claude",
              toolName: prior?.toolName ?? tp.tool_name,
              toolUseId: tp.tool_use_id,
              argumentsSummary: prior?.argumentsSummary,
              elapsedSeconds: tp.elapsed_time_seconds,
            });
          } else if (message.type === "system") {
            const sys = message as { subtype: string; status?: string; task_id?: string; description?: string; summary?: string };
            if (sys.subtype === "status" && sys.status) {
              onStream({ type: "status", status: sys.status });
            } else if (sys.subtype === "task_started" && sys.task_id) {
              onStream({ type: "task_started", taskId: sys.task_id, description: sys.description ?? "" });
            } else if (sys.subtype === "task_notification" && sys.task_id) {
              const tn = message as { status: string; summary: string };
              onStream({ type: "task_completed", taskId: sys.task_id, status: tn.status, summary: tn.summary });
            }
          }
        }

        if (message.type === "result") {
          if (message.is_error) {
            isError = true;
            errorMessage = (message as { errors?: string[] }).errors?.join("; ") ?? "unknown error";
          } else {
            const success = message as {
              result: string;
              structured_output?: unknown;
              session_id: string;
              total_cost_usd?: number;
              duration_ms?: number;
              num_turns?: number;
              usage?: { input_tokens?: number; output_tokens?: number };
            };

            const usageData: StreamEventUsage | undefined =
              success.usage
                ? {
                    inputTokens: success.usage.input_tokens ?? 0,
                    outputTokens: success.usage.output_tokens ?? 0,
                    totalCostUsd: success.total_cost_usd ?? 0,
                    durationMs: success.duration_ms ?? 0,
                    numTurns: success.num_turns ?? 0,
                  }
                : undefined;

            lastResult = {
              result: success.result,
              structured_output: success.structured_output,
              session_id: success.session_id,
              usage: usageData,
            };

            if (onStream && usageData) {
              onStream({ type: "usage", usage: usageData });
            }
          }
          if (message.session_id) this._id = message.session_id;
        }
      }
    } finally {
      log?.end();
    }

    if (isError) {
      throw new Error(`claude agent error: ${errorMessage}`);
    }

    if (!lastResult) {
      throw new Error("claude agent produced no result message");
    }

    const finalResponse = lastResult.structured_output !== undefined
      ? JSON.stringify(lastResult.structured_output)
      : lastResult.result;

    return { finalResponse, usage: lastResult.usage };
  }
}

/**
 * Factory for creating Claude Code conversation threads using the Agent SDK.
 */
export class ClaudeBrain implements Brain {
  constructor(private readonly runtimeConfig: BrainRuntimeConfig) {}

  startThread(options: ExtendedBrainThreadOptions = {}): BrainThread {
    return new ClaudeBrainThread(options, this.runtimeConfig);
  }
}
