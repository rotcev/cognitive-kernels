import { describe, expect, test } from "vitest";
import { transition, type TransitionResult } from "../../../src/os/state-machine/transition.js";
import { initialState, type KernelState } from "../../../src/os/state-machine/state.js";
import type { KernelEvent } from "../../../src/os/state-machine/events.js";
import { parseOsConfig } from "../../../src/os/config.js";

function makeState(overrides?: Partial<Parameters<typeof parseOsConfig>[0]["kernel"]>): KernelState {
  const config = parseOsConfig({
    enabled: true,
    kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000, ...overrides },
  });
  return initialState(config, "test-run");
}

function bootEvent(goal = "test goal"): KernelEvent {
  return { type: "boot", goal, timestamp: Date.now(), seq: 0 };
}

function haltCheckEvent(seq = 1): KernelEvent {
  return { type: "halt_check", result: false, reason: null, timestamp: Date.now(), seq };
}

describe("transition — boot", () => {
  test("boot sets goal on state", () => {
    const state = makeState();
    const [newState] = transition(state, bootEvent("build a calculator"));

    expect(newState.goal).toBe("build a calculator");
  });

  test("boot creates goal-orchestrator and metacog-daemon processes", () => {
    const state = makeState();
    const [newState] = transition(state, bootEvent());

    expect(newState.processes.size).toBe(2);

    const procs = [...newState.processes.values()];
    const orchestrator = procs.find(p => p.name === "goal-orchestrator");
    const metacog = procs.find(p => p.name === "metacog-daemon");

    expect(orchestrator).toBeDefined();
    expect(orchestrator!.type).toBe("lifecycle");
    expect(orchestrator!.state).toBe("running");
    expect(orchestrator!.priority).toBe(90);

    expect(metacog).toBeDefined();
    expect(metacog!.type).toBe("daemon");
    expect(metacog!.state).toBe("idle");
    expect(metacog!.priority).toBe(50);
  });

  test("boot produces emit_protocol and submit_llm effects", () => {
    const state = makeState();
    const [, effects] = transition(state, bootEvent());

    const spawnEffects = effects.filter(e => e.type === "emit_protocol");
    expect(spawnEffects.length).toBeGreaterThanOrEqual(1);

    const submitEffects = effects.filter(e => e.type === "submit_llm");
    expect(submitEffects).toHaveLength(1);
    expect((submitEffects[0] as any).name).toBe("goal-orchestrator");
  });

  test("boot sets startTime", () => {
    const state = makeState();
    const before = Date.now();
    const [newState] = transition(state, bootEvent());
    const after = Date.now();

    expect(newState.startTime).toBeGreaterThanOrEqual(before);
    expect(newState.startTime).toBeLessThanOrEqual(after);
  });

  test("boot pre-seeds design guidelines on blackboard", () => {
    const state = makeState();
    const [newState] = transition(state, bootEvent());

    const guidelines = newState.blackboard.get("system:design-guidelines");
    expect(guidelines).toBeDefined();
    expect(typeof guidelines!.value).toBe("string");
    expect((guidelines!.value as string)).toContain("topology");
  });

  test("boot does not mutate original state", () => {
    const state = makeState();
    const originalProcessCount = state.processes.size;
    transition(state, bootEvent());

    expect(state.processes.size).toBe(originalProcessCount);
    expect(state.goal).toBe("");
  });

  test("effects have monotonically increasing seq numbers", () => {
    const state = makeState();
    const [, effects] = transition(state, bootEvent());

    for (let i = 1; i < effects.length; i++) {
      expect(effects[i].seq).toBeGreaterThan(effects[i - 1].seq);
    }
  });
});

