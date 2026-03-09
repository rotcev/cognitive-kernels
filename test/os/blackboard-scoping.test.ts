import { describe, it, expect } from "vitest";
import { getUpstreamAncestorNames, buildUpstreamContext } from "../../src/os/kernel-interpreter.js";
import type { KernelState } from "../../src/os/state-machine/state.js";
import type { OsProcess, OsDagTopology } from "../../src/os/types.js";

/** Minimal proc stub. */
function proc(pid: string, name: string): OsProcess {
  return { pid, name, state: "running", type: "lifecycle", objective: "", priority: 50 } as OsProcess;
}

/** Minimal state stub with dag + blackboard. */
function makeState(overrides: {
  dag?: OsDagTopology;
  blackboard?: Map<string, { value: unknown; writtenBy: string | null; version: number }>;
  processes?: Map<string, OsProcess>;
}): KernelState {
  return {
    goal: "test",
    runId: "run-1",
    config: {} as any,
    processes: overrides.processes ?? new Map(),
    inflight: new Set(),
    activeEphemeralCount: 0,
    blackboard: overrides.blackboard ?? new Map(),
    tickCount: 0,
    schedulerStrategy: "priority",
    schedulerMaxConcurrent: 4,
    schedulerRoundRobinIndex: 0,
    schedulerHeuristics: [],
    currentStrategies: [],
    dagTopology: overrides.dag ?? { nodes: [], edges: [] },
    deferrals: new Map(),
    pendingTriggers: [],
    lastMetacogTick: 0,
    metacogEvalCount: 0,
    activeStrategyId: null,
    matchedStrategyIds: new Set(),
    metacogInflight: false,
    lastMetacogWakeAt: 0,
    metacogHistory: [],
    awarenessNotes: [],
    drainingPids: new Set(),
    ephemeralStats: { spawns: 0, successes: 0, failures: 0, totalDurationMs: 0 },
    halted: false,
    haltReason: null,
    goalWorkDoneAt: 0,
    startTime: Date.now(),
    lastProcessCompletionTime: 0,
    housekeepCount: 0,
  } as KernelState;
}

// ─── getUpstreamAncestorNames ───────────────────────────────────

describe("getUpstreamAncestorNames", () => {
  it("returns null when DAG has no edges", () => {
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "a", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [],
      },
    });
    expect(getUpstreamAncestorNames(state, proc("p1", "a"))).toBeNull();
  });

  it("returns null when DAG has only parent-child edges (no dependency edges)", () => {
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "orchestrator", type: "lifecycle", state: "running", priority: 50, parentPid: null },
          { pid: "p2", name: "worker-a", type: "lifecycle", state: "running", priority: 50, parentPid: "p1" },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "parent-child" },
        ],
      },
    });
    expect(getUpstreamAncestorNames(state, proc("p2", "worker-a"))).toBeNull();
  });

  it("returns direct upstream ancestor", () => {
    // research → write-report
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "research", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "write-report", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
        ],
      },
    });
    const result = getUpstreamAncestorNames(state, proc("p2", "write-report"));
    expect(result).toEqual(new Set(["research"]));
  });

  it("returns transitive ancestors through chain", () => {
    // a → b → c
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "a", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "b", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p3", name: "c", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
          { from: "p2", to: "p3", relation: "dependency" },
        ],
      },
    });
    const result = getUpstreamAncestorNames(state, proc("p3", "c"));
    expect(result).toEqual(new Set(["a", "b"]));
  });

  it("returns multiple direct ancestors (fan-in)", () => {
    // research-market ──┐
    //                    ├──► write-report
    // research-tech   ──┘
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "research-market", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "research-tech", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p3", name: "write-report", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p3", relation: "dependency" },
          { from: "p2", to: "p3", relation: "dependency" },
        ],
      },
    });
    const result = getUpstreamAncestorNames(state, proc("p3", "write-report"));
    expect(result).toEqual(new Set(["research-market", "research-tech"]));
  });

  it("excludes unrelated siblings", () => {
    // research ──► write-report
    // analyze-competitors (independent)
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "research", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "write-report", type: "lifecycle", state: "running", priority: 50, parentPid: null },
          { pid: "p3", name: "analyze-competitors", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
        ],
      },
    });
    const result = getUpstreamAncestorNames(state, proc("p2", "write-report"));
    expect(result).toEqual(new Set(["research"]));
    expect(result!.has("analyze-competitors")).toBe(false);
  });

  it("handles diamond DAG (no duplicate traversal)", () => {
    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "a", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "b", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p3", name: "c", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p4", name: "d", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
          { from: "p1", to: "p3", relation: "dependency" },
          { from: "p2", to: "p4", relation: "dependency" },
          { from: "p3", to: "p4", relation: "dependency" },
        ],
      },
    });
    const result = getUpstreamAncestorNames(state, proc("p4", "d"));
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("returns empty set for entry node with dependency edges elsewhere", () => {
    // a → b (asking for a's ancestors — should be empty, not null)
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "a", type: "lifecycle", state: "running", priority: 50, parentPid: null },
          { pid: "p2", name: "b", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
        ],
      },
    });
    const result = getUpstreamAncestorNames(state, proc("p1", "a"));
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });
});

