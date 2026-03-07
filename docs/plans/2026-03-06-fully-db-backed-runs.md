# Fully DB-Backed Runs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate filesystem dependency for run data so runs are fully observable from any machine with DB access.

**Architecture:** The child process (`node dist/cli.js os`) already writes protocol events and snapshots via `OsProtocolEmitter`. We wire it to use `NeonStorageBackend` when `DATABASE_URL` is set, making the DB authoritative. The `OsProtocolEmitter` gets a DB-only mode that skips all filesystem writes. The run manager passes `DATABASE_URL` to child processes and reads everything from the backend.

**Tech Stack:** Drizzle ORM, `@neondatabase/serverless`, Neon Postgres, Vitest

---

### Task 1: Align `NeonStorageBackend.appendEvents` to accept `RuntimeProtocolEvent[]`

The `OsProtocolEmitter` already has backend integration that calls `appendEvents(runId, events)` with `RuntimeProtocolEvent[]`. But `NeonStorageBackend.appendEvents` expects `Array<{ type: string; payload: Record<string, unknown>; createdAt: Date }>`. We need to align these so the emitter can talk directly to the backend.

**Files:**
- Modify: `src/db/storage-backend.ts:7-18` (interface) and `src/db/storage-backend.ts:131-152` (implementation)
- Modify: `src/os/protocol-emitter.ts:17-21` (type must match)
- Test: `test/db/storage-backend.test.ts`

**Step 1: Write the failing test**

Add a test to `test/db/storage-backend.test.ts` that calls `appendEvents` with `RuntimeProtocolEvent[]`:

```typescript
test("appendEvents accepts RuntimeProtocolEvent arrays", async () => {
  const backend = createStorageBackend();
  await backend.connect();

  const events: RuntimeProtocolEvent[] = [
    {
      action: "os_tick",
      status: "completed",
      timestamp: new Date().toISOString(),
      message: "tick=1",
      agentId: "proc-1",
      eventSource: "os",
    },
  ];

  // Should not throw
  await backend.appendEvents("run-1", events);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/storage-backend.test.ts`
Expected: Type error — `RuntimeProtocolEvent` doesn't match the current parameter type.

**Step 3: Update the `StorageBackend` interface**

In `src/db/storage-backend.ts`, change `appendEvents` signature:

```typescript
// Before:
appendEvents(runId: string, events: Array<{ type: string; payload: Record<string, unknown>; createdAt: Date }>): Promise<void>;

// After:
appendEvents(runId: string, events: RuntimeProtocolEvent[]): Promise<void>;
```

**Step 4: Update `NeonStorageBackend.appendEvents` implementation**

```typescript
async appendEvents(runId: string, events: RuntimeProtocolEvent[]): Promise<void> {
  if (events.length === 0) return;

  const existing = await this.db.select({ seq: runEvents.seq })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.seq))
    .limit(1);

  let nextSeq = (existing[0]?.seq ?? 0) + 1;

  const rows = events.map(event => ({
    runId,
    seq: nextSeq++,
    type: event.action,
    payload: event as unknown as Record<string, unknown>,
    createdAt: event.timestamp,
  }));

  await this.db.insert(runEvents).values(rows);

  // Update event cache
  const cached = this.cachedEvents.get(runId) ?? [];
  cached.push(...events);
  this.cachedEvents.set(runId, cached);
}
```

**Step 5: Update `InMemoryStorageBackend.appendEvents`**

```typescript
private events = new Map<string, RuntimeProtocolEvent[]>();

async appendEvents(runId: string, events: RuntimeProtocolEvent[]): Promise<void> {
  const existing = this.events.get(runId) ?? [];
  existing.push(...events);
  this.events.set(runId, existing);
}
```

**Step 6: Update `OsProtocolEmitterStorageBackend` type**

In `src/os/protocol-emitter.ts`, the type already calls `appendEvents` with `RuntimeProtocolEvent[]` at runtime (line 137). Update the type definition to match:

