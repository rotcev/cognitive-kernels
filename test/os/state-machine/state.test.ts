import { describe, expect, test } from "vitest";
import { initialState, type KernelState, type BlackboardEntry } from "../../../src/os/state-machine/state.js";
import { parseOsConfig } from "../../../src/os/config.js";

describe("KernelState", () => {
  test("initialState produces valid defaults", () => {
    const config = parseOsConfig({ enabled: true });
    const state = initialState(config, "run-123");

    expect(state.goal).toBe("");
    expect(state.runId).toBe("run-123");
    expect(state.config).toBe(config);

    expect(state.processes.size).toBe(0);
    expect(state.inflight.size).toBe(0);
    expect(state.activeEphemeralCount).toBe(0);

    expect(state.blackboard.size).toBe(0);
    expect(state.tickCount).toBe(0);
    expect(state.dagTopology.nodes).toHaveLength(0);
    expect(state.dagTopology.edges).toHaveLength(0);
    expect(state.deferrals.size).toBe(0);
    expect(state.pendingTriggers).toHaveLength(0);

    expect(state.halted).toBe(false);
    expect(state.haltReason).toBeNull();
    expect(state.goalWorkDoneAt).toBe(0);
    expect(state.startTime).toBe(0);
    expect(state.consecutiveIdleTicks).toBe(0);
    expect(state.lastProcessCompletionTime).toBe(0);
    expect(state.housekeepCount).toBe(0);
  });

  test("KernelState type is constructable with all fields", () => {
    const config = parseOsConfig({ enabled: true });
    const state: KernelState = {
      goal: "test goal",
      runId: "run-456",
      config,
      processes: new Map([["p1", {
        pid: "p1",
        type: "lifecycle",
        state: "running",
        name: "test-proc",
        parentPid: null,
        objective: "test",
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
      }]]),
      inflight: new Set(["p1"]),
      activeEphemeralCount: 1,
      blackboard: new Map([["key1", { value: "val", writtenBy: "p1", version: 1 }]]),
      tickCount: 5,
      dagTopology: { nodes: [], edges: [] },
      deferrals: new Map(),
      pendingTriggers: [],
      halted: false,
      haltReason: null,
      goalWorkDoneAt: 0,
      startTime: Date.now(),
      consecutiveIdleTicks: 0,
      lastProcessCompletionTime: 0,
      housekeepCount: 3,
    };

    expect(state.processes.size).toBe(1);
    expect(state.inflight.has("p1")).toBe(true);
    expect(state.blackboard.get("key1")?.value).toBe("val");
  });

  test("BlackboardEntry type works with various value types", () => {
    const entries: BlackboardEntry[] = [
      { value: "string value", writtenBy: "p1", version: 1 },
      { value: 42, writtenBy: "p2", version: 2 },
      { value: { nested: true }, writtenBy: null, version: 0 },
      { value: ["array", "value"], writtenBy: "p3", version: 3 },
    ];

    expect(entries).toHaveLength(4);
    expect(entries[2].writtenBy).toBeNull();
  });
});