describe("transition — halt_check", () => {
  test("already halted state returns no-op", () => {
    const state = { ...makeState(), halted: true, haltReason: "done" };
    const [newState, effects] = transition(state, haltCheckEvent());

    expect(newState.halted).toBe(true);
    expect(effects).toHaveLength(0);
  });

  test("token budget exceeded halts", () => {
    const state = makeState({ tokenBudget: 100 });
    // Add a process that used 200 tokens
    state.processes.set("p1", {
      pid: "p1", type: "lifecycle", state: "running", name: "test",
      parentPid: null, objective: "test", priority: 5,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 200, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "never",
    });
    state.startTime = Date.now();

    const [newState, effects] = transition(state, haltCheckEvent());

    expect(newState.halted).toBe(true);
    expect(newState.haltReason).toBe("token_budget_exceeded");
    expect(effects.some(e => e.type === "halt")).toBe(true);
  });

  test("inflight work prevents soft halt (all_processes_dead) but not hard halt (token_budget)", () => {
    // Token budget is a hard halt — inflight doesn't block it
    const state1 = makeState({ tokenBudget: 100 });
    state1.processes.set("p1", {
      pid: "p1", type: "lifecycle", state: "running", name: "test",
      parentPid: null, objective: "test", priority: 5,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 200, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "never",
    });
    state1.inflight.add("p1");
    state1.startTime = Date.now();
    const [halted1] = transition(state1, haltCheckEvent());
    expect(halted1.halted).toBe(true); // hard halt ignores inflight
    expect(halted1.haltReason).toBe("token_budget_exceeded");

    // But inflight DOES prevent soft halts (like all_processes_dead)
    const state2 = makeState();
    state2.processes.set("p1", {
      pid: "p1", type: "lifecycle", state: "dead", name: "test",
      parentPid: null, objective: "test", priority: 5,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 10, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "never",
    });
    state2.inflight.add("p2"); // another process in-flight
    state2.startTime = Date.now();
    const [notHalted] = transition(state2, haltCheckEvent());
    expect(notHalted.halted).toBe(false); // inflight blocks soft halt
  });

  test("all processes dead halts", () => {
    const state = makeState();
    state.processes.set("p1", {
      pid: "p1", type: "lifecycle", state: "dead", name: "test",
      parentPid: null, objective: "test", priority: 5,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 10, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "never",
    });
    state.startTime = Date.now();

    const [newState, effects] = transition(state, haltCheckEvent());

    expect(newState.halted).toBe(true);
    expect(newState.haltReason).toBe("all_processes_dead");
    expect(effects.some(e => e.type === "halt")).toBe(true);
  });

  test("only daemons remaining starts grace period", () => {
    const state = makeState();
    state.processes.set("d1", {
      pid: "d1", type: "daemon", state: "idle", name: "metacog",
      parentPid: null, objective: "metacog", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 0, tokensUsed: 0, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "always",
    });
    state.startTime = Date.now();

    const [newState, effects] = transition(state, haltCheckEvent());

    expect(newState.halted).toBe(false);
    expect(newState.goalWorkDoneAt).toBeGreaterThan(0);
    // Should emit grace period start event
    const graceEffects = effects.filter(
      (e: any) => e.type === "emit_protocol" && e.action === "os_halt_grace_period"
    );
    expect(graceEffects.length).toBeGreaterThanOrEqual(1);
  });

  test("grace period expired halts with goal_work_complete", () => {
    const state = makeState({ goalCompleteGracePeriodMs: 100 });
    state.processes.set("d1", {
      pid: "d1", type: "daemon", state: "idle", name: "metacog",
      parentPid: null, objective: "metacog", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 0, tokensUsed: 0, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "always",
    });
    state.startTime = Date.now();
    state.goalWorkDoneAt = Date.now() - 200; // expired

    const [newState] = transition(state, haltCheckEvent());

    expect(newState.halted).toBe(true);
    expect(newState.haltReason).toBe("goal_work_complete");
  });

  test("lifecycle processes reappearing resets grace period", () => {
    const state = makeState();
    state.goalWorkDoneAt = Date.now() - 1000; // grace period active
    state.startTime = Date.now() - 5000;
    state.processes.set("d1", {
      pid: "d1", type: "daemon", state: "idle", name: "metacog",
      parentPid: null, objective: "metacog", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 0, tokensUsed: 0, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "always",
    });
    state.processes.set("w1", {
      pid: "w1", type: "lifecycle", state: "running", name: "worker",
      parentPid: null, objective: "work", priority: 5,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 0, tokensUsed: 0, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "never",
    });

    const [newState] = transition(state, haltCheckEvent());

    expect(newState.halted).toBe(false);
    expect(newState.goalWorkDoneAt).toBe(0); // reset
  });

  test("deferrals prevent halt even when no living processes", () => {
    const state = makeState();
    state.startTime = Date.now();
    state.processes.set("p1", {
      pid: "p1", type: "lifecycle", state: "dead", name: "test",
      parentPid: null, objective: "test", priority: 5,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 10, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "never",
    });
    // But a deferral exists — more work is coming
    state.deferrals.set("d1", {
      id: "d1",
      descriptor: { type: "lifecycle", name: "deferred-worker", objective: "pending work" },
      condition: { type: "blackboard_key_exists", key: "scout:results" },
      registeredAt: new Date().toISOString(),
      registeredByTick: 0,
      reason: "waiting for scout",
    });

    const [newState] = transition(state, haltCheckEvent());

    expect(newState.halted).toBe(false);
  });

  test("does not mutate original state", () => {
    const state = makeState({ tokenBudget: 100 });
    state.processes.set("p1", {
      pid: "p1", type: "lifecycle", state: "running", name: "test",
      parentPid: null, objective: "test", priority: 5,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 200, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "never",
    });
    state.startTime = Date.now();

    transition(state, haltCheckEvent());

    // Original state should NOT be mutated
    expect(state.halted).toBe(false);
    expect(state.haltReason).toBeNull();
  });
});