```typescript
export type OsProtocolEmitterStorageBackend = {
  isConnected(): boolean;
  appendEvents?(runId: string, events: RuntimeProtocolEvent[]): Promise<void> | void;
  saveSnapshot?(runId: string, snapshot: OsSystemSnapshot, source: "live" | "final"): Promise<void> | void;
};
```

**Step 7: Update `saveSnapshot` to use the new `appendEvents` internally**

In `NeonStorageBackend.saveSnapshot`, the internal call to `appendEvents` must pass `RuntimeProtocolEvent[]` now. Create a synthetic event:

```typescript
async saveSnapshot(runId: string, state: { snapshot: OsSystemSnapshot; source: "live" | "final" }): Promise<void> {
  this.cachedSnapshots.set(runId, state);

  const syntheticEvent: RuntimeProtocolEvent = {
    action: `snapshot:${state.source}`,
    status: "completed",
    timestamp: new Date().toISOString(),
    message: JSON.stringify(state.snapshot),
    eventSource: "os",
  };

  await this.appendEvents(runId, [syntheticEvent]);
}
```

**Step 8: Fix `protocol-emitter-pg.ts` and its test**

`createPgProtocolEmitter` uses the old `StoredProtocolEvent` shape. Update it to pass `RuntimeProtocolEvent[]` directly:

In `src/db/protocol-emitter-pg.ts`:
```typescript
type PgProtocolEmitterOptions = {
  runId: string;
  appendEvents: (runId: string, events: RuntimeProtocolEvent[]) => Promise<void>;
  writeState: (runId: string, state: { snapshot: OsSystemSnapshot; source: "live" | "final" }) => Promise<void>;
};

// persistEvent becomes:
const persistEvent = async (event: RuntimeProtocolEvent): Promise<void> => {
  await options.appendEvents(options.runId, [event]);
};
```

The test in `test/db/protocol-emitter-pg.test.ts` will need its assertion updated — `parsePersistedEvent` currently expects `{ type: "runtime_protocol_event", payload: ... }` wrapping. After this change, `appendEvents` receives the raw `RuntimeProtocolEvent` directly.

**Step 9: Run all tests**

Run: `npx vitest run`
Expected: All 57+ tests pass.

**Step 10: Commit**

```bash
git add src/db/storage-backend.ts src/os/protocol-emitter.ts src/db/protocol-emitter-pg.ts test/
git commit -m "refactor: align appendEvents to accept RuntimeProtocolEvent directly"
```

---

### Task 2: Make `OsProtocolEmitter` work without filesystem

Currently the constructor requires `protocolLogPath`, `snapshotPath`, `livePath` and always creates a `WriteStream`. We need a DB-only mode that skips all filesystem I/O.

**Files:**
- Modify: `src/os/protocol-emitter.ts:23-45` (constructor), `src/os/protocol-emitter.ts:58` (emit), `src/os/protocol-emitter.ts:76` (emitStreamEvent), `src/os/protocol-emitter.ts:80-98` (writeLiveState/saveSnapshot), `src/os/protocol-emitter.ts:171-184` (close)
- Test: `test/os/protocol-emitter-dbonly.test.ts` (new)

**Step 1: Write the failing test**

Create `test/os/protocol-emitter-dbonly.test.ts`:

