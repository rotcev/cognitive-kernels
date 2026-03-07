import { readFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseToml } from "smol-toml";
import { parseOsConfig } from "./config.js";
import { OsKernel } from "./kernel.js";
import { OsProtocolEmitter } from "./protocol-emitter.js";
import { createBrain } from "../brain/create-brain.js";
import { createDbConnection } from "../db/connection.js";
import { NeonStorageBackend } from "../db/storage-backend.js";
import type { OsSystemSnapshot } from "./types.js";
import type { BrainRuntimeConfig } from "../types.js";

loadDotenv();

export type OsModeInput = {
  goal: string;
  configPath?: string;
  protocolLogPath?: string;
  cwd: string;
  provider?: "claude" | "codex";
  runId?: string;
};

export async function runOsMode(input: OsModeInput): Promise<OsSystemSnapshot> {
  // Load OS config from TOML if provided, otherwise use defaults
  let osConfigRaw: unknown = {};
  let parsedToml: Record<string, unknown> = {};

  if (input.configPath) {
    const fullPath = path.resolve(input.cwd, input.configPath);
    const content = await readFile(fullPath, "utf8");
    parsedToml = parseToml(content) as Record<string, unknown>;
    osConfigRaw = parsedToml.os ?? {};
  }

  const osConfig = parseOsConfig(osConfigRaw);

  // Provider priority: explicit input > TOML [codex] section > default "claude"
  const codexSection = parsedToml.codex as Record<string, unknown> | undefined;
  const provider: "codex" | "claude" = input.provider
    ?? (codexSection?.provider === "codex" ? "codex" : "claude");

  // When using Codex SDK, default all model fields to gpt-5.3-codex unless explicitly set in TOML
  if (provider === "codex") {
    const osRaw = (osConfigRaw ?? {}) as Record<string, unknown>;
    const kernelRaw = (osRaw.kernel ?? {}) as Record<string, unknown>;
    const awarenessRaw = (osRaw.awareness ?? {}) as Record<string, unknown>;
    const ephemeralRaw = (osRaw.ephemeral ?? {}) as Record<string, unknown>;
    const observationRaw = (osRaw.observation ?? {}) as Record<string, unknown>;
    const codexDefault = "gpt-5.3-codex";

    if (!kernelRaw.metacogModel) osConfig.kernel.metacogModel = codexDefault;
    if (!kernelRaw.processModel) osConfig.kernel.processModel = codexDefault;
    if (!awarenessRaw.model) osConfig.awareness.model = codexDefault;
    if (!ephemeralRaw.defaultModel) osConfig.ephemeral.defaultModel = codexDefault;
    if (!observationRaw.defaultModel) osConfig.observation.defaultModel = codexDefault;
  }

  const brainConfig: BrainRuntimeConfig = {
    provider,
    baseUrl: codexSection?.baseUrl as string | undefined,
    apiKey: codexSection?.apiKey as string | undefined,
    env: (codexSection?.env as Record<string, string>) ?? {},
    config: (codexSection?.config as Record<string, unknown>) ?? {},
  };

  // Browser MCP config is passed per-thread to observer processes (not injected globally).
  // This keeps MCP access scoped to processes that need it and keeps the
  // Brain abstraction portable across Claude and Codex/OpenAI backends.
  const browserMcpConfig = osConfig.observation.enabled
    ? {
        command: osConfig.observation.browserMcp.command,
        args: osConfig.observation.browserMcp.args,
        ...(osConfig.observation.browserMcp.env && { env: osConfig.observation.browserMcp.env }),
      }
    : undefined;

  // Build browser MCP map for the Codex SDK two-instance routing.
  // Claude provider handles per-thread MCP natively; Codex SDK needs it at construction time.
  const browserMcpMap = browserMcpConfig
    ? { "concurrent-browser": browserMcpConfig }
    : undefined;

  const client = createBrain(brainConfig, browserMcpMap);

  let emitter: OsProtocolEmitter | undefined;

  if (input.protocolLogPath && process.env.DATABASE_URL) {
    // Dual-write: filesystem + DB
    const db = createDbConnection(process.env.DATABASE_URL);
    const backend = new NeonStorageBackend(db);
    await backend.connect();
    const snapshotPath = path.join(path.dirname(input.protocolLogPath), "os-snapshot.json");
    const livePath = path.join(path.dirname(input.protocolLogPath), "os-live.json");
    emitter = new OsProtocolEmitter({
      protocolLogPath: input.protocolLogPath,
      snapshotPath,
      livePath,
      storageBackend: backend,
    });
  } else if (input.protocolLogPath) {
    // Filesystem only
    const snapshotPath = path.join(path.dirname(input.protocolLogPath), "os-snapshot.json");
    const livePath = path.join(path.dirname(input.protocolLogPath), "os-live.json");
    emitter = new OsProtocolEmitter({
      protocolLogPath: input.protocolLogPath,
      snapshotPath,
      livePath,
    });
  } else if (process.env.DATABASE_URL && input.runId) {
    // DB-only mode
    const db = createDbConnection(process.env.DATABASE_URL);
    const backend = new NeonStorageBackend(db);
    await backend.connect();
    emitter = new OsProtocolEmitter({
      storageBackend: backend,
      runId: input.runId,
    });
  }

  const kernel = new OsKernel(osConfig, client, input.cwd, emitter, browserMcpConfig);

  return kernel.run(input.goal);
}
