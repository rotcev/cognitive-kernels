import { randomUUID } from "node:crypto";
import { spawn as defaultSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  KernelRun,
  KernelRunArtifacts,
  KernelRunInput,
  KernelRunLogChunk,
  KernelRunLogLine,
  KernelRunLogStream,
  KernelRunStatus,
  RuntimeProtocolEvent,
} from "../types.js";
import type { OsSystemSnapshot } from "../os/types.js";

type SpawnFn = typeof defaultSpawn;

export type KernelRunStorageBackend = {
  isConnected(): boolean;
  saveRun?(run: KernelRun): Promise<void> | void;
  listRuns?(): KernelRun[] | Promise<KernelRun[]>;
  getRun?(id: string): KernelRun | Promise<KernelRun | undefined> | undefined;
  getRunEvents?(
    id: string,
    options?: ReadRunEventsOptions,
  ): RuntimeProtocolEvent[] | Promise<RuntimeProtocolEvent[]>;
  getRunState?(id: string): KernelRunState | Promise<KernelRunState>;
};

type KernelRunRecord = {
  run: KernelRun;
  child: ChildProcess | null;
};

export type KernelRunManagerOptions = {
  runsRoot?: string;
  scriptPath?: string;
  nodePath?: string;
  spawnFn?: SpawnFn;
  scriptPathExistsFn?: (filePath: string) => boolean;
  now?: () => Date;
  storageBackend?: KernelRunStorageBackend;
};

export type ReadRunEventsOptions = {
  limit?: number;
};

export type ReadRunLogOptions = {
  stream: KernelRunLogStream;
  limit?: number;
  afterLine?: number;
};

export type KernelRunState = {
  snapshot: OsSystemSnapshot | null;
  source: "live" | "final" | "missing";
};

export class KernelRunManager {
  private readonly runsRoot: string;
  private readonly scriptPath: string;
  private readonly nodePath: string;
  private readonly spawnFn: SpawnFn;
  private readonly scriptPathExistsFn: (filePath: string) => boolean;
  private readonly now: () => Date;
  private readonly storageBackend?: KernelRunStorageBackend;
  private readonly records = new Map<string, KernelRunRecord>();

  constructor(options: KernelRunManagerOptions = {}) {
    this.runsRoot = options.runsRoot ?? path.join(os.homedir(), ".cognitive-kernels", "runs");
    this.scriptPath = options.scriptPath ?? resolveDefaultCliScriptPath();
    this.nodePath = options.nodePath ?? process.execPath;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.scriptPathExistsFn = options.scriptPathExistsFn ?? existsSync;
    this.now = options.now ?? (() => new Date());
    this.storageBackend = options.storageBackend;
  }

  async initialize(): Promise<void> {
    await mkdir(this.runsRoot, { recursive: true });

    // Load from DB backend first (if available)
    if (this.storageBackend?.isConnected()) {
      const backendRuns = this.storageBackend.listRuns?.();
      if (Array.isArray(backendRuns)) {
        for (const run of backendRuns) {
          if (!this.records.has(run.id)) {
            this.records.set(run.id, { run, child: null });
          }
        }
      }
    }

    // Then load from filesystem (may add runs not in DB)
    await this.loadPersistedRuns();
    await this.reconcilePersistedRuns();
  }

