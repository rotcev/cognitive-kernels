import { describe, expect, test, vi } from "vitest";
import { CognitiveKernelsControlPlane } from "../../src/mcp/control-plane.js";
import type { KernelRun, RuntimeProtocolEvent } from "../../src/types.js";
import type { OsProcess, OsSystemSnapshot } from "../../src/os/types.js";

function makeProcess(overrides: Partial<OsProcess>): OsProcess {
  return {
    pid: overrides.pid ?? "p-1",
    type: overrides.type ?? "lifecycle",
    state: overrides.state ?? "running",
    name: overrides.name ?? "orchestrator",
    parentPid: overrides.parentPid ?? null,
    objective: overrides.objective ?? "Coordinate the topology",
    priority: overrides.priority ?? 80,
    spawnedAt: overrides.spawnedAt ?? "2026-03-05T00:00:00.000Z",
    lastActiveAt: overrides.lastActiveAt ?? "2026-03-05T00:00:01.000Z",
    tickCount: overrides.tickCount ?? 4,
    tokensUsed: overrides.tokensUsed ?? 100,
    model: overrides.model ?? "gpt-5.3-codex",
    workingDir: overrides.workingDir ?? "/repo",
    children: overrides.children ?? [],
    onParentDeath: overrides.onParentDeath ?? "orphan",
    restartPolicy: overrides.restartPolicy ?? "never",
  };
}

function makeRun(overrides: Partial<KernelRun> = {}): KernelRun {
  return {
    id: overrides.id ?? "run-live",
    status: overrides.status ?? "running",
    pid: overrides.pid ?? 12_345,
    createdAt: overrides.createdAt ?? "2026-03-05T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-05T00:00:00.000Z",
    startedAt: overrides.startedAt ?? "2026-03-05T00:00:01.000Z",
    command: overrides.command ?? "/usr/bin/node",
    args: overrides.args ?? ["dist/cli.js", "os"],
    input: overrides.input ?? {
      goal: "Map the current topology",
      cwd: "/repo",
      configPath: "/repo/kernel.toml",
    },
    artifacts: overrides.artifacts ?? {
      runDir: "/tmp/runs/run-live",
      runFilePath: "/tmp/runs/run-live/run.json",
      outputPath: "/tmp/runs/run-live/output.json",
      protocolLogPath: "/tmp/runs/run-live/protocol.ndjson",
      livePath: "/tmp/runs/run-live/os-live.json",
      snapshotPath: "/tmp/runs/run-live/os-snapshot.json",
      stdoutPath: "/tmp/runs/run-live/stdout.log",
      stderrPath: "/tmp/runs/run-live/stderr.log",
    },
  };
}

