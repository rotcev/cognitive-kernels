import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OsProcess, OsSystemSnapshot } from "../../src/os/types.js";
import type { KernelRun, KernelRunInput, RuntimeProtocolEvent } from "../../src/types.js";

type RunsApiServer = {
  baseUrl: string;
  close: () => Promise<void> | void;
};

type RunsApiModule = {
  createRunsApiServer: (options: {
    runManager: FakeRunManager;
    runtimeAdapter?: FakeRuntimeAdapter;
    defaultCwd: string;
    defaultConfigPath?: string;
    host?: string;
    port?: number;
  }) => Promise<RunsApiServer>;
};

type ErrorWithCode = Error & {
  code?: string;
  statusCode?: number;
};

class FakeRuntimeAdapter {
  readonly subscriptions: Array<{
    runId: string;
    listener: (event: RuntimeProtocolEvent) => void;
    closed: boolean;
  }> = [];

  subscribeRunEvents(
    runId: string,
    listener: (event: RuntimeProtocolEvent) => void,
    _signal?: AbortSignal,
  ): () => void {
    const subscription = {
      runId,
      listener,
      closed: false,
    };
    this.subscriptions.push(subscription);
    return () => {
      subscription.closed = true;
    };
  }

  emit(runId: string, event: RuntimeProtocolEvent): void {
    for (const subscription of this.subscriptions) {
      if (subscription.runId === runId && !subscription.closed) {
        subscription.listener(event);
      }
    }
  }
}

class FakeRunManager {
  readonly startRun = vi.fn(async (input: KernelRunInput) => {
    const run = makeRun({
      id: `run-${this.startRun.mock.calls.length}`,
      input,
    });
    this.runs.set(run.id, run);
    return run;
  });

  readonly listRuns = vi.fn(() => [...this.runs.values()]);
  readonly getRun = vi.fn((id: string) => this.runs.get(id));
  readonly getRunEvents = vi.fn(async (id: string, _options: { limit?: number }) => this.events.get(id) ?? []);
  readonly getRunState = vi.fn(async (id: string) => {
    if (!this.runs.has(id)) {
      throw makeError(`Run not found: ${id}`, "RUN_NOT_FOUND", 404);
    }

    return {
      snapshot: this.snapshots.get(id) ?? makeSnapshot(id),
      source: "live" as const,
    };
  });
  readonly cancelRun = vi.fn(async (id: string) => {
    const run = this.runs.get(id);
    if (!run) {
      throw makeError(`Run not found: ${id}`, "RUN_NOT_FOUND", 404);
    }

    const canceled = {
      ...run,
      status: "canceled" as const,
      updatedAt: "2026-03-06T00:00:05.000Z",
      endedAt: "2026-03-06T00:00:05.000Z",
    };
    this.runs.set(id, canceled);
    return canceled;
  });

  readonly runs = new Map<string, KernelRun>();
  readonly events = new Map<string, RuntimeProtocolEvent[]>();
  readonly snapshots = new Map<string, OsSystemSnapshot>();
}

async function importApiModule(): Promise<RunsApiModule> {
  return import("../../src/api/server.js") as Promise<RunsApiModule>;
}

async function startServer(
  overrides: Partial<{
    runManager: FakeRunManager;
    runtimeAdapter: FakeRuntimeAdapter;
    defaultCwd: string;
    defaultConfigPath: string;
  }> = {},
): Promise<{ server: RunsApiServer; runManager: FakeRunManager; runtimeAdapter: FakeRuntimeAdapter }> {
  const runManager = overrides.runManager ?? new FakeRunManager();
  const runtimeAdapter = overrides.runtimeAdapter ?? new FakeRuntimeAdapter();
  const { createRunsApiServer } = await importApiModule();
  const server = await createRunsApiServer({
    runManager,
    runtimeAdapter,
    defaultCwd: overrides.defaultCwd ?? "/repo",
    defaultConfigPath: overrides.defaultConfigPath ?? "/repo/kernel.toml",
    host: "127.0.0.1",
    port: 0,
  });

  return { server, runManager, runtimeAdapter };
}

function makeProcess(overrides: Partial<OsProcess>): OsProcess {
  return {
    pid: overrides.pid ?? "p-1",
    type: overrides.type ?? "lifecycle",
    state: overrides.state ?? "running",
    name: overrides.name ?? "orchestrator",
    parentPid: overrides.parentPid ?? null,
    objective: overrides.objective ?? "Coordinate the topology",
    priority: overrides.priority ?? 80,
    spawnedAt: overrides.spawnedAt ?? "2026-03-06T00:00:00.000Z",
    lastActiveAt: overrides.lastActiveAt ?? "2026-03-06T00:00:01.000Z",
    tickCount: overrides.tickCount ?? 2,
    tokensUsed: overrides.tokensUsed ?? 42,
    model: overrides.model ?? "gpt-5.3-codex",
    workingDir: overrides.workingDir ?? "/repo",
    children: overrides.children ?? [],
    onParentDeath: overrides.onParentDeath ?? "orphan",
    restartPolicy: overrides.restartPolicy ?? "never",
  };
}