```typescript
import { describe, expect, test, vi } from "vitest";
import { OsProtocolEmitter } from "../../src/os/protocol-emitter.js";
import type { OsSystemSnapshot } from "../../src/os/types.js";

describe("OsProtocolEmitter DB-only mode", () => {
  test("emits events to storage backend without filesystem", () => {
    const backend = {
      isConnected: () => true,
      appendEvents: vi.fn(),
      saveSnapshot: vi.fn(),
    };

    const emitter = new OsProtocolEmitter({ storageBackend: backend, runId: "test-run" });

    emitter.emit({
      action: "os_tick",
      status: "completed",
      message: "tick=1",
    });

    expect(backend.appendEvents).not.toHaveBeenCalled(); // buffered, not flushed yet
    // No filesystem error means DB-only mode works
  });

  test("writeLiveState calls saveSnapshot on backend", () => {
    const backend = {
      isConnected: () => true,
      appendEvents: vi.fn(),
      saveSnapshot: vi.fn(),
    };

    const emitter = new OsProtocolEmitter({ storageBackend: backend, runId: "test-run" });
    const snapshot = { goal: "test" } as OsSystemSnapshot;

    emitter.writeLiveState(snapshot);

    expect(backend.saveSnapshot).toHaveBeenCalledWith("test-run", snapshot, "live");
  });

  test("close flushes buffered events to backend", async () => {
    const appendEvents = vi.fn(async () => {});
    const backend = {
      isConnected: () => true,
      appendEvents,
      saveSnapshot: vi.fn(),
    };

    const emitter = new OsProtocolEmitter({ storageBackend: backend, runId: "test-run" });

    emitter.emit({ action: "os_tick", status: "completed", message: "tick=1" });
    emitter.emit({ action: "os_tick", status: "completed", message: "tick=2" });

    await emitter.close();

    expect(appendEvents).toHaveBeenCalled();
    const allEvents = appendEvents.mock.calls.flatMap(([, events]) => events);
    expect(allEvents).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/protocol-emitter-dbonly.test.ts`
Expected: FAIL — constructor doesn't accept options object.

**Step 3: Refactor `OsProtocolEmitter` constructor**

Change the constructor to accept either filesystem paths OR a DB-only config:

```typescript
type OsProtocolEmitterOptions =
  | {
      protocolLogPath: string;
      snapshotPath: string;
      livePath: string;
      storageBackend?: OsProtocolEmitterStorageBackend;
    }
  | {
      storageBackend: OsProtocolEmitterStorageBackend;
      runId: string;
    };

export class OsProtocolEmitter {
  private readonly stream: WriteStream | null;
  private readonly snapshotPath: string | null;
  private readonly livePath: string | null;
  private readonly runId: string;
  private readonly storageBackend?: OsProtocolEmitterStorageBackend;
  private readonly bufferedEvents: RuntimeProtocolEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(options: OsProtocolEmitterOptions);
  /** @deprecated Use options object instead */
  constructor(protocolLogPath: string, snapshotPath: string, livePath: string, storageBackend?: OsProtocolEmitterStorageBackend);
  constructor(
    optionsOrPath: OsProtocolEmitterOptions | string,
    snapshotPath?: string,
    livePath?: string,
    storageBackend?: OsProtocolEmitterStorageBackend,
  ) {
    if (typeof optionsOrPath === "string") {
      // Legacy positional args
      this.stream = createWriteStream(optionsOrPath, { flags: "a" });
      this.snapshotPath = snapshotPath!;
      this.livePath = livePath!;
      this.runId = path.basename(path.dirname(optionsOrPath));
      this.storageBackend = storageBackend;
    } else if ("protocolLogPath" in optionsOrPath) {
      // Options with filesystem paths
      this.stream = createWriteStream(optionsOrPath.protocolLogPath, { flags: "a" });
      this.snapshotPath = optionsOrPath.snapshotPath;
      this.livePath = optionsOrPath.livePath;
      this.runId = path.basename(path.dirname(optionsOrPath.protocolLogPath));
      this.storageBackend = optionsOrPath.storageBackend;
    } else {
      // DB-only mode — no filesystem
      this.stream = null;
      this.snapshotPath = null;
      this.livePath = null;
      this.runId = optionsOrPath.runId;
      this.storageBackend = optionsOrPath.storageBackend;
    }
  }
```

**Step 4: Guard all filesystem writes**