function makeSnapshot(): OsSystemSnapshot {
  const orchestrator = makeProcess({
    pid: "p-1",
    name: "orchestrator",
    type: "lifecycle",
    state: "running",
    priority: 90,
    tokensUsed: 420,
    children: ["p-2", "p-3"],
  });
  const scout = makeProcess({
    pid: "p-2",
    name: "repo-scout",
    type: "event",
    state: "dead",
    parentPid: "p-1",
    priority: 85,
    tokensUsed: 110,
    objective: "Inspect the repository layout",
    children: [],
  });
  const synthesis = makeProcess({
    pid: "p-3",
    name: "synthesis",
    state: "idle",
    parentPid: "p-1",
    priority: 70,
    tokensUsed: 170,
    objective: "Synthesize scout findings into a plan",
    children: [],
  });
  const metacog = makeProcess({
    pid: "p-4",
    name: "metacog-daemon",
    type: "daemon",
    state: "idle",
    parentPid: null,
    priority: 40,
    tokensUsed: 55,
    children: [],
    objective: "Monitor the topology for drift",
  });

  return {
    runId: "run-live",
    tickCount: 7,
    goal: "Map the current topology",
    processes: [orchestrator, scout, synthesis, metacog],
    dagTopology: {
      nodes: [
        { pid: "p-1", name: "orchestrator", type: "lifecycle", state: "running", priority: 90, parentPid: null },
        { pid: "p-2", name: "repo-scout", type: "event", state: "dead", priority: 85, parentPid: "p-1" },
        { pid: "p-3", name: "synthesis", type: "lifecycle", state: "idle", priority: 70, parentPid: "p-1" },
        { pid: "p-4", name: "metacog-daemon", type: "daemon", state: "idle", priority: 40, parentPid: null },
      ],
      edges: [
        { from: "p-1", to: "p-2", relation: "parent-child" },
        { from: "p-1", to: "p-3", relation: "parent-child" },
        { from: "p-2", to: "p-3", relation: "dependency", label: "repo layout" },
      ],
    },
    dagMetrics: {
      nodeCount: 4,
      edgeCount: 3,
      maxDepth: 2,
      runningCount: 1,
      stalledCount: 2,
      deadCount: 1,
    },
    ipcSummary: {
      signalCount: 2,
      blackboardKeyCount: 5,
    },
    progressMetrics: {
      activeProcessCount: 1,
      stalledProcessCount: 2,
      totalTokensUsed: 755,
      tokenBudgetRemaining: 1245,
      wallTimeElapsedMs: 12_000,
      tickCount: 7,
    },
    recentEvents: [],
    recentHeuristics: [],
    blackboard: {
      "plan:repo-layout": "captured",
    },
    deferrals: [
      {
        id: "d-1",
        name: "verification",
        condition: { type: "blackboard_key_exists", key: "plan:repo-layout" },
        waitedTicks: 2,
        reason: "Waiting for the scout output",
      },
    ],
  };
}

function makeEvents(): RuntimeProtocolEvent[] {
  return [
    {
      action: "os_process_spawn",
      status: "completed",
      timestamp: "2026-03-05T00:00:01.000Z",
      agentId: "p-2",
      agentName: "repo-scout",
      message: "spawn scout",
      eventSource: "os",
    },
    {
      action: "os_tick",
      status: "completed",
      timestamp: "2026-03-05T00:00:02.000Z",
      message: "tick=1 ran=2",
      eventSource: "os",
    },
    {
      action: "os_snapshot",
      status: "completed",
      timestamp: "2026-03-05T00:00:03.000Z",
      message: "tick=2",
      eventSource: "os",
    },
  ];
}

