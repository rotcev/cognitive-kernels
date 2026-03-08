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
import { ScopedMemoryStore } from "./scoped-memory-store.js";
import { runKernel, stateToSnapshot } from "./run-kernel.js";
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

  // Initialize memory store (mirrors what OsKernel constructor does)
  const memoryStore = new ScopedMemoryStore(osConfig.memory, input.cwd);
  memoryStore.loadHeuristics();
  memoryStore.loadBlueprints();

  // Check for episodic data and build consolidator objective
  const hasNewEpisodicData = memoryStore.hasNewEpisodicData();
  const consolidatorObjective = hasNewEpisodicData
    ? buildConsolidatorObjective(memoryStore, osConfig.memory.basePath)
    : undefined;

  // Crash handlers — ensure unhandled errors are captured in the protocol before the process dies
  const emitCrash = (label: string, err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error(`[kernel:${label}] ${msg}`);
    emitter?.emit({
      action: "os_error",
      status: "failed",
      message: `${label}: ${msg}`,
    });
  };

  process.on("uncaughtException", (err) => {
    // EPIPE is benign — the parent closed stdout/stderr before we finished writing.
    // Don't crash the kernel for this.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EPIPE") return;
    emitCrash("uncaughtException", err);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    emitCrash("unhandledRejection", reason);
    process.exit(1);
  });

  try {
    const finalState = await runKernel(input.goal, osConfig, client, emitter ?? null, {
      workingDir: input.cwd,
      memoryStore,
      hasNewEpisodicData,
      consolidatorObjective,
      awarenessModel: osConfig.awareness?.model,
    });

    const snapshot = stateToSnapshot(finalState);

    // Persist final snapshot and close emitter (mirrors old kernel.run() shutdown)
    emitter?.saveSnapshot(snapshot);
    await emitter?.close();

    return snapshot;
  } catch (err) {
    emitCrash("kernel.run", err);
    throw err;
  }
}

/**
 * Build a rich objective for the memory-consolidator daemon.
 * Standalone version of OsKernel.buildConsolidatorObjective() —
 * injects the full heuristic inventory so the LLM can reason about
 * duplicates, contradictions, gaps, and patterns worth extracting.
 */
function buildConsolidatorObjective(memoryStore: ScopedMemoryStore, basePath: string): string {
  const allHeuristics = memoryStore.getAll();
  const lines: string[] = [
    "You are the memory consolidator — responsible for the quality and coherence",
    "of this system's learned knowledge. The heuristics below are what the cognitive",
    "kernel has learned across runs. Your job is to review them and improve the store.",
    "",
    "## Current Heuristics",
  ];

  if (allHeuristics.length === 0) {
    lines.push("(none yet — the system is fresh)");
  } else {
    for (const h of allHeuristics) {
      const scopeLabel = h.scope ? ` scope=${h.scope}` : "";
      const superseded = h.supersededBy ? ` SUPERSEDED by ${h.supersededBy}` : "";
      lines.push(
        `- [id=${h.id}, conf=${h.confidence.toFixed(2)}, reinforced=${h.reinforcementCount}x${scopeLabel}${superseded}] ${h.heuristic}`,
        `  context: ${h.context}`,
      );
    }
  }

  lines.push(
    "",
    "## Your Tasks",
    "",
    "Review the heuristics above and take any of these actions using OS commands:",
    "",
    "### 1. Merge duplicates",
    "If two or more heuristics express the same insight in different words,",
    "use `learn` to create a single cleaner version, then `supersede` the old ones.",
    "The merged heuristic should have confidence = max of the originals.",
    "",
    "### 2. Flag contradictions",
    "If two heuristics give opposing advice for the same context, report the",
    "contradiction via `bb_write` key \"consolidation:contradictions\" so the",
    "metacog can evaluate which is correct. Do not resolve contradictions yourself",
    "— the system needs runtime evidence to determine which is right.",
    "",
    "### 3. Extract missing patterns",
    `Read the DAG snapshots at \`${basePath}/snapshots/\``,
    "using your file tools. Look for recurring topology patterns (process types,",
    "coordination sequences, failure modes) that are NOT yet captured as heuristics.",
    "Use `learn` to codify any patterns you find, with confidence 0.5 (tentative).",
    "",
    "### 4. Sharpen vague heuristics",
    "If a heuristic is too vague to be actionable (e.g. \"be careful with dependencies\"),",
    "either make it specific via `learn` + `supersede`, or flag it for removal.",
    "",
    "## Output",
    "After completing your review, write a summary to the blackboard:",
    "`bb_write` key \"consolidation:report\" with: merges performed, contradictions found,",
    "patterns extracted, heuristics sharpened. Then go idle.",
    "",
    "## Constraints",
    "- Do NOT invent heuristics from general knowledge — only from evidence in the",
    "  snapshot data or from patterns visible in the existing heuristic set.",
    "- Preserve high-confidence, well-reinforced heuristics. Focus your energy on",
    "  the low-confidence, low-reinforcement entries and obvious redundancies.",
    "- This is a single pass — do your best work, write the report, then idle.",
  );

  return lines.join("\n");
}
