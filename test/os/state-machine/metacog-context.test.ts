import { describe, expect, test } from "vitest";
import { buildMetacogContextPure } from "../../../src/os/state-machine/metacog-context.js";
import { initialState, type KernelState } from "../../../src/os/state-machine/state.js";
import { parseOsConfig } from "../../../src/os/config.js";
import type { OsProcess } from "../../../src/os/types.js";

/** Helper: create a minimal KernelState for testing. */
function makeState(overrides?: Partial<KernelState>): KernelState {
  const config = parseOsConfig({ enabled: true });
  return { ...initialState(config, "run-test"), ...overrides };
}

/** Helper: create a minimal OsProcess. */
function makeProcess(overrides?: Partial<OsProcess>): OsProcess {
  return {
    pid: "p1",
    type: "lifecycle",
    state: "running",
    name: "test-proc",
    parentPid: null,
    objective: "test objective",
    priority: 5,
    spawnedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    tickCount: 0,
    tokensUsed: 0,
    model: "gpt-4",
    workingDir: "/tmp",
    children: [],
    onParentDeath: "orphan",
    restartPolicy: "never",
    ...overrides,
  };
}

describe("buildMetacogContextPure", () => {
  test("produces MetacogContext from KernelState", () => {
    const state = makeState({ tickCount: 5, lastMetacogTick: 3 });
    const ctx = buildMetacogContextPure(state);

    // Should have all required MetacogContext fields
    expect(ctx).toHaveProperty("ticksSinceLastEval");
    expect(ctx).toHaveProperty("processEvents");
    expect(ctx).toHaveProperty("ipcActivity");
    expect(ctx).toHaveProperty("dagDelta");
    expect(ctx).toHaveProperty("progressMetrics");
    expect(ctx).toHaveProperty("relevantHeuristics");

    // processEvents should be empty array (snapshot-based, no mutable event buffer)
    expect(ctx.processEvents).toEqual([]);
  });

  test("computes ticksSinceLastEval correctly", () => {
    const ctx1 = buildMetacogContextPure(makeState({ tickCount: 10, lastMetacogTick: 3 }));
    expect(ctx1.ticksSinceLastEval).toBe(7);

    const ctx2 = buildMetacogContextPure(makeState({ tickCount: 0, lastMetacogTick: 0 }));
    expect(ctx2.ticksSinceLastEval).toBe(0);

    const ctx3 = buildMetacogContextPure(makeState({ tickCount: 42, lastMetacogTick: 42 }));
    expect(ctx3.ticksSinceLastEval).toBe(0);
  });

  test("returns undefined trigger when no pending triggers", () => {
    const state = makeState({ pendingTriggers: [] });
    const ctx = buildMetacogContextPure(state);
    expect(ctx.trigger).toBeUndefined();
  });

  test("returns first trigger when triggers present", () => {
    const state = makeState({
      pendingTriggers: ["process_failed", "goal_drift", "tick_stall"],
    });
    const ctx = buildMetacogContextPure(state);
    expect(ctx.trigger).toBe("process_failed");
  });

  test("includes process count in progressMetrics", () => {
    const processes = new Map<string, OsProcess>();
    processes.set("p1", makeProcess({ pid: "p1", state: "running", tokensUsed: 100 }));
    processes.set("p2", makeProcess({ pid: "p2", state: "running", tokensUsed: 200 }));
    processes.set("p3", makeProcess({ pid: "p3", state: "sleeping", tokensUsed: 50 }));
    processes.set("p4", makeProcess({ pid: "p4", state: "idle", tokensUsed: 10 }));
    processes.set("p5", makeProcess({ pid: "p5", state: "dead", tokensUsed: 500 }));

    const state = makeState({
      processes,
      tickCount: 20,
      startTime: Date.now() - 5000,
    });
    const ctx = buildMetacogContextPure(state);

    expect(ctx.progressMetrics.activeProcessCount).toBe(2);
    expect(ctx.progressMetrics.stalledProcessCount).toBe(2);
    expect(ctx.progressMetrics.totalTokensUsed).toBe(860);
    expect(ctx.progressMetrics.tickCount).toBe(20);
    expect(ctx.progressMetrics.wallTimeElapsedMs).toBeGreaterThanOrEqual(4000);
  });

  test("includes blackboard value summaries (truncated to 200 chars)", () => {
    const blackboard = new Map([
      ["user:data", { value: "short value", writtenBy: "p1", version: 1 }],
      ["result:output", { value: "x".repeat(300), writtenBy: "p2", version: 1 }],
      ["progress:status", { value: { step: 1, total: 5 }, writtenBy: "p3", version: 1 }],
    ]);

    const state = makeState({ blackboard });
    const ctx = buildMetacogContextPure(state);

    expect(ctx.blackboardValueSummaries).toBeDefined();
    const summaries = ctx.blackboardValueSummaries!;

    // Short value should be included as-is
    expect(summaries["user:data"]).toBe("short value");

    // Long value should be truncated to 200 chars + "..."
    expect(summaries["result:output"]).toHaveLength(203); // 200 + "..."
    expect(summaries["result:output"]).toMatch(/^x+\.\.\.$/);

    // Object value should be JSON stringified
    expect(summaries["progress:status"]).toBe('{"step":1,"total":5}');
  });

  test("excludes system: prefixed blackboard keys from summaries", () => {
    const blackboard = new Map([
      ["user:data", { value: "keep me", writtenBy: "p1", version: 1 }],
      ["system:internal", { value: "skip me", writtenBy: "kernel", version: 1 }],
      ["system:metrics", { value: "also skip", writtenBy: "kernel", version: 2 }],
      ["result:output", { value: "keep me too", writtenBy: "p2", version: 1 }],
    ]);

    const state = makeState({ blackboard });
    const ctx = buildMetacogContextPure(state);

    expect(ctx.blackboardValueSummaries).toBeDefined();
    const summaries = ctx.blackboardValueSummaries!;

    expect(summaries).toHaveProperty("user:data");
    expect(summaries).toHaveProperty("result:output");
    expect(summaries).not.toHaveProperty("system:internal");
    expect(summaries).not.toHaveProperty("system:metrics");
  });

  test("builds ipcActivity from blackboard size", () => {
    const blackboard = new Map([
      ["key1", { value: "v1", writtenBy: "p1", version: 1 }],
      ["key2", { value: "v2", writtenBy: "p2", version: 1 }],
      ["key3", { value: "v3", writtenBy: "p3", version: 1 }],
    ]);

    const state = makeState({ blackboard });
    const ctx = buildMetacogContextPure(state);

    expect(ctx.ipcActivity.blackboardKeyCount).toBe(3);
    expect(ctx.ipcActivity.signalCount).toBe(0);
  });

  test("builds minimal zero dagDelta", () => {
    const state = makeState();
    const ctx = buildMetacogContextPure(state);

    expect(ctx.dagDelta.nodesAdded).toEqual([]);
    expect(ctx.dagDelta.nodesRemoved).toEqual([]);
    expect(ctx.dagDelta.edgesAdded).toEqual([]);
    expect(ctx.dagDelta.edgesRemoved).toEqual([]);
    expect(ctx.dagDelta.nodesUpdated).toEqual([]);
    expect(ctx.dagDelta.since).toBeDefined();
  });

  test("includes relevantHeuristics from schedulerHeuristics", () => {
    const heuristics = [
      {
        id: "h1",
        heuristic: "prefer lifecycle over daemon",
        confidence: 0.8,
        context: "scheduling",
        learnedAt: new Date().toISOString(),
        reinforcedAt: new Date().toISOString(),
        reinforcementCount: 3,
        source: { runId: "run-old" },
      },
    ];

    const state = makeState({ schedulerHeuristics: heuristics });
    const ctx = buildMetacogContextPure(state);

    expect(ctx.relevantHeuristics).toEqual(heuristics);
  });

  test("includes tokenBudgetRemaining in progressMetrics", () => {
    const processes = new Map<string, OsProcess>();
    processes.set("p1", makeProcess({ pid: "p1", tokensUsed: 1000 }));

    const config = parseOsConfig({ enabled: true });
    const state = makeState({ processes, config });
    const ctx = buildMetacogContextPure(state);

    expect(ctx.progressMetrics.tokenBudgetRemaining).toBe(
      config.kernel.tokenBudget - 1000,
    );
  });

  test("includes awareness state from KernelState", () => {
    const state = makeState({
      awarenessNotes: ["check process p1", "high token usage"],
    });

    const ctx = buildMetacogContextPure(state);

    expect(ctx.awarenessNotes).toEqual(["check process p1", "high token usage"]);
  });

  test("includes deferrals from state", () => {
    const deferrals = new Map([
      ["d1", {
        id: "d1",
        descriptor: { type: "lifecycle" as const, name: "deferred-proc", objective: "wait for data" },
        condition: { type: "blackboard_key_exists" as const, key: "data:ready" },
        registeredAt: new Date().toISOString(),
        registeredByTick: 5,
        reason: "waiting for upstream data",
      }],
    ]);

    const state = makeState({ deferrals, tickCount: 15 });
    const ctx = buildMetacogContextPure(state);

    expect(ctx.deferrals).toBeDefined();
    expect(ctx.deferrals).toHaveLength(1);
    expect(ctx.deferrals![0].id).toBe("d1");
    expect(ctx.deferrals![0].waitedTicks).toBe(10);
  });

  // killThresholdAdjustment and killEvalHistory removed from KernelState

  test("returns empty blackboardValueSummaries as undefined when no keys", () => {
    const state = makeState({ blackboard: new Map() });
    const ctx = buildMetacogContextPure(state);
    expect(ctx.blackboardValueSummaries).toBeUndefined();
  });

  test("computes sinceLastWakeSec from lastMetacogWakeAt", () => {
    const now = Date.now();
    const state = makeState({ lastMetacogWakeAt: now - 5000 });
    const ctx = buildMetacogContextPure(state);

    // Should be approximately 5 seconds (allow some tolerance for test execution time)
    expect(ctx.sinceLastWakeSec).toBeGreaterThanOrEqual(4);
    expect(ctx.sinceLastWakeSec).toBeLessThan(10);
  });

  test("sinceLastWakeSec is undefined when lastMetacogWakeAt is 0", () => {
    const state = makeState({ lastMetacogWakeAt: 0 });
    const ctx = buildMetacogContextPure(state);
    expect(ctx.sinceLastWakeSec).toBeUndefined();
  });
});