In `emit()`:
```typescript
emit(input: OsProtocolEventInput): void {
  const event: RuntimeProtocolEvent = { ... };

  if (this.stream) {
    this.stream.write(`${JSON.stringify(event)}\n`);
  }
  this.enqueueBackendEvent(event);
}
```

In `emitStreamEvent()`:
```typescript
if (this.stream) {
  this.stream.write(`${JSON.stringify(entry)}\n`);
}
this.enqueueBackendEvent(entry);
```

In `writeLiveState()`:
```typescript
writeLiveState(snapshot: OsSystemSnapshot): void {
  if (this.livePath) {
    writeFileSync(this.livePath, JSON.stringify(snapshot, null, 2), "utf8");
  }
  if (this.storageBackend?.isConnected() && typeof this.storageBackend.saveSnapshot === "function") {
    void Promise.resolve(this.storageBackend.saveSnapshot(this.runId, snapshot, "live")).catch(() => {});
  }
}
```

In `saveSnapshot()`:
```typescript
saveSnapshot(snapshot: OsSystemSnapshot): void {
  if (this.livePath) {
    writeFileSync(this.livePath, JSON.stringify(snapshot, null, 2), "utf8");
  }
  if (this.snapshotPath) {
    writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  }
  if (this.storageBackend?.isConnected() && typeof this.storageBackend.saveSnapshot === "function") {
    void Promise.resolve(this.storageBackend.saveSnapshot(this.runId, snapshot, "final")).catch(() => {});
  }
}
```

In `close()`:
```typescript
async close(): Promise<void> {
  this.clearFlushTimer();
  while (this.bufferedEvents.length > 0 || this.flushInFlight) {
    this.flushBufferedEvents();
    if (this.flushInFlight) {
      await this.flushInFlight;
    }
  }
  if (this.stream) {
    await new Promise<void>((resolve) => {
      this.stream!.end(() => resolve());
    });
  }
}
```

**Step 5: Run tests**

Run: `npx vitest run`
Expected: All tests pass including the new DB-only tests.

**Step 6: Commit**

```bash
git add src/os/protocol-emitter.ts test/os/protocol-emitter-dbonly.test.ts
git commit -m "feat: add DB-only mode to OsProtocolEmitter"
```

---

### Task 3: Wire `entry.ts` to use Neon backend when `DATABASE_URL` is set

The child process needs to connect to Neon and pass the backend to `OsProtocolEmitter`.

**Files:**
- Modify: `src/os/entry.ts:1-91`
- Test: `test/os/entry.test.ts` (add test for DB-only emitter path)

**Step 1: Write the failing test**

Add to `test/os/entry.test.ts`:

```typescript
test("creates DB-only emitter when DATABASE_URL is set and no protocolLogPath", async () => {
  const originalEnv = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://fake:fake@localhost/fake";

  // We need to verify that when DATABASE_URL is set but no protocolLogPath,
  // the kernel is constructed with an emitter (not undefined)
  try {
    await runOsMode({
      goal: "test db emitter",
      cwd: "/tmp/workspace",
    });
  } finally {
    if (originalEnv) {
      process.env.DATABASE_URL = originalEnv;
    } else {
      delete process.env.DATABASE_URL;
    }
  }

  // The kernel mock's constructor receives the emitter as 4th arg
  // If DB-only mode works, emitter should not be undefined
  expect(runMock).toHaveBeenCalledWith("test db emitter");
});
```

Note: The existing test mocks `OsKernel` so no real DB connection is needed. But we need to also mock `createDbConnection` and `NeonStorageBackend` to avoid real DB calls. Adjust the test file's mocks accordingly.

**Step 2: Update `entry.ts`**