function makeSnapshot(runId: string): OsSystemSnapshot {
  const orchestrator = makeProcess({
    pid: "p-1",
    name: "orchestrator",
    priority: 90,
    children: ["p-2"],
  });
  const worker = makeProcess({
    pid: "p-2",
    parentPid: "p-1",
    name: "phase1-test-builder",
    state: "idle",
    priority: 88,
    objective: "Write API contract tests",
    children: [],
  });

  return {
    runId,
    tickCount: 3,
    goal: "Write API tests first",
    processes: [orchestrator, worker],
    dagTopology: {
      nodes: [
        { pid: "p-1", name: "orchestrator", type: "lifecycle", state: "running", priority: 90, parentPid: null },
        { pid: "p-2", name: "phase1-test-builder", type: "lifecycle", state: "idle", priority: 88, parentPid: "p-1" },
      ],
      edges: [
        { from: "p-1", to: "p-2", relation: "parent-child" },
      ],
    },
    dagMetrics: {
      nodeCount: 2,
      edgeCount: 1,
      maxDepth: 2,
      runningCount: 1,
      stalledCount: 1,
      deadCount: 0,
    },
    ipcSummary: {
      signalCount: 1,
      blackboardKeyCount: 2,
    },
    progressMetrics: {
      activeProcessCount: 1,
      stalledProcessCount: 1,
      totalTokensUsed: 84,
      tokenBudgetRemaining: 1916,
      wallTimeElapsedMs: 4_000,
      tickCount: 3,
    },
    recentEvents: [],
    recentHeuristics: [],
    blackboard: {},
    deferrals: [],
  };
}

function makeRun(overrides: Partial<KernelRun> = {}): KernelRun {
  const id = overrides.id ?? "run-1";
  return {
    id,
    status: overrides.status ?? "running",
    pid: overrides.pid ?? 12_345,
    createdAt: overrides.createdAt ?? "2026-03-06T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-06T00:00:01.000Z",
    startedAt: overrides.startedAt ?? "2026-03-06T00:00:01.000Z",
    command: overrides.command ?? "/usr/bin/node",
    args: overrides.args ?? ["dist/cli.js", "os"],
    input: overrides.input ?? {
      goal: "Write API tests first",
      cwd: "/repo",
      configPath: "/repo/kernel.toml",
      provider: "codex",
    },
    artifacts: overrides.artifacts ?? {
      runDir: `/tmp/runs/${id}`,
      runFilePath: `/tmp/runs/${id}/run.json`,
      outputPath: `/tmp/runs/${id}/output.json`,
      protocolLogPath: `/tmp/runs/${id}/protocol.ndjson`,
      livePath: `/tmp/runs/${id}/os-live.json`,
      snapshotPath: `/tmp/runs/${id}/os-snapshot.json`,
      stdoutPath: `/tmp/runs/${id}/stdout.log`,
      stderrPath: `/tmp/runs/${id}/stderr.log`,
    },
  };
}

function makeEvent(overrides: Partial<RuntimeProtocolEvent> = {}): RuntimeProtocolEvent {
  return {
    action: overrides.action ?? "os_process_spawn",
    status: overrides.status ?? "completed",
    timestamp: overrides.timestamp ?? "2026-03-06T00:00:02.000Z",
    agentId: overrides.agentId ?? "p-2",
    agentName: overrides.agentName ?? "phase1-test-builder",
    message: overrides.message ?? "spawned test worker",
    eventSource: overrides.eventSource ?? "os",
    objective: overrides.objective,
    attempt: overrides.attempt,
    dependencyIds: overrides.dependencyIds,
  };
}

function makeError(message: string, code: string, statusCode: number): ErrorWithCode {
  const error = new Error(message) as ErrorWithCode;
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

async function readSseChunk(response: Response, timeoutMs = 1_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel("timeout");
  }, timeoutMs);

  try {
    let combined = "";
    while (!timedOut) {
      const result = await reader.read();
      combined += new TextDecoder().decode(result.value ?? new Uint8Array());
      if (combined.includes("event: runtime") || result.done) {
        return combined;
      }
    }
    return combined;
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }
}