// ─── buildUpstreamContext ───────────────────────────────────────

describe("buildUpstreamContext", () => {
  it("returns empty string when blackboard has no result/shell/mcp keys", () => {
    const state = makeState({
      blackboard: new Map([
        ["system:design-guidelines", { value: "some guidelines", writtenBy: null, version: 1 }],
      ]),
    });
    expect(buildUpstreamContext(state, proc("p1", "worker-a"))).toBe("");
  });

  it("includes result keys from other workers (no DAG = global)", () => {
    const state = makeState({
      blackboard: new Map([
        ["result:worker-b", { value: "b's findings", writtenBy: "p2", version: 1 }],
        ["result:worker-c", { value: "c's findings", writtenBy: "p3", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p1", "worker-a"));
    expect(ctx).toContain("result:worker-b");
    expect(ctx).toContain("b's findings");
    expect(ctx).toContain("result:worker-c");
    expect(ctx).toContain("c's findings");
  });

  it("excludes own result key", () => {
    const state = makeState({
      blackboard: new Map([
        ["result:worker-a", { value: "my own result", writtenBy: "p1", version: 1 }],
        ["result:worker-b", { value: "other result", writtenBy: "p2", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p1", "worker-a"));
    expect(ctx).not.toContain("result:worker-a");
    expect(ctx).toContain("result:worker-b");
  });

  it("excludes shell:exit: keys", () => {
    const state = makeState({
      blackboard: new Map([
        ["shell:exit:ls-proc", { value: "0", writtenBy: "p2", version: 1 }],
        ["shell:ls-proc:stdout", { value: "file1\nfile2", writtenBy: "p2", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p1", "worker-a"));
    expect(ctx).not.toContain("shell:exit:");
    expect(ctx).toContain("shell:ls-proc:stdout");
  });

  it("caps long values at 1000 chars", () => {
    const longValue = "x".repeat(2000);
    const state = makeState({
      blackboard: new Map([
        ["result:worker-b", { value: longValue, writtenBy: "p2", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p1", "worker-a"));
    expect(ctx).toContain("...");
    // Should not contain the full 2000-char value
    expect(ctx.length).toBeLessThan(2000);
  });

  it("includes shell and mcp keys", () => {
    const state = makeState({
      blackboard: new Map([
        ["shell:ls-proc:stdout", { value: "file listing", writtenBy: "p2", version: 1 }],
        ["mcp:browser:get_page_info", { value: "page content", writtenBy: "p3", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p1", "worker-a"));
    expect(ctx).toContain("shell:ls-proc:stdout");
    expect(ctx).toContain("mcp:browser:get_page_info");
  });

  // ─── DAG-scoped tests ──────────────────────────────────────────

  it("only includes results from DAG ancestors when dependency edges exist", () => {
    // research → write-report, analyze-competitors is independent
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "research", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "write-report", type: "lifecycle", state: "running", priority: 50, parentPid: null },
          { pid: "p3", name: "analyze-competitors", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
        ],
      },
      blackboard: new Map([
        ["result:research", { value: "market data", writtenBy: "p1", version: 1 }],
        ["result:analyze-competitors", { value: "competitor data", writtenBy: "p3", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p2", "write-report"));
    expect(ctx).toContain("result:research");
    expect(ctx).toContain("market data");
    expect(ctx).not.toContain("result:analyze-competitors");
    expect(ctx).not.toContain("competitor data");
  });

  it("includes transitive ancestor results in chain", () => {
    // a → b → c — c should see both a and b
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "a", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "b", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p3", name: "c", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
          { from: "p2", to: "p3", relation: "dependency" },
        ],
      },
      blackboard: new Map([
        ["result:a", { value: "a-output", writtenBy: "p1", version: 1 }],
        ["result:b", { value: "b-output", writtenBy: "p2", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p3", "c"));
    expect(ctx).toContain("result:a");
    expect(ctx).toContain("result:b");
  });

  it("DAG-scoped: entry node sees nothing even when siblings have results", () => {
    // a → b, asking for a (entry node)
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "a", type: "lifecycle", state: "running", priority: 50, parentPid: null },
          { pid: "p2", name: "b", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
        ],
      },
      blackboard: new Map([
        ["result:b", { value: "b-output", writtenBy: "p2", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p1", "a"));
    expect(ctx).toBe("");
  });

  it("DAG-scoped: includes shell/mcp keys scoped to ancestor names", () => {
    // research → report
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "research", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "report", type: "lifecycle", state: "running", priority: 50, parentPid: null },
          { pid: "p3", name: "unrelated", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
        ],
      },
      blackboard: new Map([
        ["shell:research:stdout", { value: "ls output from research", writtenBy: "p1", version: 1 }],
        ["mcp:research:browser_navigate", { value: "page data", writtenBy: "p1", version: 1 }],
        ["shell:unrelated:stdout", { value: "unrelated shell", writtenBy: "p3", version: 1 }],
        ["mcp:unrelated:some_tool", { value: "unrelated mcp", writtenBy: "p3", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p2", "report"));
    expect(ctx).toContain("shell:research:stdout");
    expect(ctx).toContain("mcp:research:browser_navigate");
    expect(ctx).not.toContain("shell:unrelated:stdout");
    expect(ctx).not.toContain("mcp:unrelated:some_tool");
  });

  it("falls back to global when only parent-child edges exist (no dependency edges)", () => {
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "orchestrator", type: "lifecycle", state: "running", priority: 50, parentPid: null },
          { pid: "p2", name: "worker-a", type: "lifecycle", state: "running", priority: 50, parentPid: "p1" },
          { pid: "p3", name: "worker-b", type: "lifecycle", state: "dead", priority: 50, parentPid: "p1" },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "parent-child" },
          { from: "p1", to: "p3", relation: "parent-child" },
        ],
      },
      blackboard: new Map([
        ["result:worker-b", { value: "b's work", writtenBy: "p3", version: 1 }],
      ]),
    });
    // No dependency edges → global fallback → worker-a sees worker-b's result
    const ctx = buildUpstreamContext(state, proc("p2", "worker-a"));
    expect(ctx).toContain("result:worker-b");
  });

  it("diamond DAG: downstream sees all ancestors", () => {
    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    const state = makeState({
      dag: {
        nodes: [
          { pid: "p1", name: "a", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p2", name: "b", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p3", name: "c", type: "lifecycle", state: "dead", priority: 50, parentPid: null },
          { pid: "p4", name: "d", type: "lifecycle", state: "running", priority: 50, parentPid: null },
        ],
        edges: [
          { from: "p1", to: "p2", relation: "dependency" },
          { from: "p1", to: "p3", relation: "dependency" },
          { from: "p2", to: "p4", relation: "dependency" },
          { from: "p3", to: "p4", relation: "dependency" },
        ],
      },
      blackboard: new Map([
        ["result:a", { value: "root data", writtenBy: "p1", version: 1 }],
        ["result:b", { value: "b data", writtenBy: "p2", version: 1 }],
        ["result:c", { value: "c data", writtenBy: "p3", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p4", "d"));
    expect(ctx).toContain("result:a");
    expect(ctx).toContain("result:b");
    expect(ctx).toContain("result:c");
  });

  it("serializes non-string blackboard values as JSON", () => {
    const state = makeState({
      blackboard: new Map([
        ["result:worker-b", { value: { findings: [1, 2, 3] }, writtenBy: "p2", version: 1 }],
      ]),
    });
    const ctx = buildUpstreamContext(state, proc("p1", "worker-a"));
    expect(ctx).toContain('"findings"');
    expect(ctx).toContain("[1,2,3]");
  });
});