describe("transition — unhandled events", () => {
  test("unhandled event returns state unchanged with no effects", () => {
    const state = makeState();
    const [newState, effects] = transition(state, {
      type: "timer_fired",
      timer: "housekeep",
      timestamp: Date.now(),
      seq: 0,
    });

    expect(newState).toBe(state); // same reference — no mutation
    expect(effects).toHaveLength(0);
  });

  test("process_completed for unknown PID is a no-op", () => {
    const state = makeState();
    const [newState, effects] = transition(state, {
      type: "process_completed",
      pid: "nonexistent",
      name: "test",
      success: true,
      tokensUsed: 10,
      commandCount: 0,
      commands: [],
      response: "",
      timestamp: Date.now(),
      seq: 0,
    });

    expect(newState).toBe(state);
    expect(effects).toHaveLength(0);
  });
});

describe("transition — external_command", () => {
  test("halt command halts immediately", () => {
    const state = makeState();
    state.startTime = Date.now();
    const [newState, effects] = transition(state, {
      type: "external_command", command: "halt", timestamp: Date.now(), seq: 0,
    });

    expect(newState.halted).toBe(true);
    expect(newState.haltReason).toBe("external_halt");
    expect(effects.some(e => e.type === "halt")).toBe(true);
  });

  test("pause command emits protocol effect but does not halt", () => {
    const state = makeState();
    const [newState, effects] = transition(state, {
      type: "external_command", command: "pause", timestamp: Date.now(), seq: 0,
    });

    expect(newState.halted).toBe(false);
    const proto = effects.filter(e => e.type === "emit_protocol") as any[];
    expect(proto.some(e => e.message.includes("pause"))).toBe(true);
  });

  test("resume command emits protocol effect", () => {
    const state = makeState();
    const [newState, effects] = transition(state, {
      type: "external_command", command: "resume", timestamp: Date.now(), seq: 0,
    });

    expect(newState.halted).toBe(false);
    expect(effects.some(e => e.type === "emit_protocol")).toBe(true);
  });
});

describe("transition — determinism", () => {
  test("boot → halt_check sequence is reproducible (except PIDs)", () => {
    const state1 = makeState({ tokenBudget: 50 });
    const state2 = makeState({ tokenBudget: 50 });

    // Boot both
    const [booted1, bootEffects1] = transition(state1, bootEvent("same goal"));
    const [booted2, bootEffects2] = transition(state2, bootEvent("same goal"));

    // Same effect types
    expect(bootEffects1.map(e => e.type)).toEqual(bootEffects2.map(e => e.type));
    expect(booted1.goal).toBe(booted2.goal);
    expect(booted1.processes.size).toBe(booted2.processes.size);

    // Set identical token usage to trigger halt
    for (const proc of booted1.processes.values()) proc.tokensUsed = 100;
    for (const proc of booted2.processes.values()) proc.tokensUsed = 100;

    const [halted1, haltEffects1] = transition(booted1, haltCheckEvent());
    const [halted2, haltEffects2] = transition(booted2, haltCheckEvent());

    expect(halted1.halted).toBe(halted2.halted);
    expect(halted1.haltReason).toBe(halted2.haltReason);
    expect(haltEffects1.map(e => e.type)).toEqual(haltEffects2.map(e => e.type));
  });
});