describe("CognitiveKernelsControlPlane", () => {
  test("starts runs using default cwd and config", async () => {
    const startedRun = makeRun({ id: "run-started" });
    const runManager = {
      startRun: vi.fn(async () => startedRun),
      listRuns: vi.fn(() => [startedRun]),
      getRun: vi.fn(() => startedRun),
      getRunState: vi.fn(async () => ({ snapshot: makeSnapshot(), source: "live" as const })),
      getRunEvents: vi.fn(async () => makeEvents()),
      getRunLog: vi.fn(async () => ({
        runId: startedRun.id,
        stream: "stdout" as const,
        lines: [],
        totalLines: 0,
        nextAfterLine: 0,
        hasMore: false,
      })),
      pauseRun: vi.fn(async () => startedRun),
      resumeRun: vi.fn(async () => startedRun),
      cancelRun: vi.fn(async () => startedRun),
    };

    const controlPlane = new CognitiveKernelsControlPlane({
      runManager,
      defaultCwd: "/repo",
      defaultConfigPath: "/repo/kernel.toml",
    });

    const result = await controlPlane.callTool("start_run", {
      goal: "Map the current topology",
      provider: "codex",
    });

    expect(runManager.startRun).toHaveBeenCalledWith({
      goal: "Map the current topology",
      provider: "codex",
      cwd: "/repo",
      configPath: "/repo/kernel.toml",
    });

    expect(result.isError).toBeUndefined();
    expect((result as { structuredContent: { run: KernelRun } }).structuredContent.run.id).toBe("run-started");
  });

  test("renders a live topology view with dependencies and stalled processes", async () => {
    const run = makeRun();
    const snapshot = makeSnapshot();
    const runManager = {
      startRun: vi.fn(async () => run),
      listRuns: vi.fn(() => [run]),
      getRun: vi.fn(() => run),
      getRunState: vi.fn(async () => ({ snapshot, source: "live" as const })),
      getRunEvents: vi.fn(async () => makeEvents()),
      getRunLog: vi.fn(async () => ({
        runId: run.id,
        stream: "stdout" as const,
        lines: [],
        totalLines: 0,
        nextAfterLine: 0,
        hasMore: false,
      })),
      pauseRun: vi.fn(async () => run),
      resumeRun: vi.fn(async () => run),
      cancelRun: vi.fn(async () => run),
    };

    const controlPlane = new CognitiveKernelsControlPlane({
      runManager,
      defaultCwd: "/repo",
    });

    const result = await controlPlane.callTool("get_run_topology", { runId: run.id });
    const text = (result.content?.[0] as { text: string }).text;

    expect(text).toContain("Topology");
    expect(text).toContain("ROOT");
    expect(text).toContain("orchestrator (p-1)");
    expect(text).toContain("repo-scout (p-2) -> synthesis (p-3)");
    expect(text).toContain("High-priority stalled");
  });

  test("refuses archived-only state for active runs", async () => {
    const run = makeRun({ status: "running" });
    const runManager = {
      startRun: vi.fn(async () => run),
      listRuns: vi.fn(() => [run]),
      getRun: vi.fn(() => run),
      getRunState: vi.fn(async () => ({ snapshot: makeSnapshot(), source: "final" as const })),
      getRunEvents: vi.fn(async () => makeEvents()),
      getRunLog: vi.fn(async () => ({
        runId: run.id,
        stream: "stdout" as const,
        lines: [],
        totalLines: 0,
        nextAfterLine: 0,
        hasMore: false,
      })),
      pauseRun: vi.fn(async () => run),
      resumeRun: vi.fn(async () => run),
      cancelRun: vi.fn(async () => run),
    };

    const controlPlane = new CognitiveKernelsControlPlane({
      runManager,
      defaultCwd: "/repo",
    });

    await expect(controlPlane.callTool("get_run_dashboard", { runId: run.id })).rejects.toThrow(
      "Live state unavailable",
    );
  });

  test("lists and reads dashboard resources", async () => {
    const run = makeRun({ status: "completed" });
    const snapshot = makeSnapshot();
    const events = makeEvents();
    const runManager = {
      startRun: vi.fn(async () => run),
      listRuns: vi.fn(() => [run]),
      getRun: vi.fn(() => run),
      getRunState: vi.fn(async () => ({ snapshot, source: "final" as const })),
      getRunEvents: vi.fn(async () => events),
      getRunLog: vi.fn(async () => ({
        runId: run.id,
        stream: "protocol" as const,
        lines: [{ lineNumber: 1, text: "{\"action\":\"os_tick\"}" }],
        totalLines: 1,
        nextAfterLine: 1,
        hasMore: false,
      })),
      pauseRun: vi.fn(async () => run),
      resumeRun: vi.fn(async () => run),
      cancelRun: vi.fn(async () => run),
    };

    const controlPlane = new CognitiveKernelsControlPlane({
      runManager,
      defaultCwd: "/repo",
    });

    const resources = controlPlane.listResources();
    expect(resources.some((resource) => resource.uri.endsWith("/dashboard"))).toBe(true);
    expect(resources.some((resource) => resource.uri.endsWith("/state"))).toBe(true);

    const dashboardResource = resources.find((resource) => resource.uri.endsWith("/dashboard"));
    const dashboard = await controlPlane.readResource(dashboardResource?.uri ?? "");
    expect(dashboard.text).toContain("Current topology");

    const timelineResource = resources.find((resource) => resource.uri.endsWith("/timeline"));
    const timeline = await controlPlane.readResource(`${timelineResource?.uri ?? ""}?limit=2`);
    expect(timeline.text).toContain("structural events");
  });
});