async function waitFor(
  predicate: () => boolean,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    message?: string;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(options.message ?? "Timed out while waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("runs API contract", () => {
  const servers: RunsApiServer[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await server?.close();
    }
  });

  test("POST /runs starts a run with default cwd and config path", async () => {
    const { server, runManager } = await startServer();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Map the repo topology",
        provider: "codex",
      }),
    });

    expect(response.status).toBe(201);
    expect(runManager.startRun).toHaveBeenCalledWith({
      goal: "Map the repo topology",
      provider: "codex",
      cwd: "/repo",
      configPath: "/repo/kernel.toml",
    });

    expect(await readJson(response)).toMatchObject({
      run: {
        status: "running",
        input: {
          goal: "Map the repo topology",
          cwd: "/repo",
          configPath: "/repo/kernel.toml",
        },
      },
    });
  });

  test("POST /runs rejects invalid payloads with a 422 VALIDATION_ERROR envelope", async () => {
    const { server } = await startServer();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "",
        unexpected: true,
      }),
    });

    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
      },
    });
  });

  test("POST /runs maps malformed JSON bodies to the 422 VALIDATION_ERROR envelope", async () => {
    const { server } = await startServer();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"goal\":",
    });

    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        details: {
          formErrors: ["Malformed JSON request body."],
        },
      },
    });
  });

  test("POST /runs rejects non-JSON content types with a 415 unsupported_media_type envelope", async () => {
    const { server } = await startServer();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "goal=plain-text",
    });

    expect(response.status).toBe(415);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "unsupported_media_type",
        message: "Expected application/json request body.",
      },
    });
  });

  test("POST /runs handles concurrent requests without collapsing state", async () => {
    const { server, runManager } = await startServer();
    servers.push(server);

    const [first, second] = await Promise.all([
      fetch(`${server.baseUrl}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "first run" }),
      }),
      fetch(`${server.baseUrl}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "second run" }),
      }),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(runManager.startRun).toHaveBeenCalledTimes(2);

    const [firstBody, secondBody] = await Promise.all([readJson(first), readJson(second)]);
    expect(firstBody).toMatchObject({ run: { id: "run-1" } });
    expect(secondBody).toMatchObject({ run: { id: "run-2" } });
  });

  test("GET /runs returns tracked runs", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-a", makeRun({ id: "run-a", createdAt: "2026-03-06T00:00:00.000Z" }));
    runManager.runs.set("run-b", makeRun({ id: "run-b", createdAt: "2026-03-06T00:00:01.000Z" }));

    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      runs: [
        { id: "run-a" },
        { id: "run-b" },
      ],
    });
  });

  test("GET /runs/:id returns 404 when the run does not exist", async () => {
    const { server } = await startServer();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/missing`);

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "run_not_found",
        message: "Run not found: missing",
      },
    });
  });

  test("GET /runs/:id returns the stored run document", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-123", makeRun({ id: "run-123", status: "paused" }));

    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-123`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      run: {
        id: "run-123",
        status: "paused",
      },
    });
  });

  test("GET /runs/:id/events returns JSON when the client does not request SSE", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-events", makeRun({ id: "run-events" }));
    runManager.events.set("run-events", [
      makeEvent(),
      makeEvent({ action: "os_snapshot", message: "tick=3" }),
    ]);

    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-events/events?limit=25`);

    expect(response.status).toBe(200);
    expect(runManager.getRunEvents).toHaveBeenCalledWith("run-events", { limit: 25 });
    expect(await readJson(response)).toMatchObject({
      events: [
        { action: "os_process_spawn" },
        { action: "os_snapshot" },
      ],
    });
  });

  test("GET /runs/:id/events validates query parameters and maps invalid limits to 422", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-events-invalid-limit", makeRun({ id: "run-events-invalid-limit" }));
    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-events-invalid-limit/events?limit=0`);

    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
      },
    });
  });

  test("GET /runs/:id/events upgrades to SSE and streams snapshot plus live events", async () => {
    const runManager = new FakeRunManager();
    const runtimeAdapter = new FakeRuntimeAdapter();
    runManager.runs.set("run-sse", makeRun({ id: "run-sse" }));
    runManager.events.set("run-sse", [makeEvent({ action: "os_tick", message: "tick=2" })]);

    const { server } = await startServer({ runManager, runtimeAdapter });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-sse/events`, {
      headers: {
        accept: "text/event-stream",
      },
    });

    runtimeAdapter.emit("run-sse", makeEvent({ action: "os_snapshot", message: "tick=3" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const chunk = await readSseChunk(response);
    expect(chunk).toContain("event: snapshot");
    expect(chunk).toContain("\"action\":\"os_tick\"");
    expect(chunk).toContain("event: runtime");
    expect(chunk).toContain("\"action\":\"os_snapshot\"");
  });

  test("GET /runs/:id/events honors SSE accept headers even without a live subscription", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-sse-snapshot", makeRun({ id: "run-sse-snapshot" }));
    runManager.events.set("run-sse-snapshot", [makeEvent({ action: "os_tick", message: "tick=7" })]);

    const { server } = await startServer({ runManager, runtimeAdapter: undefined });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-sse-snapshot/events`, {
      headers: {
        accept: "text/event-stream",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const chunk = await readSseChunk(response);
    expect(chunk).toContain("event: snapshot");
    expect(chunk).toContain("\"runId\":\"run-sse-snapshot\"");
    expect(chunk).toContain("\"action\":\"os_tick\"");
    expect(chunk).not.toContain("event: runtime");
  });

  test("GET /runs/:id/events handles concurrent SSE subscribers without cross-stream loss", async () => {
    const runManager = new FakeRunManager();
    const runtimeAdapter = new FakeRuntimeAdapter();
    runManager.runs.set("run-sse-concurrent", makeRun({ id: "run-sse-concurrent" }));
    runManager.events.set("run-sse-concurrent", [makeEvent({ action: "os_tick", message: "tick=10" })]);

    const { server } = await startServer({ runManager, runtimeAdapter });
    servers.push(server);

    const [firstResponse, secondResponse] = await Promise.all([
      fetch(`${server.baseUrl}/runs/run-sse-concurrent/events`, {
        headers: { accept: "text/event-stream" },
      }),
      fetch(`${server.baseUrl}/runs/run-sse-concurrent/events`, {
        headers: { accept: "text/event-stream" },
      }),
    ]);

    await waitFor(
      () => runtimeAdapter.subscriptions.filter((subscription) => subscription.runId === "run-sse-concurrent").length === 2,
      { message: "Expected two active SSE subscriptions." },
    );
    runtimeAdapter.emit("run-sse-concurrent", makeEvent({ action: "os_snapshot", message: "tick=11" }));

    const [firstChunk, secondChunk] = await Promise.all([readSseChunk(firstResponse), readSseChunk(secondResponse)]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstChunk).toContain("event: snapshot");
    expect(secondChunk).toContain("event: snapshot");
    expect(firstChunk).toContain("event: runtime");
    expect(secondChunk).toContain("event: runtime");
  });

  test("GET /runs/:id/topology returns a topology payload built from live state", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-topology", makeRun({ id: "run-topology" }));
    runManager.snapshots.set("run-topology", makeSnapshot("run-topology"));

    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-topology/topology`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      run: {
        id: "run-topology",
        status: "running",
      },
      stateSource: "live",
      topology: {
        runId: "run-topology",
        summary: {
          processCount: 2,
        },
      },
    });
  });

  test("GET /runs/:id/topology maps state availability errors to 409", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-topology", makeRun({ id: "run-topology", status: "running" }));
    runManager.getRunState.mockRejectedValueOnce(
      makeError("Live state unavailable for active run run-topology.", "STATE_UNAVAILABLE", 409),
    );

    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-topology/topology`);

    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "state_unavailable",
      },
    });
  });

  test("GET /runs/:id/topology returns snapshot-derived topology for completed runs", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-topology-completed", makeRun({ id: "run-topology-completed", status: "completed" }));
    runManager.getRunState.mockResolvedValueOnce({
      snapshot: makeSnapshot("run-topology-completed"),
      source: "snapshot",
    });

    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-topology-completed/topology`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      run: { id: "run-topology-completed", status: "completed" },
      stateSource: "snapshot",
      topology: { runId: "run-topology-completed" },
    });
  });

  test("GET /runs/:id/events maps unexpected dependency failures to 500 internal_error", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-events-error", makeRun({ id: "run-events-error" }));
    runManager.getRunEvents.mockRejectedValueOnce(new Error("unexpected failure"));
    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-events-error/events`);

    expect(response.status).toBe(500);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "internal_error",
        message: "unexpected failure",
      },
    });
  });

  test("DELETE /runs/:id cancels the run and returns the updated document", async () => {
    const runManager = new FakeRunManager();
    runManager.runs.set("run-delete", makeRun({ id: "run-delete" }));

    const { server } = await startServer({ runManager });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/runs/run-delete`, {
      method: "DELETE",
    });

    expect(response.status).toBe(202);
    expect(runManager.cancelRun).toHaveBeenCalledWith("run-delete");
    expect(await readJson(response)).toMatchObject({
      run: {
        id: "run-delete",
        status: "canceled",
      },
    });
  });
});