```typescript
import { config as loadDotenv } from "dotenv";
import { createDbConnection } from "../db/connection.js";
import { NeonStorageBackend } from "../db/storage-backend.js";

loadDotenv();

export async function runOsMode(input: OsModeInput): Promise<OsSystemSnapshot> {
  // ... existing config loading ...

  let emitter: OsProtocolEmitter | undefined;

  if (input.protocolLogPath && process.env.DATABASE_URL) {
    // Filesystem + DB dual-write
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
    // Filesystem only (no DATABASE_URL)
    const snapshotPath = path.join(path.dirname(input.protocolLogPath), "os-snapshot.json");
    const livePath = path.join(path.dirname(input.protocolLogPath), "os-live.json");
    emitter = new OsProtocolEmitter({
      protocolLogPath: input.protocolLogPath,
      snapshotPath,
      livePath,
    });
  } else if (process.env.DATABASE_URL && input.runId) {
    // DB-only mode (no protocolLogPath) — used when run manager passes runId
    const db = createDbConnection(process.env.DATABASE_URL);
    const backend = new NeonStorageBackend(db);
    await backend.connect();
    emitter = new OsProtocolEmitter({
      storageBackend: backend,
      runId: input.runId,
    });
  }

  // ... rest unchanged ...
}
```

**Step 3: Add `runId` to `OsModeInput`**

```typescript
export type OsModeInput = {
  goal: string;
  configPath?: string;
  protocolLogPath?: string;
  cwd: string;
  provider?: "claude" | "codex";
  runId?: string;  // NEW: passed by run manager for DB-only mode
};
```