describe("transition — integration roundtrip", () => {
  test("boot → multiple halt_checks → eventual halt produces correct final state", () => {
    const state = makeState({ tokenBudget: 200 });
    let seq = 0;

    // 1. Boot
    const [s1, e1] = transition(state, { type: "boot", goal: "test", timestamp: Date.now(), seq: seq++ });
    expect(s1.goal).toBe("test");
    expect(s1.processes.size).toBe(2);
    expect(e1.some(e => e.type === "submit_llm")).toBe(true);

    // 2. Simulate process completion by manually updating tokens
    //    (process_completed isn't handled by transition yet — strangler pattern)
    for (const proc of s1.processes.values()) {
      if (proc.type === "lifecycle") proc.tokensUsed = 50;
    }

    // 3. Halt check — should not halt (tokens under budget)
    const [s2] = transition(s1, { type: "halt_check", result: false, reason: null, timestamp: Date.now(), seq: seq++ });
    expect(s2.halted).toBe(false);

    // 4. More tokens used
    for (const proc of s2.processes.values()) {
      if (proc.type === "lifecycle") proc.tokensUsed = 250;
    }

    // 5. Halt check — should halt now (tokens exceed 200 budget)
    const [s3, e3] = transition(s2, { type: "halt_check", result: false, reason: null, timestamp: Date.now(), seq: seq++ });
    expect(s3.halted).toBe(true);
    expect(s3.haltReason).toBe("token_budget_exceeded");
    expect(e3.some(e => e.type === "halt")).toBe(true);

    // 6. Further halt checks are no-ops
    const [s4, e4] = transition(s3, { type: "halt_check", result: false, reason: null, timestamp: Date.now(), seq: seq++ });
    expect(s4.halted).toBe(true);
    expect(e4).toHaveLength(0);
  });

  test("boot → external halt → halt_check is no-op", () => {
    const state = makeState();
    let seq = 0;

    const [s1] = transition(state, { type: "boot", goal: "test", timestamp: Date.now(), seq: seq++ });
    const [s2, e2] = transition(s1, { type: "external_command", command: "halt", timestamp: Date.now(), seq: seq++ });

    expect(s2.halted).toBe(true);
    expect(s2.haltReason).toBe("external_halt");
    expect(e2.some(e => e.type === "halt")).toBe(true);

    // After halt, halt_check is a no-op
    const [s3, e3] = transition(s2, { type: "halt_check", result: false, reason: null, timestamp: Date.now(), seq: seq++ });
    expect(s3.halted).toBe(true);
    expect(e3).toHaveLength(0);
  });

  test("state is never mutated — immutability invariant", () => {
    const original = makeState({ tokenBudget: 100 });
    const frozen = JSON.parse(JSON.stringify({
      goal: original.goal,
      halted: original.halted,
      processCount: original.processes.size,
    }));

    // Run through several transitions
    const [s1] = transition(original, bootEvent("test"));
    const [s2] = transition(s1, haltCheckEvent());

    // Original must be unchanged
    expect(original.goal).toBe(frozen.goal);
    expect(original.halted).toBe(frozen.halted);
    expect(original.processes.size).toBe(frozen.processCount);

    // s1 should differ from original
    expect(s1.goal).not.toBe(original.goal);
    expect(s1.processes.size).not.toBe(original.processes.size);
  });
});

// ---------------------------------------------------------------------------
// process_completed
// ---------------------------------------------------------------------------

function bootAndGetOrchestrator(overrides?: Parameters<typeof makeState>[0]): { state: KernelState; orchestratorPid: string } {
  const [state] = transition(makeState(overrides), bootEvent("test"));
  const orchestrator = [...state.processes.values()].find(p => p.name === "goal-orchestrator")!;
  return { state, orchestratorPid: orchestrator.pid };
}

function processCompletedEvent(
  pid: string,
  opts: {
    commands?: import("../../../src/os/types.js").OsProcessCommand[];
    success?: boolean;
    tokensUsed?: number;
    response?: string;
  } = {},
): KernelEvent {
  const commands = opts.commands ?? [];
  return {
    type: "process_completed",
    pid,
    name: "test",
    success: opts.success ?? true,
    commandCount: commands.length,
    tokensUsed: opts.tokensUsed ?? 100,
    commands,
    response: opts.response ?? "",
    timestamp: Date.now(),
    seq: 0,
  };
}

