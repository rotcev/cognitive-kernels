import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { KernelRunManager } from "../../src/runs/run-manager.js";
import type { OsSystemSnapshot } from "../../src/os/types.js";
import type { KernelRun, RuntimeProtocolEvent } from "../../src/types.js";

class FakeChildProcess extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    return true;
  }
}

class FakeStorageBackend {
  readonly kind = "memory" as const;
  connected: boolean;
  failSave = false;
  saveRunCalls: KernelRun[] = [];
  listRunsCalls = 0;
  getRunCalls = 0;
  getRunEventsCalls: Array<{ id: string; limit: number | undefined }> = [];
  getRunStateCalls: string[] = [];
  runs: KernelRun[] = [];
  runEvents = new Map<string, RuntimeProtocolEvent[]>();
  runStates = new Map<string, { snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" }>();

  constructor(connected = true) {
    this.connected = connected;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async saveRun(run: KernelRun): Promise<void> {
    this.saveRunCalls.push(run);
    if (this.failSave) {
      throw new Error("save failure");
    }
  }

  listRuns(): KernelRun[] {
    this.listRunsCalls += 1;
    return [...this.runs];
  }

  getRun(id: string): KernelRun | undefined {
    this.getRunCalls += 1;
    return this.runs.find((run) => run.id === id);
  }

  getRunEvents(id: string, options?: { limit?: number }): RuntimeProtocolEvent[] {
    this.getRunEventsCalls.push({ id, limit: options?.limit });
    return this.runEvents.get(id) ?? [];
  }

  getRunState(id: string): { snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" } {
    this.getRunStateCalls.push(id);
    return this.runStates.get(id) ?? { snapshot: null, source: "missing" };
  }
}

function createSpawnFn() {
  let nextPid = 30_000;
  const spawnFn = (() => new FakeChildProcess(nextPid++) as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
  return spawnFn;
}

async function createManager(options: {
  backend?: FakeStorageBackend;
  runsRoot?: string;
} = {}): Promise<KernelRunManager> {
  const tempRoot = options.runsRoot
    ? path.dirname(options.runsRoot)
    : await mkdtemp(path.join(os.tmpdir(), "cognitive-kernels-run-manager-pg-"));
  const runsRoot = path.join(tempRoot, "runs");
  const scriptPath = path.join(tempRoot, "dist", "cli.js");

  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, "#!/usr/bin/env node\n", "utf8");

  const manager = new KernelRunManager({
    runsRoot,
    scriptPath,
    spawnFn: createSpawnFn(),
    storageBackend: options.backend,
  });

  await manager.initialize();
  return manager;
}

describe("story5:run-manager-pg", () => {
  test("startRun calls saveRun on connected storage backend", async () => {
    const backend = new FakeStorageBackend(true);
    const manager = await createManager({ backend });

    const run = await manager.startRun({
      goal: "Persist run to storage backend",
      cwd: "/tmp/workspace/project",
    });

    expect(backend.saveRunCalls.length).toBeGreaterThan(0);
    expect(backend.saveRunCalls.at(-1)?.status).toBe("running");

    void run;
  });

  test("gracefully handles backend save failure in DB-only mode", async () => {
    const backend = new FakeStorageBackend(true);
    backend.failSave = true;

    const manager = await createManager({ backend });
    const run = await manager.startRun({
      goal: "Fallback to filesystem persistence",
      cwd: "/tmp/workspace/project",
    });

    // When backend is connected, artifacts are not created (DB-only mode).
    // Even if saveRun throws, the run is still tracked in-memory.
    expect(run.artifacts).toBeUndefined();
    expect(backend.saveRunCalls.length).toBeGreaterThan(0);
    expect(run.status).toBe("running");

    // The run is still retrievable from the in-memory records.
    const retrieved = manager.getRun(run.id);
    expect(retrieved?.id).toBe(run.id);
  });

  test("listRuns reads from backend when connected", async () => {
    const backend = new FakeStorageBackend(true);
    backend.runs = [
      {
        id: "backend-run-1",
        status: "completed",
        pid: null,
        createdAt: "2026-03-05T00:00:00.000Z",
        updatedAt: "2026-03-05T00:00:00.000Z",
        startedAt: "2026-03-05T00:00:00.000Z",
        endedAt: "2026-03-05T00:05:00.000Z",
        command: "/usr/bin/node",
        args: ["dist/cli.js", "os"],
        input: {
          goal: "Loaded from backend",
          cwd: "/tmp/workspace/project",
        },
        artifacts: {
          runDir: "/tmp/workspace/project/.runs/backend-run-1",
          runFilePath: "/tmp/workspace/project/.runs/backend-run-1/run.json",
          outputPath: "/tmp/workspace/project/.runs/backend-run-1/output.json",
          protocolLogPath: "/tmp/workspace/project/.runs/backend-run-1/protocol.ndjson",
          livePath: "/tmp/workspace/project/.runs/backend-run-1/os-live.json",
          snapshotPath: "/tmp/workspace/project/.runs/backend-run-1/os-snapshot.json",
          stdoutPath: "/tmp/workspace/project/.runs/backend-run-1/stdout.log",
          stderrPath: "/tmp/workspace/project/.runs/backend-run-1/stderr.log",
        },
      },
    ];
    const manager = await createManager({ backend });

    const runs = manager.listRuns();

    // listRuns is called during initialize (to pre-load) + this call
    expect(backend.listRunsCalls).toBeGreaterThanOrEqual(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("backend-run-1");
  });

  test("getRun reads from backend when connected", async () => {
    const backend = new FakeStorageBackend(true);
    backend.runs = [
      {
        id: "backend-run-2",
        status: "completed",
        pid: null,
        createdAt: "2026-03-05T00:00:00.000Z",
        updatedAt: "2026-03-05T00:00:00.000Z",
        startedAt: "2026-03-05T00:00:00.000Z",
        endedAt: "2026-03-05T00:05:00.000Z",
        command: "/usr/bin/node",
        args: ["dist/cli.js", "os"],
        input: {
          goal: "Loaded from backend",
          cwd: "/tmp/workspace/project",
        },
        artifacts: {
          runDir: "/tmp/workspace/project/.runs/backend-run-2",
          runFilePath: "/tmp/workspace/project/.runs/backend-run-2/run.json",
          outputPath: "/tmp/workspace/project/.runs/backend-run-2/output.json",
          protocolLogPath: "/tmp/workspace/project/.runs/backend-run-2/protocol.ndjson",
          livePath: "/tmp/workspace/project/.runs/backend-run-2/os-live.json",
          snapshotPath: "/tmp/workspace/project/.runs/backend-run-2/os-snapshot.json",
          stdoutPath: "/tmp/workspace/project/.runs/backend-run-2/stdout.log",
          stderrPath: "/tmp/workspace/project/.runs/backend-run-2/stderr.log",
        },
      },
    ];
    const manager = await createManager({ backend });

    const run = manager.getRun("backend-run-2");

    // Run was pre-loaded during initialize, so it's found in records
    // without needing to call backend.getRun
    expect(run?.id).toBe("backend-run-2");
  });

  test("getRunEvents reads from backend when connected", async () => {
    const backend = new FakeStorageBackend(true);
    const manager = await createManager({ backend });
    const run = await manager.startRun({
      goal: "Load events from backend",
      cwd: "/tmp/workspace/project",
    });

    backend.runEvents.set(run.id, [
      {
        action: "os_tick",
        status: "completed",
        timestamp: "2026-03-05T00:00:00.000Z",
        message: "tick=1",
      },
    ]);

    const events = await manager.getRunEvents(run.id, { limit: 25 });

    expect(backend.getRunEventsCalls).toEqual([{ id: run.id, limit: 25 }]);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("os_tick");
  });

  test("getRunState reads from backend when connected", async () => {
    const backend = new FakeStorageBackend(true);
    const manager = await createManager({ backend });
    const run = await manager.startRun({
      goal: "Load state from backend",
      cwd: "/tmp/workspace/project",
    });

    const snapshot = {
      startedAt: "2026-03-05T00:00:00.000Z",
      goal: "backend state",
    } as OsSystemSnapshot;
    backend.runStates.set(run.id, { snapshot, source: "live" });

    const state = await manager.getRunState(run.id);

    expect(backend.getRunStateCalls).toEqual([run.id]);
    expect(state.source).toBe("live");
    expect(state.snapshot).toEqual(snapshot);
  });

  test("falls back to filesystem when no backend is configured", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cognitive-kernels-run-manager-pg-fs-"));
    const runsRoot = path.join(tempRoot, "runs");

    const manager = await createManager({ runsRoot });
    const started = await manager.startRun({
      goal: "Filesystem fallback without backend",
      cwd: "/tmp/workspace/project",
    });

    const restarted = await createManager({ runsRoot });
    const persisted = restarted.getRun(started.id);

    expect(persisted?.id).toBe(started.id);
    expect(persisted?.status).toBe("failed");
  });
});
