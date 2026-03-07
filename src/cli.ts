import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { runOsMode } from "./os/entry.js";
import { KernelRunManager } from "./runs/run-manager.js";
import { createRunsApiServer } from "./api/server.js";
import { createDbConnection } from "./db/connection.js";
import { NeonStorageBackend } from "./db/storage-backend.js";
import type { BrainProvider } from "./types.js";

loadDotenv();

type ParsedArgs = {
  command?: string;
  flags: Map<string, string | boolean>;
};

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.command || parsed.flags.has("--help")) {
    printUsage();
    process.exit(parsed.command ? 0 : 1);
  }

  switch (parsed.command) {
    case "os":
      await handleOsCommand(parsed.flags);
      return;
    case "serve":
      await handleServeCommand(parsed.flags);
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

async function handleOsCommand(flags: Map<string, string | boolean>): Promise<void> {
  const goal = readStringFlag(flags, "--goal");
  if (!goal) {
    throw new Error("--goal is required");
  }

  const cwd = path.resolve(readStringFlag(flags, "--cwd") ?? process.cwd());
  const configPath = readStringFlag(flags, "--config");
  const protocolLogPathRaw = readStringFlag(flags, "--protocol-log");
  const outPathRaw = readStringFlag(flags, "--out");
  const provider = readProvider(flags);
  const json = flags.get("--json") === true;

  const protocolLogPath = protocolLogPathRaw ? path.resolve(cwd, protocolLogPathRaw) : undefined;
  const outPath = outPathRaw ? path.resolve(cwd, outPathRaw) : undefined;
  const runId = readStringFlag(flags, "--run-id");

  const snapshot = await runOsMode({
    goal,
    configPath,
    protocolLogPath,
    cwd,
    provider,
    runId,
  });

  const serialized = JSON.stringify(snapshot, null, 2);

  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${serialized}\n`, "utf8");
  }

  if (json) {
    process.stdout.write(`${serialized}\n`);
    return;
  }

  process.stdout.write(
    [
      `Run ${snapshot.runId.slice(0, 8)} completed`,
      `Goal: ${snapshot.goal}`,
      `Processes: ${snapshot.processes.length}`,
      `Ticks: ${snapshot.tickCount}`,
      `Tokens: ${snapshot.progressMetrics.totalTokensUsed}`,
    ].join("\n") + "\n",
  );
}

async function handleServeCommand(flags: Map<string, string | boolean>): Promise<void> {
  const cwd = path.resolve(readStringFlag(flags, "--cwd") ?? process.cwd());
  const configPath = readStringFlag(flags, "--config");
  const host = readStringFlag(flags, "--host") ?? "127.0.0.1";
  const port = Number(readStringFlag(flags, "--port") ?? "3100");

  let storageBackend: NeonStorageBackend | undefined;
  if (process.env.DATABASE_URL) {
    const db = createDbConnection(process.env.DATABASE_URL);
    storageBackend = new NeonStorageBackend(db);
    await storageBackend.connect();
    await storageBackend.loadRuns();
    process.stderr.write(`Neon storage backend connected\n`);
  }

  const runManager = new KernelRunManager({ storageBackend });
  await runManager.initialize();

  const server = await createRunsApiServer({
    runManager,
    defaultCwd: cwd,
    defaultConfigPath: configPath,
    host,
    port,
  });

  process.stderr.write(`cognitive-kernels API listening on ${server.baseUrl}\n`);

  // Keep alive until SIGINT/SIGTERM
  const shutdown = async () => {
    process.stderr.write("\nShutting down...\n");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!command && !token.startsWith("-")) {
      command = token;
      continue;
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    if (token === "--json" || token === "--help") {
      flags.set(token, true);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Expected a value after ${token}`);
    }

    flags.set(token, value);
    index += 1;
  }

  return { command, flags };
}

function readStringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function readProvider(flags: Map<string, string | boolean>): BrainProvider | undefined {
  const provider = readStringFlag(flags, "--provider");
  if (!provider) {
    return undefined;
  }
  if (provider !== "claude" && provider !== "codex") {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return provider;
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  cognitive-kernels os --goal <text> [--config <path>] [--cwd <path>] [--provider claude|codex] [--protocol-log <path>] [--out <path>] [--run-id <id>] [--json]",
      "  cognitive-kernels serve [--port <number>] [--host <address>] [--cwd <path>] [--config <path>]",
    ].join("\n") + "\n",
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