describe("transition — process_completed basics", () => {
  test("updates process tickCount and tokensUsed", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    // Need spawn commands since it's first tick
    const [newState] = transition(state, processCompletedEvent(orchestratorPid, {
      tokensUsed: 500,
      commands: [{ kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } }],
    }));

    const proc = newState.processes.get(orchestratorPid)!;
    expect(proc.tickCount).toBe(1);
    expect(proc.tokensUsed).toBe(500);
  });

  test("failed process is killed and emits protocol effect", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [newState, effects] = transition(state, processCompletedEvent(orchestratorPid, {
      success: false,
      response: "LLM error",
    }));

    const proc = newState.processes.get(orchestratorPid)!;
    expect(proc.state).toBe("dead");
    expect(proc.exitReason).toContain("execution_failed");
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).action === "os_process_kill")).toBe(true);
    expect(newState.pendingTriggers).toContain("process_failed");
  });

  test("does not mutate input state", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const originalProcessCount = state.processes.size;
    const originalProc = state.processes.get(orchestratorPid)!;
    const originalTickCount = originalProc.tickCount;

    transition(state, processCompletedEvent(orchestratorPid, {
      tokensUsed: 500,
      commands: [{ kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } }],
    }));

    // Original state unchanged
    expect(state.processes.size).toBe(originalProcessCount);
    expect(state.processes.get(orchestratorPid)!.tickCount).toBe(originalTickCount);
  });
});

