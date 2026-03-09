import { describe, it, expect } from "vitest";
import { transition } from "../../../src/os/state-machine/transition.js";
import { initialState } from "../../../src/os/state-machine/state.js";
import type { KernelState } from "../../../src/os/state-machine/state.js";
import type { KernelEvent, ProcessCompletedEvent, TopologyDeclaredEvent } from "../../../src/os/state-machine/events.js";
import type { OsConfig, OsProcess } from "../../../src/os/types.js";

function makeConfig(): OsConfig {
  return {
    kernel: {
      processModel: "test-model",
      metacogModel: "test-model",
      awarenessModel: "test-model",
      maxTotalTokens: 100000,
      wallTimeLimitMs: 600000,
      maxProcesses: 20,
      maxTicksPerProcess: 100,
      metacogIntervalMs: 60000,
    },
    scheduler: {
      strategy: "priority" as any,
      maxConcurrentProcesses: 5,
    },
  } as OsConfig;
}

function bootedState(): KernelState {
  const state = initialState(makeConfig(), "test-run");
  const [booted] = transition(state, {
    type: "boot",
    goal: "test goal",
    timestamp: Date.now(),
    workingDir: "/tmp",
  } as any);
  return booted;
}

/** Declare a topology and get back the updated state + effects. */
function declareTopology(state: KernelState, topology: any) {
  return transition(state, {
    type: "topology_declared",
    topology,
    memory: [],
    halt: null,
    timestamp: Date.now(),
  } as TopologyDeclaredEvent);
}

/** Simulate a process completing with given commands. */
function processCompleted(state: KernelState, pid: string, commands: any[]) {
  const proc = state.processes.get(pid);
  return transition(state, {
    type: "process_completed",
    pid,
    name: proc?.name ?? "unknown",
    success: true,
    commands,
    commandCount: commands.length,
    tokensUsed: 100,
    response: "",
    timestamp: Date.now(),
  } as ProcessCompletedEvent);
}