**Step 4: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/os/entry.ts test/os/entry.test.ts
git commit -m "feat: wire entry.ts to create Neon-backed emitter when DATABASE_URL is set"
```

---

### Task 4: Make `KernelRunArtifacts` optional and update `KernelRun`

DB-backed runs don't have filesystem artifacts. Make the type reflect this.

**Files:**
- Modify: `src/types.ts:113-122,147-162`
- Test: existing tests must still compile

**Step 1: Make artifacts optional**

In `src/types.ts`:

```typescript
export type KernelRun = {
  id: string;
  status: KernelRunStatus;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  command: string;
  args: string[];
  input: KernelRunInput;
  artifacts?: KernelRunArtifacts;  // was required, now optional
};
```

**Step 2: Fix all compile errors from optional artifacts**

Search for `run.artifacts.` and `.artifacts.` across the codebase. Each access needs a guard or optional chain. Key locations:

- `src/runs/run-manager.ts:176-182` — artifacts creation (still needed for filesystem runs)
- `src/runs/run-manager.ts:317` — `run.artifacts.protocolLogPath` → guard with `if (run.artifacts)`
- `src/runs/run-manager.ts:322` — `getRunLogPath(run, ...)` → guard
- `src/runs/run-manager.ts:343-350` — `run.artifacts.livePath/snapshotPath` → guard
- `src/runs/run-manager.ts:458` — `run.artifacts.runFilePath` → guard
- `src/db/storage-backend.ts:84` — `artifacts: run.artifacts` → already optional-safe in JSONB

**Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests pass (no runtime changes, just type narrowing).

**Step 4: Commit**

```bash
git add src/types.ts src/runs/run-manager.ts
git commit -m "refactor: make KernelRunArtifacts optional for DB-only runs"
```

---

### Task 5: Update `run-manager.ts` to support DB-only runs

The run manager currently always creates a filesystem run directory and spawns the child with filesystem CLI args. For DB-backed runs, it should pass `DATABASE_URL` and `--run-id` to the child, and skip filesystem artifact creation.

**Files:**
- Modify: `src/runs/run-manager.ts:165-266` (startRun), `src/runs/run-manager.ts:406-435` (buildCommand), `src/runs/run-manager.ts:311-362` (read methods)
- Modify: `src/cli.ts` (handle `--run-id` flag)
- Test: `test/runs/run-manager.test.ts`

**Step 1: Write the failing test**

Add to `test/runs/run-manager.test.ts`:

```typescript
test("startRun with storageBackend skips filesystem artifacts when no runsRoot needed", async () => {
  const backend = {
    isConnected: () => true,
    saveRun: vi.fn(async () => {}),
    listRuns: () => [],
    getRun: () => undefined,
    getRunEvents: () => [],
    getRunState: () => ({ snapshot: null, source: "missing" as const }),
  };

  const manager = new KernelRunManager({
    storageBackend: backend,
    spawnFn: mockSpawn,
    // ... other test options
  });

  await manager.initialize();
  const run = await manager.startRun({ goal: "test", cwd: "/tmp" });

  // Backend should have been called to save the run
  expect(backend.saveRun).toHaveBeenCalled();

  // The spawned command should include --run-id
  const spawnCall = mockSpawn.mock.calls[0];
  const args = spawnCall[1] as string[];
  expect(args).toContain("--run-id");
  expect(args).toContain(run.id);
});
```

**Step 2: Update `buildCommand` to pass `--run-id` and `DATABASE_URL`**

When `storageBackend?.isConnected()`, the child should get `--run-id` instead of `--protocol-log` and `--out`:

```typescript
private buildCommand(
  input: KernelRunInput,
  runId: string,
  artifacts?: { outputPath: string; protocolLogPath: string },
): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
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

  return { command: this.nodePath, args, cwd, env: { ...process.env } as Record<string, string> };
}
```

**Step 3: Update `startRun` to conditionally create filesystem artifacts**

```typescript
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

  const { command, args, cwd } = this.buildCommand(
    input,
    id,
    artifacts ? { outputPath: artifacts.outputPath, protocolLogPath: artifacts.protocolLogPath } : undefined,
  );

  const run: KernelRun = {
    id,
    status: "queued",
    pid: null,
    createdAt,
    updatedAt: createdAt,
    command,
    args,
    input: { ...input, cwd, configPath: input.configPath ? path.resolve(cwd, input.configPath) : undefined },
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

  // Only pipe to files if we have artifacts
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

  // ... rest of status transitions unchanged ...
}
```

**Step 4: Update `persistRun` to skip filesystem when DB-only**

```typescript
private async persistRun(run: KernelRun): Promise<void> {
  if (this.storageBackend?.isConnected() && typeof this.storageBackend.saveRun === "function") {
    try {
      await this.storageBackend.saveRun(run);
    } catch {
      // Falls through to filesystem if available
    }
  }

  if (run.artifacts?.runFilePath) {
    await writeFile(run.artifacts.runFilePath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }
}
```

**Step 5: Update read methods to guard on artifacts**

In `getRunEvents`:
```typescript
async getRunEvents(id: string, options: ReadRunEventsOptions = {}): Promise<RuntimeProtocolEvent[]> {
  const run = this.requireRecord(id).run;
  const backendEvents = await this.readRunEventsFromBackend(id, options);
  if (backendEvents) return backendEvents;
  if (!run.artifacts?.protocolLogPath) return [];
  return readRunEvents(run.artifacts.protocolLogPath, options.limit ?? 200);
}
```

In `getRunLog`:
```typescript
async getRunLog(id: string, options: ReadRunLogOptions): Promise<KernelRunLogChunk> {
  const run = this.requireRecord(id).run;
  if (!run.artifacts) {
    return { runId: run.id, stream: options.stream, lines: [], totalLines: 0, nextAfterLine: 0, hasMore: false };
  }
  // ... existing filesystem read ...
}
```

In `getRunState`:
```typescript
async getRunState(id: string): Promise<KernelRunState> {
  const run = this.requireRecord(id).run;
  const backendState = await this.readRunStateFromBackend(id);
  if (backendState) return backendState;
  if (!run.artifacts) return { snapshot: null, source: "missing" };
  // ... existing filesystem read ...
}
```

**Step 6: Add `--run-id` to `cli.ts` arg parser**

In `src/cli.ts`, update `handleOsCommand`:
```typescript
const runId = readStringFlag(flags, "--run-id");
```

Pass it to `runOsMode`:
```typescript
const snapshot = await runOsMode({
  goal,
  configPath,
  protocolLogPath,
  cwd,
  provider,
  runId,  // NEW
});
```

Update `parseArgs` to accept `--run-id` as a valued flag (it already handles any `--<name> <value>` pair, so no change needed there).

**Step 7: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 8: Commit**

```bash
git add src/runs/run-manager.ts src/cli.ts src/types.ts
git commit -m "feat: run-manager supports DB-only runs without filesystem artifacts"
```

---

### Task 6: Update `loadPersistedRuns` to handle missing artifacts gracefully

When loading from the DB on startup, runs won't have filesystem directories. `loadPersistedRuns` currently scans `runsRoot` for directories — this still works but won't find DB-only runs. `loadRuns()` on the backend handles those.

**Files:**
- Modify: `src/runs/run-manager.ts:503-523` (loadPersistedRuns)
- Modify: `src/runs/run-manager.ts:84-88` (initialize)

**Step 1: Update `initialize` to load from backend first**

```typescript
async initialize(): Promise<void> {
  await mkdir(this.runsRoot, { recursive: true });

  // Load from DB backend first (if available)
  if (this.storageBackend?.isConnected()) {
    const backendRuns = this.storageBackend.listRuns();
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
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/runs/run-manager.ts
git commit -m "feat: initialize loads runs from DB backend before filesystem"
```

---

### Task 7: End-to-end integration test

Verify the full flow: start a run via the MCP server with `DATABASE_URL` set, confirm events and snapshots land in Neon.

**Files:**
- Create: `scripts/test-db-backed-run.ts`

**Step 1: Create the integration test script**

```typescript
import { config as loadDotenv } from "dotenv";
loadDotenv();

import { createDbConnection } from "../src/db/connection.js";
import { NeonStorageBackend } from "../src/db/storage-backend.js";
import { runs, runEvents } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDbConnection(url);
const backend = new NeonStorageBackend(db);

console.log("Connecting...");
await backend.connect();
await backend.loadRuns();

console.log("Existing runs:", backend.listRuns().length);

// List all runs and their event counts
for (const run of backend.listRuns()) {
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
  console.log(`  ${run.id.slice(0, 8)} | ${run.status} | ${events.length} events | ${run.input?.goal?.slice(0, 50) ?? "no goal"}`);
}

console.log("\nDone. To test a full DB-backed run, start the MCP server with DATABASE_URL set.");
```

**Step 2: Run it**

Run: `npx tsx scripts/test-db-backed-run.ts`
Expected: Lists existing runs from Neon.

**Step 3: Commit**

```bash
git add scripts/test-db-backed-run.ts
git commit -m "feat: add DB-backed run integration test script"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/db/storage-backend.ts` | `appendEvents` accepts `RuntimeProtocolEvent[]`; cache events |
| `src/db/protocol-emitter-pg.ts` | Passes `RuntimeProtocolEvent` directly instead of wrapping |
| `src/os/protocol-emitter.ts` | DB-only constructor mode; guard all filesystem writes |
| `src/os/entry.ts` | Wire Neon backend when `DATABASE_URL` set; accept `runId` |
| `src/types.ts` | `artifacts` optional on `KernelRun` |
| `src/runs/run-manager.ts` | DB-only run path; pass `--run-id`; guard artifact access |
| `src/cli.ts` | Accept `--run-id` flag, pass to `runOsMode` |
| `test/os/protocol-emitter-dbonly.test.ts` | New: DB-only emitter tests |
| `test/db/storage-backend.test.ts` | Updated: RuntimeProtocolEvent appendEvents test |
| `test/db/protocol-emitter-pg.test.ts` | Updated: new event shape assertions |
| `scripts/test-db-backed-run.ts` | New: integration verification script |