describe("transition — process_completed commands", () => {
  test("idle command sets process state to idle", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    // First: satisfy hard spawn enforcement with a spawn, then do idle on second tick
    const [s1] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [{ kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } }],
    }));
    // Find the worker we spawned
    const worker = [...s1.processes.values()].find(p => p.name === "w1")!;
    // Worker goes idle
    const [s2] = transition(s1, processCompletedEvent(worker.pid, {
      commands: [{ kind: "idle", wakeOnSignals: ["tick:1"] }],
    }));

    const updatedWorker = s2.processes.get(worker.pid)!;
    expect(updatedWorker.state).toBe("idle");
    expect(updatedWorker.wakeOnSignals).toEqual(["tick:1"]);
  });

  test("exit command kills process and emits protocol effect", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [s1] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [{ kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } }],
    }));
    const worker = [...s1.processes.values()].find(p => p.name === "w1")!;

    const [s2, effects] = transition(s1, processCompletedEvent(worker.pid, {
      commands: [{ kind: "exit", code: 0, reason: "done" }],
    }));

    const updatedWorker = s2.processes.get(worker.pid)!;
    expect(updatedWorker.state).toBe("dead");
    expect(updatedWorker.exitCode).toBe(0);
    expect(updatedWorker.exitReason).toBe("done");
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).action === "os_process_kill")).toBe(true);
    // Should emit child:done signal to parent
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).message.includes("child:done"))).toBe(true);
  });

  test("bb_write updates blackboard and tracks written keys", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [s1] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [
        { kind: "bb_write", key: "result:test", value: { data: "hello" } },
        { kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } },
      ],
    }));

    const entry = s1.blackboard.get("result:test");
    expect(entry).toBeDefined();
    expect(entry!.value).toEqual({ data: "hello" });
    expect(entry!.writtenBy).toBe(orchestratorPid);

    const proc = s1.processes.get(orchestratorPid)!;
    expect(proc.blackboardKeysWritten).toContain("result:test");
  });

  test("bb_read writes results to inbox", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    // First write something to the blackboard
    const s0 = { ...state, blackboard: new Map(state.blackboard) };
    s0.blackboard.set("data:x", { value: 42, writtenBy: "test", version: 1 });

    const [s1] = transition(s0, processCompletedEvent(orchestratorPid, {
      commands: [
        { kind: "bb_read", keys: ["data:x", "data:missing"] },
        { kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } },
      ],
    }));

    const inbox = s1.blackboard.get(`_inbox:${orchestratorPid}`);
    expect(inbox).toBeDefined();
    const inboxValue = inbox!.value as Record<string, unknown>;
    expect(inboxValue["data:x"]).toBe(42);
    expect(inboxValue["data:missing"]).toBeUndefined();
  });

  test("spawn_child creates new process and emits submit_llm effect", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [newState, effects] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [{
        kind: "spawn_child",
        descriptor: { type: "lifecycle", name: "worker-1", objective: "do work", priority: 70 },
      }],
    }));

    // New process created
    expect(newState.processes.size).toBe(state.processes.size + 1);
    const worker = [...newState.processes.values()].find(p => p.name === "worker-1")!;
    expect(worker).toBeDefined();
    expect(worker.type).toBe("lifecycle");
    expect(worker.parentPid).toBe(orchestratorPid);
    expect(worker.state).toBe("running");
    expect(worker.priority).toBe(70);

    // submit_llm effect emitted
    expect(effects.some(e => e.type === "submit_llm" && (e as any).name === "worker-1")).toBe(true);
    // Protocol effect
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).action === "os_process_spawn")).toBe(true);
  });

  test("spawn_graph with immediate and deferred nodes", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [newState, effects] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [{
        kind: "spawn_graph",
        nodes: [
          { name: "phase-0", type: "lifecycle", objective: "gather", after: [], priority: 80 },
          { name: "phase-1", type: "lifecycle", objective: "process", after: ["phase-0"], priority: 70 },
        ],
      }],
    }));

    // phase-0 spawned immediately
    const phase0 = [...newState.processes.values()].find(p => p.name === "phase-0");
    expect(phase0).toBeDefined();
    expect(phase0!.state).toBe("running");
    expect(effects.some(e => e.type === "submit_llm" && (e as any).name === "phase-0")).toBe(true);

    // phase-1 deferred
    expect(newState.deferrals.size).toBe(1);
    const deferral = [...newState.deferrals.values()][0];
    expect(deferral.descriptor.name).toBe("phase-1");
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).message.includes("graph deferred"))).toBe(true);
  });

  test("cancel_defer removes matching deferrals", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    // First spawn a deferred process
    const [s1] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [{
        kind: "spawn_graph",
        nodes: [
          { name: "immediate", type: "lifecycle", objective: "now", after: [] },
          { name: "deferred-work", type: "lifecycle", objective: "later", after: ["immediate"] },
        ],
      }],
    }));
    expect(s1.deferrals.size).toBe(1);

    // Now cancel it (from the orchestrator's second tick)
    const [s2, effects] = transition(s1, processCompletedEvent(orchestratorPid, {
      commands: [{ kind: "cancel_defer", name: "deferred-work", reason: "no longer needed" }],
    }));
    expect(s2.deferrals.size).toBe(0);
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).message.includes("cancel_defer"))).toBe(true);
  });

  test("self_report is recorded on process", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [s1] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [
        {
          kind: "self_report",
          efficiency: 0.8,
          blockers: [],
          resourcePressure: "low",
          suggestedAction: "continue",
        },
        { kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } },
      ],
    }));

    const proc = s1.processes.get(orchestratorPid)!;
    expect(proc.selfReports).toHaveLength(1);
    expect(proc.selfReports![0].efficiency).toBe(0.8);
  });

  test("sleep command sets sleeping state", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [s1] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [
        { kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } },
      ],
    }));
    const worker = [...s1.processes.values()].find(p => p.name === "w1")!;

    const [s2] = transition(s1, processCompletedEvent(worker.pid, {
      commands: [{ kind: "sleep", durationMs: 5000 }],
    }));

    const updatedWorker = s2.processes.get(worker.pid)!;
    expect(updatedWorker.state).toBe("sleeping");
    expect(updatedWorker.sleepUntil).toBeDefined();
  });

  test("exit is reordered to run last (after bb_write)", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [s1] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [{ kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } }],
    }));
    const worker = [...s1.processes.values()].find(p => p.name === "w1")!;

    // Exit first in array, bb_write second — should still write before killing
    const [s2] = transition(s1, processCompletedEvent(worker.pid, {
      commands: [
        { kind: "exit", code: 0, reason: "done" },
        { kind: "bb_write", key: "result:w1", value: "final output" },
      ],
    }));

    // bb_write should have executed despite exit being first in command list
    expect(s2.blackboard.get("result:w1")).toBeDefined();
    expect(s2.processes.get(worker.pid)!.state).toBe("dead");
  });
});