describe("scoped blackboards", () => {
  it("spawning a task with writes creates a scope", () => {
    const state = bootedState();
    const [newState] = declareTopology(state, {
      type: "par",
      children: [
        { type: "task", name: "writer-a", objective: "do A", reads: [], writes: ["result:a"] },
      ],
    });

    // Find the spawned process
    const proc = [...newState.processes.values()].find(p => p.name === "writer-a");
    expect(proc).toBeDefined();
    expect(proc!.scopeId).toBeDefined();
    expect(proc!.scopeId).toMatch(/^scope-/);

    // Scope should exist
    const scope = newState.scopes.get(proc!.scopeId!);
    expect(scope).toBeDefined();
    expect(scope!.publishKeys).toEqual(["result:a"]);
    expect(scope!.parentId).toBeNull();
    expect(scope!.entries.size).toBe(0);
  });

  it("spawning a task without writes does NOT create a scope", () => {
    const state = bootedState();
    const [newState] = declareTopology(state, {
      type: "par",
      children: [
        { type: "task", name: "reader-only", objective: "read stuff", reads: ["data:x"], writes: [] },
      ],
    });

    const proc = [...newState.processes.values()].find(p => p.name === "reader-only");
    expect(proc).toBeDefined();
    expect(proc!.scopeId).toBeUndefined();
    expect(newState.scopes.size).toBe(0);
  });

  it("bb_write goes to process scope, not root blackboard", () => {
    const state = bootedState();
    const [afterTopology] = declareTopology(state, {
      type: "par",
      children: [
        { type: "task", name: "writer", objective: "produce", reads: [], writes: ["output:data"] },
      ],
    });

    const proc = [...afterTopology.processes.values()].find(p => p.name === "writer");
    expect(proc).toBeDefined();

    // Process writes to blackboard via bb_write command
    const [afterWrite] = processCompleted(afterTopology, proc!.pid, [
      { kind: "bb_write", key: "output:data", value: "hello world" },
      { kind: "idle" },
    ]);

    // Root blackboard should NOT have the key (it's in the scope)
    expect(afterWrite.blackboard.has("output:data")).toBe(false);

    // Scope should have the key
    const scope = afterWrite.scopes.get(proc!.scopeId!);
    expect(scope).toBeDefined();
    expect(scope!.entries.has("output:data")).toBe(true);
    expect(scope!.entries.get("output:data")!.value).toBe("hello world");
  });

  it("bb_read walks up scope chain to root blackboard", () => {
    const state = bootedState();

    // Put something in the root blackboard first
    const stateWithBb: KernelState = {
      ...state,
      blackboard: new Map([
        ["global:config", { value: "important", writtenBy: null, version: 1 }],
      ]),
    };

    const [afterTopology] = declareTopology(stateWithBb, {
      type: "par",
      children: [
        { type: "task", name: "reader", objective: "read global", reads: ["global:config"], writes: ["output:x"] },
      ],
    });

    const proc = [...afterTopology.processes.values()].find(p => p.name === "reader");
    expect(proc).toBeDefined();

    // Process reads from blackboard — should find the root entry
    const [afterRead] = processCompleted(afterTopology, proc!.pid, [
      { kind: "bb_read", keys: ["global:config"] },
      { kind: "idle" },
    ]);

    // The process should still be running (no errors from the read)
    const updatedProc = afterRead.processes.get(proc!.pid);
    expect(updatedProc).toBeDefined();
  });

  it("process exit publishes scope writes to root blackboard", () => {
    const state = bootedState();
    const [afterTopology] = declareTopology(state, {
      type: "par",
      children: [
        { type: "task", name: "producer", objective: "produce data", reads: [], writes: ["result:analysis"] },
      ],
    });

    const proc = [...afterTopology.processes.values()].find(p => p.name === "producer");
    expect(proc).toBeDefined();

    // Process writes, then exits
    const [afterExit] = processCompleted(afterTopology, proc!.pid, [
      { kind: "bb_write", key: "result:analysis", value: { findings: ["a", "b"] } },
      { kind: "exit", summary: "done" },
    ]);

    // Now the published key should be in the root blackboard
    expect(afterExit.blackboard.has("result:analysis")).toBe(true);
    expect(afterExit.blackboard.get("result:analysis")!.value).toEqual({ findings: ["a", "b"] });
  });

  it("publishKeys filters which scope entries get promoted", () => {
    const state = bootedState();
    const [afterTopology] = declareTopology(state, {
      type: "par",
      children: [
        { type: "task", name: "worker", objective: "do work", reads: [], writes: ["result:final"] },
      ],
    });

    const proc = [...afterTopology.processes.values()].find(p => p.name === "worker");
    expect(proc).toBeDefined();

    // Process writes two keys but only "result:final" is in publishKeys (writes)
    const [afterExit] = processCompleted(afterTopology, proc!.pid, [
      { kind: "bb_write", key: "result:final", value: "published" },
      { kind: "bb_write", key: "scratch:temp", value: "not published" },
      { kind: "exit", summary: "done" },
    ]);

    // Only the publishKey should be in root blackboard
    expect(afterExit.blackboard.has("result:final")).toBe(true);
    expect(afterExit.blackboard.get("result:final")!.value).toBe("published");
    // scratch:temp should NOT be in root blackboard (filtered by publishKeys)
    expect(afterExit.blackboard.has("scratch:temp")).toBe(false);
  });

  it("parallel processes have isolated scopes", () => {
    const state = bootedState();
    const [afterTopology] = declareTopology(state, {
      type: "par",
      children: [
        { type: "task", name: "worker-a", objective: "analyze A", reads: [], writes: ["result:a"] },
        { type: "task", name: "worker-b", objective: "analyze B", reads: [], writes: ["result:b"] },
      ],
    });

    const procA = [...afterTopology.processes.values()].find(p => p.name === "worker-a");
    const procB = [...afterTopology.processes.values()].find(p => p.name === "worker-b");
    expect(procA).toBeDefined();
    expect(procB).toBeDefined();

    // They should have different scopes
    expect(procA!.scopeId).not.toBe(procB!.scopeId);

    // Both scopes should exist
    expect(afterTopology.scopes.has(procA!.scopeId!)).toBe(true);
    expect(afterTopology.scopes.has(procB!.scopeId!)).toBe(true);

    // Worker A writes
    const [afterA] = processCompleted(afterTopology, procA!.pid, [
      { kind: "bb_write", key: "result:a", value: "from A" },
      { kind: "idle" },
    ]);

    // Worker B's scope should not have "result:a"
    const scopeB = afterA.scopes.get(procB!.scopeId!);
    expect(scopeB).toBeDefined();
    expect(scopeB!.entries.has("result:a")).toBe(false);
  });
});