  listRuns(): KernelRun[] {
    const backendRuns = this.readRunsFromBackend();
    const sourceRuns = backendRuns ?? [...this.records.values()].map((record) => record.run);

    return sourceRuns
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getRun(id: string): KernelRun | undefined {
    const exact = this.records.get(id)?.run;
    if (exact) return exact;

    const backendExact = this.readRunFromBackend(id);
    if (backendExact) {
      return backendExact;
    }

    if (id.length >= 4) {
      const matches: KernelRun[] = [];
      for (const [key, record] of this.records) {
        if (key.startsWith(id)) {
          matches.push(record.run);
        }
      }
      if (matches.length === 1) {
        return matches[0];
      }

      const backendRuns = this.readRunsFromBackend();
      if (backendRuns) {
        const backendMatches = backendRuns.filter((run) => run.id.startsWith(id));
        if (backendMatches.length === 1) {
          return backendMatches[0];
        }
      }
    }

    return undefined;
  }

  private readRunsFromBackend(): KernelRun[] | null {
    if (!this.storageBackend?.isConnected() || typeof this.storageBackend.listRuns !== "function") {
      return null;
    }

    try {
      const backendRuns = this.storageBackend.listRuns();
      if (Array.isArray(backendRuns)) {
        return backendRuns;
      }
    } catch {
      // Fallback to filesystem/in-memory records.
    }

    return null;
  }

  private readRunFromBackend(id: string): KernelRun | undefined {
    if (!this.storageBackend?.isConnected() || typeof this.storageBackend.getRun !== "function") {
      return undefined;
    }

    try {
      const run = this.storageBackend.getRun(id);
      if (run && !("then" in run)) {
        return run;
      }
    } catch {
      // Fallback to filesystem/in-memory records.
    }

    return undefined;
  }

  async startRun(input: KernelRunInput): Promise<KernelRun> {
    this.assertScriptPath();

    const id = randomUUID();
    const createdAt = this.timestamp();
    const dbOnly = this.storageBackend?.isConnected() === true;

    let artifacts: KernelRunArtifacts | undefined;
    if (!dbOnly) {
      const runDir = path.join(this.runsRoot, id);
      await mkdir(runDir, { recursive: true });
      artifacts = {
        runDir,
        runFilePath: path.join(runDir, "run.json"),
        outputPath: path.join(runDir, "output.json"),
        protocolLogPath: path.join(runDir, "protocol.ndjson"),
        livePath: path.join(runDir, "os-live.json"),
        snapshotPath: path.join(runDir, "os-snapshot.json"),
        stdoutPath: path.join(runDir, "stdout.log"),
        stderrPath: path.join(runDir, "stderr.log"),
      };
    }

    const { command, args, cwd } = this.buildCommand(input, id, artifacts);

    const run: KernelRun = {
      id,
      status: "queued",
      pid: null,
      createdAt,
      updatedAt: createdAt,
      command,
      args,
      input: {
        ...input,
        cwd,
        configPath: input.configPath ? path.resolve(cwd, input.configPath) : undefined,
      },
      artifacts,
    };

    const record: KernelRunRecord = { run, child: null };
    this.records.set(id, record);
    await this.persistRun(run);

    const child = this.spawnFn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    record.child = child;

    if (artifacts) {
      const stdoutStream = createWriteStream(artifacts.stdoutPath, { flags: "a" });
      const stderrStream = createWriteStream(artifacts.stderrPath, { flags: "a" });
      child.stdout?.pipe(stdoutStream);
      child.stderr?.pipe(stderrStream);

      child.on("exit", () => {
        stdoutStream.end();
        stderrStream.end();
      });
    }

    await this.transitionRun(id, {
      status: "running",
      pid: child.pid ?? null,
      startedAt: this.timestamp(),
    });

    child.on("error", (error) => {
      void this.transitionRun(id, {
        status: "failed",
        error: error.message,
        endedAt: this.timestamp(),
        exitCode: null,
        signal: null,
      });
    });

    child.on("exit", (code, signal) => {
      const current = this.records.get(id);
      if (!current) return;

      const wasCanceled = current.run.status === "canceled";
      const nextStatus: KernelRunStatus = wasCanceled
        ? "canceled"
        : code === 0
          ? "completed"
          : "failed";

      void this.transitionRun(id, {
        status: nextStatus,
        endedAt: this.timestamp(),
        exitCode: code,
        signal,
      });

      current.child = null;
    });

    return this.requireRecord(id).run;
  }

  async cancelRun(id: string): Promise<KernelRun> {
    const record = this.requireRecord(id);

    if (this.isTerminal(record.run.status)) {
      return record.run;
    }

    this.sendSignal(record, "SIGTERM");

    await this.transitionRun(id, {
      status: "canceled",
      endedAt: this.timestamp(),
    });

    return this.requireRecord(id).run;
  }

  async pauseRun(id: string): Promise<KernelRun> {
    const record = this.requireRecord(id);

    if (record.run.status !== "running") {
      throw new Error(`Run ${id} is not running`);
    }

    this.sendSignal(record, "SIGSTOP");
    await this.transitionRun(id, { status: "paused" });

    return this.requireRecord(id).run;
  }

  async resumeRun(id: string): Promise<KernelRun> {
    const record = this.requireRecord(id);

    if (record.run.status !== "paused") {
      throw new Error(`Run ${id} is not paused`);
    }

    this.sendSignal(record, "SIGCONT");
    await this.transitionRun(id, { status: "running" });

    return this.requireRecord(id).run;
  }

  async getRunEvents(id: string, options: ReadRunEventsOptions = {}): Promise<RuntimeProtocolEvent[]> {
    const run = this.requireRecord(id).run;
    const backendEvents = await this.readRunEventsFromBackend(id, options);
    if (backendEvents) {
      return backendEvents;
    }
    if (!run.artifacts?.protocolLogPath) return [];
    return readRunEvents(run.artifacts.protocolLogPath, options.limit ?? 200);
  }

  async getRunLog(id: string, options: ReadRunLogOptions): Promise<KernelRunLogChunk> {
    const run = this.requireRecord(id).run;
    const filePath = getRunLogPath(run, options.stream);
    if (!filePath) {
      return {
        runId: run.id,
        stream: options.stream,
        lines: [],
        totalLines: 0,
        nextAfterLine: 0,
        hasMore: false,
      };
    }
    const chunk = await readRunLogChunk(filePath, {
      limit: options.limit,
      afterLine: options.afterLine,
    });

    return {
      runId: run.id,
      stream: options.stream,
      ...chunk,
    };
  }

  async getRunState(id: string): Promise<KernelRunState> {
    const run = this.requireRecord(id).run;
    const backendState = await this.readRunStateFromBackend(id);
    if (backendState) {
      return backendState;
    }

    if (!run.artifacts) {
      return { snapshot: null, source: "missing" };
    }

    try {
      const content = await readFile(run.artifacts.livePath, "utf8");
      return {
        snapshot: JSON.parse(content) as OsSystemSnapshot,
        source: "live",
      };
    } catch {
      try {
        const content = await readFile(run.artifacts.snapshotPath, "utf8");
        return {
          snapshot: JSON.parse(content) as OsSystemSnapshot,
          source: "final",
        };
      } catch {
        return {
          snapshot: null,
          source: "missing",
        };
      }
    }
  }

  private async readRunEventsFromBackend(
    id: string,
    options: ReadRunEventsOptions,
  ): Promise<RuntimeProtocolEvent[] | null> {
    if (!this.storageBackend?.isConnected() || typeof this.storageBackend.getRunEvents !== "function") {
      return null;
    }

    try {
      const events = await this.storageBackend.getRunEvents(id, options);
      if (Array.isArray(events)) {
        return events;
      }
    } catch {
      // Fallback to filesystem artifact reads.
    }

    return null;
  }

  private async readRunStateFromBackend(id: string): Promise<KernelRunState | null> {
    if (!this.storageBackend?.isConnected() || typeof this.storageBackend.getRunState !== "function") {
      return null;
    }

    try {
      const state = await this.storageBackend.getRunState(id);
      if (state && (state.source === "live" || state.source === "final" || state.source === "missing")) {
        return state;
      }
    } catch {
      // Fallback to filesystem artifact reads.
    }

    return null;
  }

  async getRunSnapshot(id: string): Promise<OsSystemSnapshot | null> {
    const state = await this.getRunState(id);
    return state.snapshot;
  }

  private buildCommand(
    input: KernelRunInput,
    runId: string,
    artifacts?: { outputPath: string; protocolLogPath: string },
  ): {
    command: string;
    args: string[];
    cwd: string;
  } {
    const cwd = path.resolve(input.cwd);
    const args = [this.scriptPath, "os", "--goal", input.goal, "--json"];

    if (artifacts) {
      args.push("--out", artifacts.outputPath);
      args.push("--protocol-log", artifacts.protocolLogPath);
    }

    if (this.storageBackend?.isConnected()) {
      args.push("--run-id", runId);
    }

    if (input.configPath) {
      args.push("--config", path.resolve(cwd, input.configPath));
    }
    if (input.provider) {
      args.push("--provider", input.provider);
    }

    return {
      command: this.nodePath,
      args,
      cwd,
    };
  }

  private async transitionRun(id: string, patch: Partial<KernelRun>): Promise<void> {
    const record = this.requireRecord(id);
    const updated: KernelRun = {
      ...record.run,
      ...patch,
      updatedAt: this.timestamp(),
    };

    record.run = updated;
    await this.persistRun(updated);
  }

  private async persistRun(run: KernelRun): Promise<void> {
    if (this.storageBackend?.isConnected() && typeof this.storageBackend.saveRun === "function") {
      try {
        await this.storageBackend.saveRun(run);
      } catch {
        // Filesystem persistence is the source-of-truth fallback.
      }
    }

    if (run.artifacts?.runFilePath) {
      await writeFile(run.artifacts.runFilePath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    }
  }

  private requireRecord(id: string): KernelRunRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Run not found: ${id}`);
    }
    return record;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private assertScriptPath(): void {
    const resolvedPath = path.resolve(this.scriptPath);
    if (!this.scriptPathExistsFn(resolvedPath)) {
      throw new Error(
        [
          "cognitive-kernels CLI entrypoint not found.",
          `resolvedPath: ${resolvedPath}`,
          `currentCwd: ${process.cwd()}`,
          "Build first with npm run build.",
          "If needed, set an explicit override with --script-path /absolute/path/to/dist/cli.js.",
        ].join(" "),
      );
    }
  }

  private isTerminal(status: KernelRunStatus): boolean {
    return status === "completed" || status === "failed" || status === "canceled";
  }

  private sendSignal(record: KernelRunRecord, signal: NodeJS.Signals): void {
    if (record.child) {
      record.child.kill(signal);
      return;
    }
    if (record.run.pid === null) {
      throw new Error(`Run ${record.run.id} has no active process`);
    }
    process.kill(record.run.pid, signal);
  }

  private async loadPersistedRuns(): Promise<void> {
    const entries = await readdir(this.runsRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const runFilePath = path.join(this.runsRoot, entry.name, "run.json");
      try {
        const content = await readFile(runFilePath, "utf8");
        const run = JSON.parse(content) as KernelRun;
        this.records.set(run.id, {
          run,
          child: null,
        });
      } catch {
        continue;
      }
    }
  }

  private async reconcilePersistedRuns(): Promise<void> {
    for (const record of this.records.values()) {
      if (this.isTerminal(record.run.status) || record.run.pid === null) {
        continue;
      }
      if (isPidAlive(record.run.pid)) {
        continue;
      }

      await this.transitionRun(record.run.id, {
        status: "failed",
        endedAt: this.timestamp(),
        error: "Run process was not alive when the manager initialized.",
      });
    }
  }
}

export async function readRunEvents(
  protocolLogPath: string,
  limit = 200,
): Promise<RuntimeProtocolEvent[]> {
  if (limit <= 0) {
    return [];
  }

  try {
    const content = await readFile(protocolLogPath, "utf8");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const parsed: RuntimeProtocolEvent[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as RuntimeProtocolEvent);
      } catch {
        continue;
      }
    }

    if (parsed.length <= limit) {
      return parsed;
    }

    return parsed.slice(parsed.length - limit);
  } catch {
    return [];
  }
}

type ReadRunLogChunkOptions = {
  limit?: number;
  afterLine?: number;
};

export async function readRunLogChunk(
  filePath: string,
  options: ReadRunLogChunkOptions = {},
): Promise<{
  lines: KernelRunLogLine[];
  totalLines: number;
  nextAfterLine: number;
  hasMore: boolean;
}> {
  const limit = getPositiveLimit(options.limit, 200);
  const afterLine = Math.max(0, Math.floor(options.afterLine ?? 0));

  if (limit <= 0) {
    return {
      lines: [],
      totalLines: 0,
      nextAfterLine: afterLine,
      hasMore: false,
    };
  }

  try {
    const content = await readFile(filePath, "utf8");
    const allLines = content
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.length > 0);

    const totalLines = allLines.length;
    const startIndex = Math.min(afterLine, totalLines);
    const unread = allLines.slice(startIndex);
    const selected = unread.slice(0, limit);
    const nextAfterLine = startIndex + selected.length;
    const hasMore = unread.length > selected.length;

    const lines: KernelRunLogLine[] = selected.map((text, index) => ({
      lineNumber: startIndex + index + 1,
      text,
    }));

    return {
      lines,
      totalLines,
      nextAfterLine,
      hasMore,
    };
  } catch {
    return {
      lines: [],
      totalLines: 0,
      nextAfterLine: afterLine,
      hasMore: false,
    };
  }
}

export function resolveDefaultCliScriptPath(moduleUrl = import.meta.url): string {
  const packageRoot = resolvePackageRootFromModule(moduleUrl);
  return path.join(packageRoot, "dist", "cli.js");
}

function resolvePackageRootFromModule(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  let current = path.dirname(modulePath);

  while (true) {
    const candidate = path.join(current, "package.json");
    if (existsSync(candidate)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(path.dirname(modulePath), "..", "..");
    }

    current = parent;
  }
}

function getRunLogPath(run: KernelRun, stream: KernelRunLogStream): string | undefined {
  if (!run.artifacts) return undefined;
  switch (stream) {
    case "stdout":
      return run.artifacts.stdoutPath;
    case "stderr":
      return run.artifacts.stderrPath;
    case "protocol":
      return run.artifacts.protocolLogPath;
    default:
      return run.artifacts.stdoutPath;
  }
}

function getPositiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code === "EPERM"
      : false;
  }
}