describe("transition — process_completed enforcement", () => {
  test("hard spawn enforcement: orchestrator first tick without spawn is rejected", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [newState, effects] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [
        { kind: "bb_write", key: "plan", value: "I will do it myself" },
        { kind: "idle" },
      ],
    }));

    // bb_write preserved
    expect(newState.blackboard.get("plan")).toBeDefined();

    // Idle was rejected — process should still be running (not idle)
    const proc = newState.processes.get(orchestratorPid)!;
    expect(proc.state).toBe("running");

    // Rejection effect emitted
    expect(effects.some(e =>
      e.type === "emit_protocol" && (e as any).action === "os_command_rejected"
    )).toBe(true);
  });

  test("auto-exit: daemon without lifecycle command is killed", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const metacog = [...state.processes.values()].find(p => p.name === "metacog-daemon")!;

    // Daemon completes a turn with only bb_write — no idle/exit/sleep
    // First set state to running (it starts as idle)
    const s0 = { ...state, processes: new Map(state.processes) };
    s0.processes.set(metacog.pid, { ...metacog, state: "running" });

    const [newState, effects] = transition(s0, processCompletedEvent(metacog.pid, {
      commands: [{ kind: "bb_write", key: "metacog:result", value: "ok" }],
    }));

    const updated = newState.processes.get(metacog.pid)!;
    expect(updated.state).toBe("dead");
    expect(updated.exitReason).toContain("auto-exit");
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).action === "os_process_exit")).toBe(true);
  });

  test("executive exit prevention: orchestrator cannot exit while children live", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    // Spawn a child first
    const [s1] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [{ kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } }],
    }));

    // Now orchestrator tries to exit
    const [s2, effects] = transition(s1, processCompletedEvent(orchestratorPid, {
      commands: [{ kind: "exit", code: 0, reason: "done" }],
    }));

    // Exit should be rejected — orchestrator should be idle instead
    const orch = s2.processes.get(orchestratorPid)!;
    expect(orch.state).toBe("idle");
    expect(orch.wakeOnSignals).toContain("child:done");
    expect(effects.some(e =>
      e.type === "emit_protocol" && (e as any).message.includes("executive exit prevented")
    )).toBe(true);
  });
});

describe("transition — process_completed spawn_system / spawn_kernel", () => {
  test("spawn_system creates shell process and emits start_shell effect", () => {
    const config = parseOsConfig({
      enabled: true,
      kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 },
      systemProcess: { enabled: true, maxSystemProcesses: 5 },
    });
    const [state] = transition(initialState(config, "test"), bootEvent("test"));
    const orchestratorPid = [...state.processes.values()].find(p => p.name === "goal-orchestrator")!.pid;

    const [newState, effects] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [
        { kind: "spawn_system", name: "dev-server", command: "npm", args: ["run", "dev"] },
      ],
    }));

    const shell = [...newState.processes.values()].find(p => p.name === "dev-server");
    expect(shell).toBeDefined();
    expect(shell!.backend).toEqual({ kind: "system", command: "npm", args: ["run", "dev"] });
    expect(effects.some(e => e.type === "start_shell")).toBe(true);
  });

  test("spawn_system rejected when disabled", () => {
    const config = parseOsConfig({
      enabled: true,
      kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 },
      systemProcess: { enabled: false },
    });
    const [state] = transition(initialState(config, "test"), bootEvent("test"));
    const orchestratorPid = [...state.processes.values()].find(p => p.name === "goal-orchestrator")!.pid;

    const [, effects] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [
        { kind: "spawn_system", name: "srv", command: "node" },
        { kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } },
      ],
    }));

    expect(effects.some(e =>
      e.type === "emit_protocol" && (e as any).message.includes("spawn_system rejected")
    )).toBe(true);
  });

  test("spawn_kernel rejected when disabled", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [, effects] = transition(state, processCompletedEvent(orchestratorPid, {
      commands: [
        { kind: "spawn_kernel", name: "sub", goal: "sub-goal" },
        { kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } },
      ],
    }));

    expect(effects.some(e =>
      e.type === "emit_protocol" && (e as any).message.includes("spawn_kernel rejected")
    )).toBe(true);
  });
});
