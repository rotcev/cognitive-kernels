import { describe, expect, test } from "vitest";
import { transition, selectRunnable, type TransitionResult } from "../../../src/os/state-machine/transition.js";
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

function timerEvent(timer: "housekeep" | "snapshot" | "metacog" | "watchdog", extra?: Partial<import("../../../src/os/state-machine/events.js").TimerFiredEvent>): KernelEvent {
  return { type: "timer_fired", timer, timestamp: Date.now(), seq: 0, ...extra };
}

function addProcess(state: KernelState, name: string, overrides?: Partial<import("../../../src/os/types.js").OsProcess>): KernelState {
  const pid = `os-proc-test-${name}`;
  const proc: import("../../../src/os/types.js").OsProcess = {
    pid,
    type: "lifecycle" as const,
    state: "running" as const,
    name,
    parentPid: null,
    objective: "test objective",
    priority: 70,
    spawnedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    tickCount: 0,
    tokensUsed: 0,
    model: state.config.kernel.processModel,
    workingDir: "/tmp",
    children: [] as string[],
    onParentDeath: "orphan" as const,
    restartPolicy: "never" as const,
    ...overrides,
  };
  const processes = new Map(state.processes);
  processes.set(pid, proc);
  return { ...state, processes };
}

describe("transition — boot", () => {
  test("boot sets goal on state", () => {
    const state = makeState();
    const [newState] = transition(state, bootEvent("build a calculator"));

    expect(newState.goal).toBe("build a calculator");
  });

  test("boot creates no daemon processes and sets pendingTriggers (no submit_metacog)", () => {
    const state = makeState();
    const [newState, effects] = transition(state, bootEvent());

    // Boot creates NO processes — metacog/awareness are kernel-level modules
    expect(newState.processes.size).toBe(0);

    // boot no longer emits submit_metacog — uses pendingTriggers instead
    const submitMetacog = effects.find(e => e.type === "submit_metacog");
    expect(submitMetacog).toBeUndefined();
    expect(newState.pendingTriggers).toContain("boot");
  });

  test("boot produces no submit_metacog or submit_llm effects", () => {
    const state = makeState();
    const [newState, effects] = transition(state, bootEvent());

    // Boot no longer emits submit_metacog — pendingTriggers: ["boot"] is sufficient
    const metacogEffects = effects.filter(e => e.type === "submit_metacog");
    expect(metacogEffects).toHaveLength(0);
    expect(newState.pendingTriggers).toContain("boot");

    // Boot does NOT emit submit_llm — process scheduling happens in the tick loop
    const submitEffects = effects.filter(e => e.type === "submit_llm");
    expect(submitEffects).toHaveLength(0);
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

  test("living processes prevent halt", () => {
    const state = makeState();
    state.startTime = Date.now();
    state.processes.set("w1", {
      pid: "w1", type: "lifecycle", state: "running", name: "worker",
      parentPid: null, objective: "work", priority: 5,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 0, tokensUsed: 0, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan", restartPolicy: "never",
    });

    const [newState] = transition(state, haltCheckEvent());

    expect(newState.halted).toBe(false);
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

describe("transition — no-op event cases", () => {
  test("shell_output for nonexistent PID returns state unchanged with no effects", () => {
    const state = makeState();
    const [newState, effects] = transition(state, {
      type: "shell_output",
      pid: "nonexistent",
      hasStdout: true,
      hasStderr: false,
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
  test("boot → process_completed → halt_check → eventual halt (full lifecycle)", () => {
    const state = makeState({ tokenBudget: 200 });
    let seq = 0;

    // 1. Boot
    const [s1, e1] = transition(state, { type: "boot", goal: "test", timestamp: Date.now(), seq: seq++ });
    expect(s1.goal).toBe("test");
    expect(s1.processes.size).toBe(0); // boot creates no daemon processes

    // 2. Add worker processes manually (spawn_child removed from command handlers)
    const s1WithWorkerA = addProcess(s1, "worker-A", { priority: 90, tokensUsed: 50 });
    const s1WithW1 = addProcess(s1WithWorkerA, "w1", { priority: 70, tokensUsed: 0 });
    const orch = [...s1WithW1.processes.values()].find(p => p.name === "worker-A")!;

    // 3. Halt check — should not halt (50 < 200 budget)
    const [s3] = transition(s1WithW1, { type: "halt_check", result: false, reason: null, timestamp: Date.now(), seq: seq++ });
    expect(s3.halted).toBe(false);

    // 4. Worker completes with 250 tokens → total now 300 > 200 budget
    const worker = [...s1WithW1.processes.values()].find(p => p.name === "w1")!;
    const [s4] = transition(s3, {
      type: "process_completed", pid: worker.pid, name: worker.name,
      success: true, commandCount: 1, tokensUsed: 250,
      commands: [{ kind: "exit", code: 0, reason: "done" }],
      response: "", timestamp: Date.now(), seq: seq++,
    });

    // 5. Halt check — should halt now (tokens exceed 200 budget)
    const [s5, e5] = transition(s4, { type: "halt_check", result: false, reason: null, timestamp: Date.now(), seq: seq++ });
    expect(s5.halted).toBe(true);
    expect(s5.haltReason).toBe("token_budget_exceeded");
    expect(e5.some(e => e.type === "halt")).toBe(true);

    // 6. Further halt checks are no-ops
    const [s6, e6] = transition(s5, { type: "halt_check", result: false, reason: null, timestamp: Date.now(), seq: seq++ });
    expect(s6.halted).toBe(true);
    expect(e6).toHaveLength(0);
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
    // Boot sets pendingTriggers and blackboard — verify state differs
    expect(s1.pendingTriggers).toContain("boot");
    expect(original.pendingTriggers).not.toContain("boot");
  });
});

// ---------------------------------------------------------------------------
// process_completed
// ---------------------------------------------------------------------------

function bootAndGetOrchestrator(overrides?: Parameters<typeof makeState>[0]): { state: KernelState; orchestratorPid: string } {
  const [bootState] = transition(makeState(overrides), bootEvent("test"));
  const state = addProcess(bootState, "worker-A", { priority: 90 });
  const orchestrator = [...state.processes.values()].find(p => p.name === "worker-A")!;
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
    // Add a worker process manually
    const workerState = addProcess(state, "w1", { priority: 50 });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;
    // Worker goes idle
    const [s2] = transition(workerState, processCompletedEvent(worker.pid, {
      commands: [{ kind: "idle", wakeOnSignals: ["tick:1"] }],
    }));

    const updatedWorker = s2.processes.get(worker.pid)!;
    expect(updatedWorker.state).toBe("idle");
    expect(updatedWorker.wakeOnSignals).toEqual(["tick:1"]);
  });

  test("exit command kills process and emits protocol effect", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    // Add a worker with parent set to orchestrator
    const workerState = addProcess(state, "w1", { priority: 50, parentPid: orchestratorPid });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    const [s2, effects] = transition(workerState, processCompletedEvent(worker.pid, {
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

  // spawn_child removed from command handlers — topology reconcile handles process spawning

  // spawn_graph removed from command handlers — topology reconcile handles graph spawning

  test("cancel_defer removes matching deferrals", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    // Manually add a deferral registered by the orchestrator
    const deferrals = new Map(state.deferrals);
    deferrals.set("defer-1", {
      id: "defer-1",
      descriptor: { type: "lifecycle" as const, name: "deferred-work", objective: "later" },
      condition: { type: "blackboard_key_exists" as const, key: "signal:go" },
      registeredAt: new Date().toISOString(),
      registeredAtMs: Date.now(),
      registeredByTick: 0,
      registeredByPid: orchestratorPid,
      reason: "test deferral",
    });
    const stateWithDefer = { ...state, deferrals };
    expect(stateWithDefer.deferrals.size).toBe(1);

    // Now cancel it
    const [s2, effects] = transition(stateWithDefer, processCompletedEvent(orchestratorPid, {
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
        { kind: "idle" },
      ],
    }));

    const proc = s1.processes.get(orchestratorPid)!;
    expect(proc.selfReports).toHaveLength(1);
    expect(proc.selfReports![0].efficiency).toBe(0.8);
  });

  test("sleep command sets sleeping state", () => {
    const { state } = bootAndGetOrchestrator();
    // Add a worker process manually
    const workerState = addProcess(state, "w1", { priority: 50 });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    const [s2] = transition(workerState, processCompletedEvent(worker.pid, {
      commands: [{ kind: "sleep", durationMs: 5000 }],
    }));

    const updatedWorker = s2.processes.get(worker.pid)!;
    expect(updatedWorker.state).toBe("sleeping");
    expect(updatedWorker.sleepUntil).toBeDefined();
  });

  test("exit is reordered to run last (after bb_write)", () => {
    const { state } = bootAndGetOrchestrator();
    // Add a worker process manually
    const workerState = addProcess(state, "w1", { priority: 50 });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    // Exit first in array, bb_write second — should still write before killing
    const [s2] = transition(workerState, processCompletedEvent(worker.pid, {
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

// Hard spawn enforcement, auto-exit daemons, and executive exit prevention
// have been removed from the pure kernel. Enforcement is now handled by
// metacog (topology reconcile) and kernel-level modules.

// spawn_system and spawn_kernel removed from command handlers.
// System process and sub-kernel spawning now handled via topology reconcile.

// ---------------------------------------------------------------------------
// ephemeral_completed
// ---------------------------------------------------------------------------

describe("transition — ephemeral_completed", () => {
  function setupWithEphemeral() {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    // Manually add an ephemeral process to the state
    const ephPid = "eph-proc-1";
    const processes = new Map(s1.processes);
    processes.set(ephPid, {
      pid: ephPid,
      type: "event" as const,
      state: "running" as const,
      name: "scout-1",
      parentPid: orch.pid,
      objective: "find something",
      priority: 50,
      spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tickCount: 0,
      tokensUsed: 0,
      model: "gpt-4",
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan" as const,
      restartPolicy: "never" as const,
    });
    return { state: { ...s1, processes }, orchPid: orch.pid, ephPid };
  }

  test("successful ephemeral writes result to blackboard and kills process", () => {
    const { state, orchPid, ephPid } = setupWithEphemeral();
    const [newState, effects] = transition(state, {
      type: "ephemeral_completed",
      id: "eph-abc",
      name: "scout-1",
      success: true,
      tablePid: ephPid,
      parentPid: orchPid,
      response: "Found the answer: 42",
      durationMs: 1500,
      model: "gpt-4",
      timestamp: Date.now(),
      seq: 0,
    });

    // Process killed
    const ephProc = newState.processes.get(ephPid);
    expect(ephProc?.state).toBe("dead");
    expect(ephProc?.exitReason).toBe("ephemeral completed");

    // Blackboard written
    const bbEntry = newState.blackboard.get("ephemeral:scout-1:eph-abc");
    expect(bbEntry).toBeDefined();
    expect((bbEntry!.value as any).success).toBe(true);
    expect((bbEntry!.value as any).response).toBe("Found the answer: 42");

    // Protocol effects
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).action === "os_process_exit")).toBe(true);
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).action === "os_ephemeral_spawn")).toBe(true);
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).action === "os_signal_emit")).toBe(true);
  });

  test("failed ephemeral writes error result and kills process", () => {
    const { state, orchPid, ephPid } = setupWithEphemeral();
    const [newState, effects] = transition(state, {
      type: "ephemeral_completed",
      id: "eph-fail",
      name: "scout-1",
      success: false,
      tablePid: ephPid,
      parentPid: orchPid,
      error: "LLM timeout",
      durationMs: 30000,
      model: "gpt-4",
      timestamp: Date.now(),
      seq: 0,
    });

    const ephProc = newState.processes.get(ephPid);
    expect(ephProc?.state).toBe("dead");
    expect(ephProc?.exitReason).toContain("ephemeral failed");

    const bbEntry = newState.blackboard.get("ephemeral:scout-1:eph-fail");
    expect(bbEntry).toBeDefined();
    expect((bbEntry!.value as any).success).toBe(false);
    expect((bbEntry!.value as any).error).toBe("LLM timeout");

    // Signal includes error flag
    const signalEffect = effects.find(e =>
      e.type === "emit_protocol" && (e as any).action === "os_signal_emit"
    );
    expect((signalEffect as any).message).toContain("error=true");
  });

  test("ephemeral_completed without tablePid is a no-op", () => {
    const { state } = setupWithEphemeral();
    const [newState, effects] = transition(state, {
      type: "ephemeral_completed",
      id: "eph-x",
      name: "scout-1",
      success: true,
      timestamp: Date.now(),
      seq: 0,
    });

    // No state changes, no effects
    expect(newState.processes.size).toBe(state.processes.size);
    expect(effects).toHaveLength(0);
  });

  test("ephemeral_completed does not mutate input state", () => {
    const { state, orchPid, ephPid } = setupWithEphemeral();
    const beforeSize = state.processes.size;
    const beforeBbSize = state.blackboard.size;

    transition(state, {
      type: "ephemeral_completed",
      id: "eph-imm",
      name: "scout-1",
      success: true,
      tablePid: ephPid,
      parentPid: orchPid,
      response: "result",
      durationMs: 100,
      model: "gpt-4",
      timestamp: Date.now(),
      seq: 0,
    });

    expect(state.processes.size).toBe(beforeSize);
    expect(state.blackboard.size).toBe(beforeBbSize);
    // Original process still running
    expect(state.processes.get(ephPid)?.state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// timer_fired (housekeep)
// ---------------------------------------------------------------------------

describe("transition — timer_fired (housekeep)", () => {
  test("housekeep increments housekeepCount", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    expect(s1.housekeepCount).toBe(0);

    const [s2] = transition(s1, timerEvent("housekeep"));
    expect(s2.housekeepCount).toBe(1);

    const [s3] = transition(s2, timerEvent("housekeep"));
    expect(s3.housekeepCount).toBe(2);
  });

  test("housekeep wakes expired sleepers", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    // Put worker to sleep (already expired)
    const processes = new Map(s1.processes);
    processes.set(orch.pid, {
      ...orch,
      state: "sleeping" as const,
      sleepUntil: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
    });
    const sleepState = { ...s1, processes };

    const [s2] = transition(sleepState, timerEvent("housekeep"));
    expect(s2.processes.get(orch.pid)?.state).toBe("running");
  });

  test("housekeep restores checkpointed processes", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const processes = new Map(s1.processes);
    processes.set(orch.pid, { ...orch, state: "checkpoint" as const });
    const cpState = { ...s1, processes };

    const [s2] = transition(cpState, timerEvent("housekeep"));
    expect(s2.processes.get(orch.pid)?.state).toBe("running");
  });

  test("snapshot timer emits persist_snapshot effect", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const [, effects] = transition(s1, timerEvent("snapshot"));
    expect(effects.some(e => e.type === "persist_snapshot")).toBe(true);
  });

  test("metacog timer emits run_metacog when pendingTriggers present (boot trigger)", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    // After boot, pendingTriggers includes "boot", so metacog timer should fire
    expect(s1.pendingTriggers).toContain("boot");

    const [s2, e2] = transition(s1, timerEvent("metacog"));
    const runMetacog = e2.find(e => e.type === "run_metacog");
    expect(runMetacog).toBeDefined();
    expect((runMetacog as any).context).toBeDefined();
    expect((runMetacog as any).context.trigger).toBe("boot");
  });

  test("metacog timer does not emit run_metacog when metacogInflight is true", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    // Simulate metacog already inflight
    const inflightState = { ...s1, metacogInflight: true };

    const [, e2] = transition(inflightState, timerEvent("metacog"));
    expect(e2.filter(e => e.type === "run_metacog")).toHaveLength(0);
  });

  test("metacog timer sets metacogInflight to true when emitting run_metacog", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    expect(s1.pendingTriggers).toContain("boot");
    expect(s1.metacogInflight).toBe(false);

    const [s2] = transition(s1, timerEvent("metacog"));
    expect(s2.metacogInflight).toBe(true);
  });

  test("metacog timer is a no-op when pendingTriggers is empty and cadence does not fire", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    // Clear pendingTriggers and set tickCount so cadence doesn't fire
    const cleanState = { ...s1, pendingTriggers: [] as any[], tickCount: 1 };

    const [, e2] = transition(cleanState, timerEvent("metacog"));
    expect(e2).toHaveLength(0);
  });

  test("watchdog timer is a no-op in transition", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const [s3, e3] = transition(s1, timerEvent("watchdog"));
    expect(e3).toHaveLength(0);
  });

  test("housekeep does not mutate input state", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const beforeCount = s1.housekeepCount;

    transition(s1, timerEvent("housekeep"));
    expect(s1.housekeepCount).toBe(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// metacog_evaluated
// ---------------------------------------------------------------------------

describe("transition — metacog_evaluated", () => {
  test("clears pending triggers", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const s1WithTriggers = {
      ...s1,
      pendingTriggers: ["goal_drift", "process_failed", "novel_situation"],
    };

    const [s2, effects] = transition(s1WithTriggers, {
      type: "metacog_evaluated",
      commandCount: 2,
      triggerCount: 3,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2.pendingTriggers).toEqual([]);
    expect(effects.some(e => e.type === "emit_protocol")).toBe(true);
  });

  test("no-op when halted", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const haltedState = { ...s1, halted: true, pendingTriggers: ["goal_drift"] };

    const [s2, effects] = transition(haltedState, {
      type: "metacog_evaluated",
      commandCount: 0,
      triggerCount: 1,
      timestamp: Date.now(),
      seq: 99,
    });

    // Still has triggers (not cleared because halted)
    expect(s2.pendingTriggers).toEqual(["goal_drift"]);
    expect(effects).toHaveLength(0);
  });

  test("does not mutate input state", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const triggers = ["goal_drift", "process_failed"];
    const s1WithTriggers = { ...s1, pendingTriggers: [...triggers] };

    transition(s1WithTriggers, {
      type: "metacog_evaluated",
      commandCount: 1,
      triggerCount: 2,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s1WithTriggers.pendingTriggers).toEqual(triggers);
  });
});

// ---------------------------------------------------------------------------
// awareness_evaluated
// ---------------------------------------------------------------------------

describe("transition — awareness_evaluated", () => {
  test("returns state unchanged (I/O-only event)", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const [s2, effects] = transition(s1, {
      type: "awareness_evaluated",
      hasAdjustment: true,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2).toBe(s1); // Reference equality — no state change
    expect(effects).toHaveLength(0);
  });

  test("no-op when halted", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const haltedState = { ...s1, halted: true };

    const [s2, effects] = transition(haltedState, {
      type: "awareness_evaluated",
      hasAdjustment: false,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2).toBe(haltedState);
    expect(effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shell_output
// ---------------------------------------------------------------------------

describe("transition — shell_output", () => {
  test("shell exit marks process dead and writes bb entry", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });

    // Add a shell process
    const processes = new Map(s1.processes);
    const shellPid = "shell-001";
    processes.set(shellPid, {
      pid: shellPid,
      type: "lifecycle" as const,
      state: "running" as const,
      name: "dev-server",
      parentPid: [...s1.processes.values()].find(p => p.name === "worker-A")?.pid ?? null,
      objective: "Run dev server",
      priority: 50,
      spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tickCount: 0,
      tokensUsed: 0,
      model: "gpt-4",
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan" as const,
      restartPolicy: "never" as const,
      backend: { kind: "system" as const, command: "npm", args: ["run", "dev"] },
    });
    const shellState = { ...s1, processes };

    const [s2, effects] = transition(shellState, {
      type: "shell_output",
      pid: shellPid,
      hasStdout: false,
      hasStderr: false,
      exitCode: 0,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2.processes.get(shellPid)?.state).toBe("dead");
    expect(s2.processes.get(shellPid)?.exitCode).toBe(0);
    expect(s2.blackboard.has(`shell:exit:${shellPid}`)).toBe(true);
    expect(effects.some(e => e.type === "emit_protocol")).toBe(true);
  });

  test("shell exit with non-zero code records exit reason", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const processes = new Map(s1.processes);
    const shellPid = "shell-002";
    processes.set(shellPid, {
      pid: shellPid,
      type: "lifecycle" as const,
      state: "running" as const,
      name: "test-runner",
      parentPid: null,
      objective: "Run tests",
      priority: 50,
      spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tickCount: 0,
      tokensUsed: 0,
      model: "gpt-4",
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan" as const,
      restartPolicy: "never" as const,
    });
    const shellState = { ...s1, processes };

    const [s2] = transition(shellState, {
      type: "shell_output",
      pid: shellPid,
      hasStdout: true,
      hasStderr: true,
      exitCode: 1,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2.processes.get(shellPid)?.state).toBe("dead");
    expect(s2.processes.get(shellPid)?.exitReason).toBe("exit code 1");
  });

  test("shell output without exit code just updates lastActiveAt", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const processes = new Map(s1.processes);
    const shellPid = "shell-003";
    const oldTime = "2020-01-01T00:00:00.000Z";
    processes.set(shellPid, {
      pid: shellPid,
      type: "lifecycle" as const,
      state: "running" as const,
      name: "watcher",
      parentPid: null,
      objective: "Watch files",
      priority: 50,
      spawnedAt: oldTime,
      lastActiveAt: oldTime,
      tickCount: 0,
      tokensUsed: 0,
      model: "gpt-4",
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan" as const,
      restartPolicy: "never" as const,
    });
    const shellState = { ...s1, processes };

    const [s2, effects] = transition(shellState, {
      type: "shell_output",
      pid: shellPid,
      hasStdout: true,
      hasStderr: false,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2.processes.get(shellPid)?.state).toBe("running");
    expect(s2.processes.get(shellPid)?.lastActiveAt).not.toBe(oldTime);
    expect(effects).toHaveLength(0);
  });

  test("shell output for unknown pid returns state unchanged", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const [s2, effects] = transition(s1, {
      type: "shell_output",
      pid: "nonexistent",
      hasStdout: true,
      hasStderr: false,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2).toBe(s1);
    expect(effects).toHaveLength(0);
  });

  test("shell exit emits activate_process for parent", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const processes = new Map(s1.processes);
    const shellPid = "shell-004";
    processes.set(shellPid, {
      pid: shellPid,
      type: "lifecycle" as const,
      state: "running" as const,
      name: "build-step",
      parentPid: orch.pid,
      objective: "Build project",
      priority: 50,
      spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tickCount: 0,
      tokensUsed: 0,
      model: "gpt-4",
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan" as const,
      restartPolicy: "never" as const,
    });
    const shellState = { ...s1, processes };

    const [, effects] = transition(shellState, {
      type: "shell_output",
      pid: shellPid,
      hasStdout: false,
      hasStderr: false,
      exitCode: 0,
      timestamp: Date.now(),
      seq: 99,
    });

    const wakeEffect = effects.find(e => e.type === "activate_process");
    expect(wakeEffect).toBeDefined();
    expect(wakeEffect!.type === "activate_process" && wakeEffect!.pid).toBe(orch.pid);
  });

  test("no-op when halted", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const haltedState = { ...s1, halted: true };

    const [s2, effects] = transition(haltedState, {
      type: "shell_output",
      pid: "any",
      hasStdout: true,
      hasStderr: false,
      exitCode: 0,
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2).toBe(haltedState);
    expect(effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// process_submitted
// ---------------------------------------------------------------------------

describe("transition — process_submitted", () => {
  test("no-op — returns state unchanged", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const [s2, effects] = transition(s1, {
      type: "process_submitted",
      pid: "some-pid",
      name: "worker",
      model: "gpt-4",
      timestamp: Date.now(),
      seq: 99,
    });

    expect(s2).toBe(s1);
    expect(effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deferral processing (integrated into housekeep + process_completed)
// ---------------------------------------------------------------------------

describe("transition — deferral processing", () => {
  function makeDeferral(overrides: Partial<import("../../../src/os/types.js").DeferEntry> & {
    condition: import("../../../src/os/types.js").DeferCondition;
    descriptor: { name: string; objective: string; type?: string };
  }): import("../../../src/os/types.js").DeferEntry {
    return {
      id: overrides.id ?? "defer-1",
      descriptor: {
        type: "lifecycle" as const,
        priority: 50,
        ...overrides.descriptor,
      },
      condition: overrides.condition,
      registeredAt: new Date().toISOString(),
      registeredAtMs: overrides.registeredAtMs ?? Date.now(),
      registeredByTick: overrides.registeredByTick ?? 0,
      registeredByPid: overrides.registeredByPid ?? null,
      reason: overrides.reason ?? "test deferral",
      maxWaitTicks: overrides.maxWaitTicks,
      maxWaitMs: overrides.maxWaitMs,
    };
  }

  test("housekeep triggers deferral when blackboard_key_exists condition met", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    // Add a deferral that waits for a blackboard key
    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-1", makeDeferral({
      condition: { type: "blackboard_key_exists", key: "research:done" },
      descriptor: { name: "writer", objective: "Write report" },
    }));

    // Add the key to blackboard
    const blackboard = new Map(s1.blackboard);
    blackboard.set("research:done", { value: true, writtenBy: "researcher", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    // Deferral should be consumed
    expect(s2.deferrals.size).toBe(0);
    // New process should be spawned
    const newProcs = [...s2.processes.values()].filter(p => p.name === "writer");
    expect(newProcs.length).toBe(1);
    expect(newProcs[0]!.state).toBe("running");
    // Should have submit_llm effect
    expect(effects.some(e => e.type === "submit_llm")).toBe(true);
  });

  test("housekeep does NOT trigger deferral when condition not met", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-1", makeDeferral({
      condition: { type: "blackboard_key_exists", key: "research:done" },
      descriptor: { name: "writer", objective: "Write report" },
    }));

    // NO blackboard key — condition not met
    const deferState = { ...s1, deferrals };
    const [s2] = transition(deferState, timerEvent("housekeep"));

    // Deferral should remain
    expect(s2.deferrals.size).toBe(1);
    // No new process
    const writers = [...s2.processes.values()].filter(p => p.name === "writer");
    expect(writers.length).toBe(0);
  });

  test("process_completed triggers process_dead deferral", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    // Add a worker process
    const processes = new Map(s1.processes);
    const workerPid = "worker-1";
    processes.set(workerPid, {
      pid: workerPid,
      type: "lifecycle" as const,
      state: "running" as const,
      name: "researcher",
      parentPid: orch.pid,
      objective: "Do research",
      priority: 50,
      spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tickCount: 1,
      tokensUsed: 100,
      model: "gpt-4",
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan" as const,
      restartPolicy: "never" as const,
    });
    orch.children = [workerPid];

    // Add a deferral that waits for researcher to die
    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-2", makeDeferral({
      id: "defer-2",
      condition: { type: "process_dead", pid: workerPid },
      descriptor: { name: "writer", objective: "Write based on research" },
      registeredByPid: orch.pid,
    }));

    const deferState = { ...s1, processes, deferrals };

    // Worker exits
    const [s2, effects] = transition(deferState, {
      type: "process_completed",
      pid: workerPid,
      name: "researcher",
      success: true,
      commandCount: 1,
      tokensUsed: 100,
      commands: [{ kind: "exit" as const, code: 0, reason: "done" }],
      response: "Research complete.",
      timestamp: Date.now(),
      seq: 99,
    });

    // Worker should be dead
    expect(s2.processes.get(workerPid)?.state).toBe("dead");
    // Deferral should be consumed — process_dead condition met
    expect(s2.deferrals.size).toBe(0);
    // Writer should be spawned
    const writers = [...s2.processes.values()].filter(p => p.name === "writer");
    expect(writers.length).toBe(1);
    // submit_llm for the writer
    expect(effects.some(e => e.type === "submit_llm" && "name" in e && e.name === "writer")).toBe(true);
  });

  test("deferral TTL expiry spawns process anyway", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-ttl", makeDeferral({
      id: "defer-ttl",
      condition: { type: "blackboard_key_exists", key: "never-written" },
      descriptor: { name: "impatient-worker", objective: "Do work" },
      registeredAtMs: Date.now() - 100000, // registered 100s ago
      maxWaitMs: 5000, // TTL 5s — long expired
    }));

    const deferState = { ...s1, deferrals };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    // Should spawn despite condition not met
    expect(s2.deferrals.size).toBe(0);
    const workers = [...s2.processes.values()].filter(p => p.name === "impatient-worker");
    expect(workers.length).toBe(1);
    expect(effects.some(e =>
      e.type === "emit_protocol" && "message" in e && e.message.includes("expired_but_spawned")
    )).toBe(true);
  });

  test("deferral TTL expiry via maxWaitTicks spawns process anyway", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-tick-ttl", makeDeferral({
      id: "defer-tick-ttl",
      condition: { type: "blackboard_key_exists", key: "never-written" },
      descriptor: { name: "tick-expired-worker", objective: "Do work" },
      registeredByTick: 0,
      maxWaitTicks: 3, // Expired: current tickCount > registeredByTick + maxWaitTicks
    }));

    // Advance tickCount past the TTL
    const deferState = { ...s1, deferrals, tickCount: 5 };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(0);
    const workers = [...s2.processes.values()].filter(p => p.name === "tick-expired-worker");
    expect(workers.length).toBe(1);
    expect(effects.some(e =>
      e.type === "emit_protocol" && "message" in e && e.message.includes("expired_but_spawned")
    )).toBe(true);
    expect(effects.some(e => e.type === "submit_llm")).toBe(true);
  });

  test("blackboard_key_match condition triggers when value matches", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-match", makeDeferral({
      id: "defer-match",
      condition: { type: "blackboard_key_match", key: "status", value: "ready" },
      descriptor: { name: "match-worker", objective: "Work when ready" },
    }));

    // Set matching value
    const blackboard = new Map(s1.blackboard);
    blackboard.set("status", { value: "ready", writtenBy: "coordinator", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(0);
    const workers = [...s2.processes.values()].filter(p => p.name === "match-worker");
    expect(workers.length).toBe(1);
    expect(effects.some(e => e.type === "submit_llm")).toBe(true);
  });

  test("blackboard_key_match condition does NOT trigger when value differs", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-match", makeDeferral({
      id: "defer-match",
      condition: { type: "blackboard_key_match", key: "status", value: "ready" },
      descriptor: { name: "match-worker", objective: "Work when ready" },
    }));

    // Set NON-matching value
    const blackboard = new Map(s1.blackboard);
    blackboard.set("status", { value: "pending", writtenBy: "coordinator", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(1);
    const workers = [...s2.processes.values()].filter(p => p.name === "match-worker");
    expect(workers.length).toBe(0);
  });

  test("blackboard_value_contains condition triggers on substring match", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-contains", makeDeferral({
      id: "defer-contains",
      condition: { type: "blackboard_value_contains", key: "log", substring: "ERROR" },
      descriptor: { name: "error-handler", objective: "Handle error" },
    }));

    const blackboard = new Map(s1.blackboard);
    blackboard.set("log", { value: "Step 1 OK, Step 2 ERROR: timeout", writtenBy: "monitor", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(0);
    const workers = [...s2.processes.values()].filter(p => p.name === "error-handler");
    expect(workers.length).toBe(1);
    expect(effects.some(e => e.type === "submit_llm")).toBe(true);
  });

  test("blackboard_value_contains works with non-string values (JSON serialized)", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-json", makeDeferral({
      id: "defer-json",
      condition: { type: "blackboard_value_contains", key: "data", substring: "critical" },
      descriptor: { name: "json-worker", objective: "Handle critical" },
    }));

    const blackboard = new Map(s1.blackboard);
    blackboard.set("data", { value: { status: "critical", count: 5 }, writtenBy: "sensor", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(0);
    const workers = [...s2.processes.values()].filter(p => p.name === "json-worker");
    expect(workers.length).toBe(1);
  });

  test("process_dead_by_name triggers when all matching processes are dead", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    // Add two workers with the same name
    const processes = new Map(s1.processes);
    processes.set("w1", {
      pid: "w1", type: "lifecycle" as const, state: "dead" as const,
      name: "researcher", parentPid: orch.pid, objective: "Research A",
      priority: 50, spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });
    processes.set("w2", {
      pid: "w2", type: "lifecycle" as const, state: "dead" as const,
      name: "researcher", parentPid: orch.pid, objective: "Research B",
      priority: 50, spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-by-name", makeDeferral({
      id: "defer-by-name",
      condition: { type: "process_dead_by_name", name: "researcher" },
      descriptor: { name: "synthesizer", objective: "Combine research" },
    }));

    const deferState = { ...s1, processes, deferrals };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(0);
    const synths = [...s2.processes.values()].filter(p => p.name === "synthesizer");
    expect(synths.length).toBe(1);
    expect(effects.some(e => e.type === "submit_llm")).toBe(true);
  });

  test("process_dead_by_name does NOT trigger when some matching processes still alive", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const processes = new Map(s1.processes);
    processes.set("w1", {
      pid: "w1", type: "lifecycle" as const, state: "dead" as const,
      name: "researcher", parentPid: orch.pid, objective: "Research A",
      priority: 50, spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });
    processes.set("w2", {
      pid: "w2", type: "lifecycle" as const, state: "running" as const, // still alive
      name: "researcher", parentPid: orch.pid, objective: "Research B",
      priority: 50, spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-by-name", makeDeferral({
      id: "defer-by-name",
      condition: { type: "process_dead_by_name", name: "researcher" },
      descriptor: { name: "synthesizer", objective: "Combine research" },
    }));

    const deferState = { ...s1, processes, deferrals };
    const [s2] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(1);
    const synths = [...s2.processes.values()].filter(p => p.name === "synthesizer");
    expect(synths.length).toBe(0);
  });

  test("all_of composite condition triggers when all sub-conditions met", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-all", makeDeferral({
      id: "defer-all",
      condition: {
        type: "all_of",
        conditions: [
          { type: "blackboard_key_exists", key: "data:ready" },
          { type: "blackboard_key_match", key: "mode", value: "production" },
        ],
      },
      descriptor: { name: "all-met-worker", objective: "Both conditions met" },
    }));

    const blackboard = new Map(s1.blackboard);
    blackboard.set("data:ready", { value: true, writtenBy: "loader", version: 1 });
    blackboard.set("mode", { value: "production", writtenBy: "config", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(0);
    const workers = [...s2.processes.values()].filter(p => p.name === "all-met-worker");
    expect(workers.length).toBe(1);
    expect(effects.some(e => e.type === "submit_llm")).toBe(true);
  });

  test("all_of composite condition does NOT trigger when one sub-condition not met", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-all", makeDeferral({
      id: "defer-all",
      condition: {
        type: "all_of",
        conditions: [
          { type: "blackboard_key_exists", key: "data:ready" },
          { type: "blackboard_key_match", key: "mode", value: "production" },
        ],
      },
      descriptor: { name: "all-met-worker", objective: "Both conditions met" },
    }));

    // Only one condition met
    const blackboard = new Map(s1.blackboard);
    blackboard.set("data:ready", { value: true, writtenBy: "loader", version: 1 });
    // "mode" key missing

    const deferState = { ...s1, deferrals, blackboard };
    const [s2] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(1);
  });

  test("any_of composite condition triggers when at least one sub-condition met", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-any", makeDeferral({
      id: "defer-any",
      condition: {
        type: "any_of",
        conditions: [
          { type: "blackboard_key_exists", key: "fast-path:done" },
          { type: "blackboard_key_exists", key: "slow-path:done" },
        ],
      },
      descriptor: { name: "any-met-worker", objective: "One path complete" },
    }));

    // Only one condition met
    const blackboard = new Map(s1.blackboard);
    blackboard.set("fast-path:done", { value: true, writtenBy: "fast", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(0);
    const workers = [...s2.processes.values()].filter(p => p.name === "any-met-worker");
    expect(workers.length).toBe(1);
    expect(effects.some(e => e.type === "submit_llm")).toBe(true);
  });

  test("any_of composite condition does NOT trigger when no sub-conditions met", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-any", makeDeferral({
      id: "defer-any",
      condition: {
        type: "any_of",
        conditions: [
          { type: "blackboard_key_exists", key: "fast-path:done" },
          { type: "blackboard_key_exists", key: "slow-path:done" },
        ],
      },
      descriptor: { name: "any-met-worker", objective: "One path complete" },
    }));

    // No conditions met — empty blackboard
    const deferState = { ...s1, deferrals };
    const [s2] = transition(deferState, timerEvent("housekeep"));

    expect(s2.deferrals.size).toBe(1);
  });

  test("triggered deferrals are removed while untriggered remain", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    // This one will trigger
    deferrals.set("defer-triggered", makeDeferral({
      id: "defer-triggered",
      condition: { type: "blackboard_key_exists", key: "signal:go" },
      descriptor: { name: "triggered-worker", objective: "Go" },
    }));
    // This one will NOT trigger
    deferrals.set("defer-waiting", makeDeferral({
      id: "defer-waiting",
      condition: { type: "blackboard_key_exists", key: "signal:later" },
      descriptor: { name: "waiting-worker", objective: "Wait" },
    }));

    const blackboard = new Map(s1.blackboard);
    blackboard.set("signal:go", { value: true, writtenBy: "controller", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2, effects] = transition(deferState, timerEvent("housekeep"));

    // Only the triggered deferral consumed
    expect(s2.deferrals.size).toBe(1);
    expect(s2.deferrals.has("defer-waiting")).toBe(true);
    expect(s2.deferrals.has("defer-triggered")).toBe(false);

    // New process spawned only for triggered
    const triggered = [...s2.processes.values()].filter(p => p.name === "triggered-worker");
    expect(triggered.length).toBe(1);
    const waiting = [...s2.processes.values()].filter(p => p.name === "waiting-worker");
    expect(waiting.length).toBe(0);

    // submit_llm effect for triggered process only
    const submitEffects = effects.filter(e => e.type === "submit_llm");
    expect(submitEffects.length).toBeGreaterThanOrEqual(1);
  });

  test("deferral-spawned process is registered as child of parent", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-child", makeDeferral({
      id: "defer-child",
      condition: { type: "blackboard_key_exists", key: "ready" },
      descriptor: { name: "child-worker", objective: "Child work" },
      registeredByPid: orch.pid,
    }));

    const blackboard = new Map(s1.blackboard);
    blackboard.set("ready", { value: true, writtenBy: "setup", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [s2] = transition(deferState, timerEvent("housekeep"));

    // Child worker should have parentPid set
    const child = [...s2.processes.values()].find(p => p.name === "child-worker")!;
    expect(child.parentPid).toBe(orch.pid);

    // Parent should have child in children array
    const parent = s2.processes.get(orch.pid)!;
    expect(parent.children).toContain(child.pid);
  });

  test("deferral emit_protocol effect includes trigger reason", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const deferrals = new Map<string, import("../../../src/os/types.js").DeferEntry>();
    deferrals.set("defer-reason", makeDeferral({
      id: "defer-reason",
      condition: { type: "blackboard_key_exists", key: "signal" },
      descriptor: { name: "reason-worker", objective: "Work" },
      reason: "waiting for upstream data",
    }));

    const blackboard = new Map(s1.blackboard);
    blackboard.set("signal", { value: true, writtenBy: "upstream", version: 1 });

    const deferState = { ...s1, deferrals, blackboard };
    const [, effects] = transition(deferState, timerEvent("housekeep"));

    const protocolEffect = effects.find(e =>
      e.type === "emit_protocol" && "message" in e && e.message.includes("waiting for upstream data")
    );
    expect(protocolEffect).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Typed effect emission tests (Wave 1.5)
// ---------------------------------------------------------------------------

describe("transition — typed effects: process_completed exit emits child_done_signal", () => {
  test("exit command emits child_done_signal with correct fields", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    // Add a child worker manually
    const workerState = addProcess(state, "w1", { priority: 50, parentPid: orchestratorPid });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    // Worker exits
    const [, effects] = transition(workerState, processCompletedEvent(worker.pid, {
      commands: [{ kind: "exit", code: 0, reason: "completed successfully" }],
    }));

    const childDone = effects.find(e => e.type === "child_done_signal");
    expect(childDone).toBeDefined();
    expect(childDone!.type === "child_done_signal" && childDone!.childPid).toBe(worker.pid);
    expect(childDone!.type === "child_done_signal" && childDone!.childName).toBe("w1");
    expect(childDone!.type === "child_done_signal" && childDone!.parentPid).toBe(orchestratorPid);
    expect(childDone!.type === "child_done_signal" && childDone!.exitCode).toBe(0);
    expect(childDone!.type === "child_done_signal" && childDone!.exitReason).toBe("completed successfully");
  });

  test("exit command emits flush_ipc after child_done_signal", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const workerState = addProcess(state, "w1", { priority: 50, parentPid: orchestratorPid });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    const [, effects] = transition(workerState, processCompletedEvent(worker.pid, {
      commands: [{ kind: "exit", code: 0, reason: "done" }],
    }));

    const flushIpc = effects.find(e => e.type === "flush_ipc");
    expect(flushIpc).toBeDefined();

    // flush_ipc should come after child_done_signal
    const childDoneIdx = effects.findIndex(e => e.type === "child_done_signal");
    const flushIdx = effects.findIndex(e => e.type === "flush_ipc");
    expect(childDoneIdx).toBeGreaterThanOrEqual(0);
    expect(flushIdx).toBeGreaterThan(childDoneIdx);
  });

  test("exit command emits rebuild_dag effect", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const workerState = addProcess(state, "w1", { priority: 50, parentPid: orchestratorPid });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    const [, effects] = transition(workerState, processCompletedEvent(worker.pid, {
      commands: [{ kind: "exit", code: 0, reason: "done" }],
    }));

    expect(effects.some(e => e.type === "rebuild_dag")).toBe(true);
  });

  test("parentless process exit does not emit child_done_signal", () => {
    const { state } = bootAndGetOrchestrator();

    // Add a parentless lifecycle process
    const orphanState = addProcess(state, "orphan-worker", { priority: 50, parentPid: null });
    const orphanPid = [...orphanState.processes.values()].find(p => p.name === "orphan-worker")!.pid;

    const [, effects] = transition(orphanState, processCompletedEvent(orphanPid, {
      commands: [{ kind: "exit", code: 0, reason: "done" }],
    }));

    // No child_done_signal because no parent
    expect(effects.some(e => e.type === "child_done_signal")).toBe(false);
    // But rebuild_dag should still be emitted
    expect(effects.some(e => e.type === "rebuild_dag")).toBe(true);
  });
});

describe("transition — typed effects: failed process emits child_done_signal", () => {
  test("failed process with parent emits child_done_signal with exit code 1", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const workerState = addProcess(state, "w1", { priority: 50, parentPid: orchestratorPid });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    const [, effects] = transition(workerState, processCompletedEvent(worker.pid, {
      success: false,
      response: "LLM crashed",
    }));

    const childDone = effects.find(e => e.type === "child_done_signal");
    expect(childDone).toBeDefined();
    expect(childDone!.type === "child_done_signal" && childDone!.childPid).toBe(worker.pid);
    expect(childDone!.type === "child_done_signal" && childDone!.parentPid).toBe(orchestratorPid);
    expect(childDone!.type === "child_done_signal" && childDone!.exitCode).toBe(1);
  });

  test("failed process emits flush_ipc and rebuild_dag", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const workerState = addProcess(state, "w1", { priority: 50, parentPid: orchestratorPid });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    const [, effects] = transition(workerState, processCompletedEvent(worker.pid, {
      success: false,
      response: "error",
    }));

    expect(effects.some(e => e.type === "flush_ipc")).toBe(true);
    expect(effects.some(e => e.type === "rebuild_dag")).toBe(true);
  });

  test("failed parentless process emits rebuild_dag but not child_done_signal", () => {
    const { state } = bootAndGetOrchestrator();

    // Add a parentless lifecycle process
    const orphanState = addProcess(state, "orphan-worker", { priority: 50, parentPid: null });
    const orphanPid = [...orphanState.processes.values()].find(p => p.name === "orphan-worker")!.pid;

    const [, effects] = transition(orphanState, processCompletedEvent(orphanPid, {
      success: false,
      response: "crashed",
    }));

    expect(effects.some(e => e.type === "child_done_signal")).toBe(false);
    expect(effects.some(e => e.type === "rebuild_dag")).toBe(true);
  });
});

describe("transition — typed effects: signal_emit command emits signal_emit effect", () => {
  test("signal_emit command produces signal_emit and flush_ipc effects", () => {
    const { state } = bootAndGetOrchestrator();
    const workerState = addProcess(state, "w1", { priority: 50 });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;

    const [, effects] = transition(workerState, processCompletedEvent(worker.pid, {
      commands: [
        { kind: "signal_emit", signal: "data:ready" },
        { kind: "idle" },
      ],
    }));

    const signalEffect = effects.find(e => e.type === "signal_emit");
    expect(signalEffect).toBeDefined();
    expect(signalEffect!.type === "signal_emit" && signalEffect!.signal).toBe("data:ready");
    expect(signalEffect!.type === "signal_emit" && signalEffect!.sender).toBe(worker.pid);

    expect(effects.some(e => e.type === "flush_ipc")).toBe(true);
  });
});

describe("transition — typed effects: ephemeral_completed emits signal_emit + flush_ipc", () => {
  function setupWithEphemeral() {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const ephPid = "eph-typed-1";
    const processes = new Map(s1.processes);
    processes.set(ephPid, {
      pid: ephPid, type: "event" as const, state: "running" as const,
      name: "scout-typed", parentPid: orch.pid, objective: "find something",
      priority: 50, spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 0, tokensUsed: 0, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });
    return { state: { ...s1, processes }, orchPid: orch.pid, ephPid };
  }

  test("successful ephemeral emits signal_emit with ephemeral:ready signal", () => {
    const { state, orchPid, ephPid } = setupWithEphemeral();
    const [, effects] = transition(state, {
      type: "ephemeral_completed",
      id: "eph-signal-test",
      name: "scout-typed",
      success: true,
      tablePid: ephPid,
      parentPid: orchPid,
      response: "Found it",
      durationMs: 500,
      model: "gpt-4",
      timestamp: Date.now(),
      seq: 0,
    });

    const signalEffect = effects.find(e => e.type === "signal_emit");
    expect(signalEffect).toBeDefined();
    expect(signalEffect!.type === "signal_emit" && signalEffect!.signal).toBe("ephemeral:ready");
    expect(signalEffect!.type === "signal_emit" && signalEffect!.sender).toBe("kernel");
    const payload = signalEffect!.type === "signal_emit" ? signalEffect!.payload : undefined;
    expect(payload).toBeDefined();
    expect(payload!.name).toBe("scout-typed");
    expect(payload!.parentPid).toBe(orchPid);
    expect(payload!.id).toBe("eph-signal-test");
    expect(payload!.error).toBe(false);
  });

  test("failed ephemeral emits signal_emit with error flag in payload", () => {
    const { state, orchPid, ephPid } = setupWithEphemeral();
    const [, effects] = transition(state, {
      type: "ephemeral_completed",
      id: "eph-fail-signal",
      name: "scout-typed",
      success: false,
      tablePid: ephPid,
      parentPid: orchPid,
      error: "timeout",
      durationMs: 30000,
      model: "gpt-4",
      timestamp: Date.now(),
      seq: 0,
    });

    const signalEffect = effects.find(e => e.type === "signal_emit");
    expect(signalEffect).toBeDefined();
    const payload = signalEffect!.type === "signal_emit" ? signalEffect!.payload : undefined;
    expect(payload!.error).toBe(true);
  });

  test("ephemeral_completed emits flush_ipc after signal_emit", () => {
    const { state, orchPid, ephPid } = setupWithEphemeral();
    const [, effects] = transition(state, {
      type: "ephemeral_completed",
      id: "eph-flush-test",
      name: "scout-typed",
      success: true,
      tablePid: ephPid,
      parentPid: orchPid,
      response: "result",
      durationMs: 100,
      model: "gpt-4",
      timestamp: Date.now(),
      seq: 0,
    });

    const signalIdx = effects.findIndex(e => e.type === "signal_emit");
    const flushIdx = effects.findIndex(e => e.type === "flush_ipc");
    expect(signalIdx).toBeGreaterThanOrEqual(0);
    expect(flushIdx).toBeGreaterThan(signalIdx);
  });

  test("ephemeral_completed without tablePid emits no signal_emit or flush_ipc", () => {
    const { state } = setupWithEphemeral();
    const [, effects] = transition(state, {
      type: "ephemeral_completed",
      id: "eph-no-table",
      name: "scout-typed",
      success: true,
      timestamp: Date.now(),
      seq: 0,
    });

    expect(effects.some(e => e.type === "signal_emit")).toBe(false);
    expect(effects.some(e => e.type === "flush_ipc")).toBe(false);
  });
});


describe("transition — typed effects: housekeep cadence signals emit signal_emit", () => {
  test("cadence signal emits signal_emit with correct signal name and payload", () => {
    const state = makeState({ tickSignalCadences: [1, 5, 10] });
    const [s1] = transition(state, bootEvent());

    // First housekeep: count=1, cadence 1 matches
    const [, effects] = transition(s1, timerEvent("housekeep"));

    const signalEffects = effects.filter(e => e.type === "signal_emit");
    expect(signalEffects.length).toBeGreaterThanOrEqual(1);

    const tick1Signal = signalEffects.find(
      e => e.type === "signal_emit" && e.signal === "tick:1"
    );
    expect(tick1Signal).toBeDefined();
    expect(tick1Signal!.type === "signal_emit" && tick1Signal!.sender).toBe("kernel");
    const payload = tick1Signal!.type === "signal_emit" ? tick1Signal!.payload : undefined;
    expect(payload).toBeDefined();
    expect(payload!.cadence).toBe(1);
    expect(payload!.tick).toBe(1);
  });

  test("cadence 5 fires on housekeepCount=5", () => {
    const state = makeState({ tickSignalCadences: [1, 5, 10] });
    const [s1] = transition(state, bootEvent());
    // Set housekeepCount to 4 so next housekeep fires at count=5
    const s1AtTick4 = { ...s1, housekeepCount: 4 };

    const [, effects] = transition(s1AtTick4, timerEvent("housekeep"));

    const signalEffects = effects.filter(e => e.type === "signal_emit");
    const signals = signalEffects.map(e => e.type === "signal_emit" ? e.signal : "");
    // tick:1 and tick:5 should both fire (5 % 1 === 0 and 5 % 5 === 0)
    expect(signals).toContain("tick:1");
    expect(signals).toContain("tick:5");
    // tick:10 should NOT fire (5 % 10 !== 0)
    expect(signals).not.toContain("tick:10");
  });

  test("cadence signals emit flush_ipc after all signals", () => {
    const state = makeState({ tickSignalCadences: [1, 5] });
    const [s1] = transition(state, bootEvent());

    const [, effects] = transition(s1, timerEvent("housekeep"));

    // flush_ipc should exist
    expect(effects.some(e => e.type === "flush_ipc")).toBe(true);

    // flush_ipc should come after all signal_emit effects
    const lastSignalIdx = effects.reduce(
      (max, e, i) => e.type === "signal_emit" ? i : max, -1
    );
    const flushIdx = effects.findIndex(e => e.type === "flush_ipc");
    expect(flushIdx).toBeGreaterThan(lastSignalIdx);
  });

  test("no cadence signal when housekeepCount does not match any cadence", () => {
    const state = makeState({ tickSignalCadences: [3, 7] });
    const [s1] = transition(state, bootEvent());
    // housekeepCount=0 → next will be 1. 1%3≠0, 1%7≠0
    const [, effects] = transition(s1, timerEvent("housekeep"));

    expect(effects.some(e => e.type === "signal_emit")).toBe(false);
    expect(effects.some(e => e.type === "flush_ipc")).toBe(false);
  });
});

// Orchestrator deadlock detection removed — handled by metacog now.

// ---------------------------------------------------------------------------
// Wave 2: Process Lifecycle Through Effects
// ---------------------------------------------------------------------------

describe("transition — Wave 2: parent wake via activate_process on child exit", () => {
  test("child exit emits activate_process for idle parent", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    // Set up: parent is idle, has a running child
    const processes = new Map(s1.processes);
    processes.set(orch.pid, {
      ...orch,
      state: "idle" as const,
      tickCount: 2,
      wakeOnSignals: ["child:done"],
      children: ["child-1"],
    });
    processes.set("child-1", {
      pid: "child-1", type: "lifecycle" as const, state: "running" as const,
      name: "worker-1", parentPid: orch.pid, objective: "do work", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });

    const stateWithChild = { ...s1, processes };

    // Child completes with exit
    const event: KernelEvent = {
      type: "process_completed",
      pid: "child-1",
      name: "worker-1",
      success: true,
      commandCount: 1,
      tokensUsed: 50,
      commands: [{ kind: "exit" as const, code: 0, reason: "done" }],
      response: "work complete",
      timestamp: Date.now(),
      seq: 1,
    };

    const [newState, effects] = transition(stateWithChild, event);

    // Parent should be activated
    const activateEffects = effects.filter(
      e => e.type === "activate_process" && e.pid === orch.pid
    );
    expect(activateEffects.length).toBe(1);

    // Parent state should be running in the new state
    const parentState = newState.processes.get(orch.pid);
    expect(parentState?.state).toBe("running");
  });

  test("child failure emits activate_process for idle parent", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const processes = new Map(s1.processes);
    processes.set(orch.pid, {
      ...orch,
      state: "idle" as const,
      tickCount: 2,
      wakeOnSignals: ["child:done"],
      children: ["child-fail"],
    });
    processes.set("child-fail", {
      pid: "child-fail", type: "lifecycle" as const, state: "running" as const,
      name: "failing-worker", parentPid: orch.pid, objective: "fail", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });

    const stateWithChild = { ...s1, processes };

    // Child fails
    const event: KernelEvent = {
      type: "process_completed",
      pid: "child-fail",
      name: "failing-worker",
      success: false,
      commandCount: 0,
      tokensUsed: 30,
      commands: [],
      response: "error occurred",
      timestamp: Date.now(),
      seq: 1,
    };

    const [newState, effects] = transition(stateWithChild, event);

    // Parent should be activated via effects
    const activateEffects = effects.filter(
      e => e.type === "activate_process" && e.pid === orch.pid
    );
    expect(activateEffects.length).toBe(1);

    // Parent state should be running
    const parentState = newState.processes.get(orch.pid);
    expect(parentState?.state).toBe("running");
  });

  test("no activate_process for already-running parent when child exits", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent());
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const processes = new Map(s1.processes);
    // Parent is already running
    processes.set(orch.pid, {
      ...orch,
      state: "running" as const,
      tickCount: 2,
      children: ["child-2"],
    });
    processes.set("child-2", {
      pid: "child-2", type: "lifecycle" as const, state: "running" as const,
      name: "worker-2", parentPid: orch.pid, objective: "work", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });

    const stateWithChild = { ...s1, processes };

    const event: KernelEvent = {
      type: "process_completed",
      pid: "child-2",
      name: "worker-2",
      success: true,
      commandCount: 1,
      tokensUsed: 50,
      commands: [{ kind: "exit" as const, code: 0, reason: "done" }],
      response: "complete",
      timestamp: Date.now(),
      seq: 1,
    };

    const [, effects] = transition(stateWithChild, event);

    // No activate_process for parent since it's already running
    const activateParent = effects.filter(
      e => e.type === "activate_process" && e.pid === orch.pid
    );
    expect(activateParent.length).toBe(0);
  });
});

describe("transition — Wave 2: daemon idle emits idle_process effect", () => {
  test("daemon idle command emits idle_process effect", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    // Create a daemon process that's running
    const processes = new Map(s1.processes);
    processes.set("daemon-1", {
      pid: "daemon-1", type: "daemon" as const, state: "running" as const,
      name: "test-daemon", parentPid: null, objective: "monitor", priority: 40,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "always" as const,
    });

    const stateWithDaemon = { ...s1, processes };

    // Daemon completes with idle command
    const event: KernelEvent = {
      type: "process_completed",
      pid: "daemon-1",
      name: "test-daemon",
      success: true,
      commandCount: 1,
      tokensUsed: 20,
      commands: [{ kind: "idle" as const, wakeOnSignals: ["tick:1"] }],
      response: "monitoring complete",
      timestamp: Date.now(),
      seq: 1,
    };

    const [newState, effects] = transition(stateWithDaemon, event);

    // idle_process effect should be emitted
    const idleEffects = effects.filter(e => e.type === "idle_process");
    expect(idleEffects.length).toBe(1);
    expect(idleEffects[0]!.type === "idle_process" && idleEffects[0]!.pid).toBe("daemon-1");
    expect(idleEffects[0]!.type === "idle_process" && idleEffects[0]!.wakeOnSignals).toEqual(["tick:1"]);

    // Process state should be idle
    const daemonState = newState.processes.get("daemon-1");
    expect(daemonState?.state).toBe("idle");
  });

  test("idle command without wakeOnSignals still emits idle_process", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const processes = new Map(s1.processes);
    processes.set("daemon-2", {
      pid: "daemon-2", type: "daemon" as const, state: "running" as const,
      name: "test-daemon-2", parentPid: null, objective: "watch", priority: 40,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 50, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "always" as const,
    });

    const stateWithDaemon = { ...s1, processes };

    const event: KernelEvent = {
      type: "process_completed",
      pid: "daemon-2",
      name: "test-daemon-2",
      success: true,
      commandCount: 1,
      tokensUsed: 10,
      commands: [{ kind: "idle" as const }],
      response: "done",
      timestamp: Date.now(),
      seq: 1,
    };

    const [, effects] = transition(stateWithDaemon, event);

    const idleEffects = effects.filter(e => e.type === "idle_process");
    expect(idleEffects.length).toBe(1);
    expect(idleEffects[0]!.type === "idle_process" && idleEffects[0]!.wakeOnSignals).toBeUndefined();
  });
});

describe("transition — Wave 2: sleeper waking emits activate_process", () => {
  test("expired sleeper gets activate_process in housekeep", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const processes = new Map(s1.processes);
    // Add a sleeping process with an expired sleepUntil
    const expiredTime = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    processes.set("sleeper-1", {
      pid: "sleeper-1", type: "lifecycle" as const, state: "sleeping" as const,
      name: "sleeping-worker", parentPid: null, objective: "wait", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
      sleepUntil: expiredTime,
    });

    const stateWithSleeper = { ...s1, processes };

    const [newState, effects] = transition(stateWithSleeper, timerEvent("housekeep", {
      pendingEphemeralCount: 0,
    }));

    // activate_process effect for the woken sleeper
    const activateEffects = effects.filter(
      e => e.type === "activate_process" && e.pid === "sleeper-1"
    );
    expect(activateEffects.length).toBe(1);

    // Process should be running now
    const sleeperState = newState.processes.get("sleeper-1");
    expect(sleeperState?.state).toBe("running");
    expect(sleeperState?.sleepUntil).toBeUndefined();
  });

  test("non-expired sleeper does NOT get activate_process", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const processes = new Map(s1.processes);
    const futureTime = new Date(Date.now() + 60000).toISOString(); // 60 seconds from now
    processes.set("sleeper-2", {
      pid: "sleeper-2", type: "lifecycle" as const, state: "sleeping" as const,
      name: "still-sleeping", parentPid: null, objective: "wait", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
      sleepUntil: futureTime,
    });

    const stateWithSleeper = { ...s1, processes };

    const [newState, effects] = transition(stateWithSleeper, timerEvent("housekeep", {
      pendingEphemeralCount: 0,
    }));

    // No activate_process for non-expired sleeper
    const activateEffects = effects.filter(
      e => e.type === "activate_process" && e.pid === "sleeper-2"
    );
    expect(activateEffects.length).toBe(0);

    // Process should still be sleeping
    const sleeperState = newState.processes.get("sleeper-2");
    expect(sleeperState?.state).toBe("sleeping");
  });
});

describe("transition — Wave 2: checkpoint restoration emits activate_process", () => {
  test("checkpointed process gets activate_process in housekeep", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const processes = new Map(s1.processes);
    processes.set("cp-1", {
      pid: "cp-1", type: "lifecycle" as const, state: "checkpoint" as const,
      name: "checkpointed-worker", parentPid: null, objective: "work", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 3, tokensUsed: 200, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });

    const stateWithCheckpoint = { ...s1, processes };

    const [newState, effects] = transition(stateWithCheckpoint, timerEvent("housekeep", {
      pendingEphemeralCount: 0,
    }));

    // activate_process effect for the restored process
    const activateEffects = effects.filter(
      e => e.type === "activate_process" && e.pid === "cp-1"
    );
    expect(activateEffects.length).toBe(1);

    // Process should be running now
    const procState = newState.processes.get("cp-1");
    expect(procState?.state).toBe("running");
  });
});

// Executive exit prevention removed — processes can now exit freely.

// ---------------------------------------------------------------------------
// Wave 3: Housekeep I/O migration — zombie reaping, daemon restart, strategy
// ---------------------------------------------------------------------------

describe("transition — housekeep zombie reaping", () => {
  test("dead parent's living children are reparented to root", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent("test"));
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const processes = new Map(s1.processes);

    // Create a dead parent with a living child
    processes.set("dead-parent", {
      pid: "dead-parent", type: "lifecycle" as const, state: "dead" as const,
      name: "dead-parent", parentPid: orch.pid, objective: "old work", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 3, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: ["orphan-child"], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
      exitCode: 0, exitReason: "completed",
    });
    processes.set("orphan-child", {
      pid: "orphan-child", type: "lifecycle" as const, state: "running" as const,
      name: "orphan-child", parentPid: "dead-parent", objective: "active work", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 1, tokensUsed: 50, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
    });

    // Add dead-parent as child of orchestrator
    processes.set(orch.pid, { ...orch, children: [...orch.children, "dead-parent"] });

    const stateWithZombie = { ...s1, processes };
    const [newState, effects] = transition(stateWithZombie, timerEvent("housekeep"));

    // Orphan child should be reparented to root (orchestrator)
    const orphan = newState.processes.get("orphan-child");
    expect(orphan).toBeDefined();
    expect(orphan!.parentPid).toBe(orch.pid);

    // Orchestrator should now have the orphan as a child
    const rootProc = newState.processes.get(orch.pid);
    expect(rootProc!.children).toContain("orphan-child");

    // Dead parent should have orphan removed from children
    const deadParent = newState.processes.get("dead-parent");
    expect(deadParent!.children).not.toContain("orphan-child");

    // Should emit a protocol event about zombie reaping
    const reapEffects = effects.filter(
      e => e.type === "emit_protocol" && "message" in e && (e.message as string).includes("zombie_reap")
    );
    expect(reapEffects.length).toBeGreaterThan(0);
  });

  test("dead parent with only dead children does not trigger reparenting", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent("test"));
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });
    const orch = [...s1.processes.values()].find(p => p.name === "worker-A")!;

    const processes = new Map(s1.processes);

    processes.set("dead-parent", {
      pid: "dead-parent", type: "lifecycle" as const, state: "dead" as const,
      name: "dead-parent", parentPid: orch.pid, objective: "old work", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 3, tokensUsed: 100, model: "gpt-4", workingDir: "/tmp",
      children: ["dead-child"], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
      exitCode: 0, exitReason: "completed",
    });
    processes.set("dead-child", {
      pid: "dead-child", type: "lifecycle" as const, state: "dead" as const,
      name: "dead-child", parentPid: "dead-parent", objective: "old child work", priority: 50,
      spawnedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      tickCount: 2, tokensUsed: 80, model: "gpt-4", workingDir: "/tmp",
      children: [], onParentDeath: "orphan" as const, restartPolicy: "never" as const,
      exitCode: 0, exitReason: "completed",
    });

    const stateWithDeadFamily = { ...s1, processes };
    const [newState, effects] = transition(stateWithDeadFamily, timerEvent("housekeep"));

    // Dead child should NOT be reparented (it's dead too)
    const deadChild = newState.processes.get("dead-child");
    expect(deadChild!.parentPid).toBe("dead-parent");

    // No zombie_reap protocol effect
    const reapEffects = effects.filter(
      e => e.type === "emit_protocol" && "message" in e && (e.message as string).includes("zombie_reap")
    );
    expect(reapEffects).toHaveLength(0);
  });
});

// Daemon restart removed from housekeep — daemons are kernel-level modules now.

// Strategy application removed from housekeep — scheduling strategies
// are handled through topology reconcile now.

// rebuild_dag removed from housekeep — only emitted on process exit/failure now.

// ---------------------------------------------------------------------------
// Wave 4: Scheduling Through Transition
// ---------------------------------------------------------------------------

function makeProcess(overrides: Partial<import("../../../src/os/types.js").OsProcess> & { pid: string; name: string }): import("../../../src/os/types.js").OsProcess {
  return {
    type: "lifecycle",
    state: "running",
    parentPid: null,
    objective: "test objective",
    priority: 50,
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

describe("selectRunnable — pure scheduling (Wave 4)", () => {
  test("priority strategy selects highest priority processes", () => {
    const procs = [
      makeProcess({ pid: "a", name: "low", priority: 10, state: "running" }),
      makeProcess({ pid: "b", name: "high", priority: 90, state: "running" }),
      makeProcess({ pid: "c", name: "mid", priority: 50, state: "running" }),
    ];
    const { selected } = selectRunnable(procs, procs, {
      strategy: "priority",
      maxConcurrent: 2,
      roundRobinIndex: 0,
      heuristics: [],
      currentStrategies: [],
    });

    expect(selected).toHaveLength(2);
    expect(selected[0]!.pid).toBe("b"); // highest priority
    expect(selected[1]!.pid).toBe("c"); // second highest
  });

  test("excludes non-running processes", () => {
    const procs = [
      makeProcess({ pid: "a", name: "running", priority: 50, state: "running" }),
      makeProcess({ pid: "b", name: "idle", priority: 90, state: "idle" }),
      makeProcess({ pid: "c", name: "dead", priority: 80, state: "dead" }),
    ];
    const { selected } = selectRunnable(procs, procs, {
      strategy: "priority",
      maxConcurrent: 5,
      roundRobinIndex: 0,
      heuristics: [],
      currentStrategies: [],
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]!.pid).toBe("a");
  });

  test("maxConcurrent limit is respected", () => {
    const procs = [
      makeProcess({ pid: "a", name: "p1", priority: 90, state: "running" }),
      makeProcess({ pid: "b", name: "p2", priority: 80, state: "running" }),
      makeProcess({ pid: "c", name: "p3", priority: 70, state: "running" }),
      makeProcess({ pid: "d", name: "p4", priority: 60, state: "running" }),
    ];
    const { selected } = selectRunnable(procs, procs, {
      strategy: "priority",
      maxConcurrent: 2,
      roundRobinIndex: 0,
      heuristics: [],
      currentStrategies: [],
    });

    expect(selected).toHaveLength(2);
    expect(selected[0]!.pid).toBe("a");
    expect(selected[1]!.pid).toBe("b");
  });

  test("round-robin strategy cycles through processes", () => {
    const procs = [
      makeProcess({ pid: "a", name: "p1", state: "running" }),
      makeProcess({ pid: "b", name: "p2", state: "running" }),
      makeProcess({ pid: "c", name: "p3", state: "running" }),
    ];
    const input = {
      strategy: "round-robin" as const,
      maxConcurrent: 1,
      roundRobinIndex: 0,
      heuristics: [],
      currentStrategies: [],
    };

    // First call: index 0
    const r1 = selectRunnable(procs, procs, input);
    expect(r1.selected).toHaveLength(1);
    expect(r1.selected[0]!.pid).toBe("a");
    expect(r1.roundRobinIndex).toBe(1);

    // Second call with updated index
    const r2 = selectRunnable(procs, procs, { ...input, roundRobinIndex: r1.roundRobinIndex });
    expect(r2.selected[0]!.pid).toBe("b");
    expect(r2.roundRobinIndex).toBe(2);

    // Third call wraps around
    const r3 = selectRunnable(procs, procs, { ...input, roundRobinIndex: r2.roundRobinIndex });
    expect(r3.selected[0]!.pid).toBe("c");
    expect(r3.roundRobinIndex).toBe(0);
  });

  test("learned strategy applies sibling contention gradient", () => {
    const now = new Date().toISOString();
    const procs = [
      makeProcess({ pid: "a", name: "worker-1", priority: 50, state: "running", parentPid: "root", spawnedAt: now }),
      makeProcess({ pid: "b", name: "worker-2", priority: 50, state: "running", parentPid: "root", spawnedAt: new Date(Date.now() + 1000).toISOString() }),
    ];
    const { selected } = selectRunnable(procs, procs, {
      strategy: "learned",
      maxConcurrent: 1,
      roundRobinIndex: 0,
      heuristics: [],
      currentStrategies: [],
    });

    // First sibling (by spawnedAt) keeps priority, second gets -2
    expect(selected).toHaveLength(1);
    expect(selected[0]!.pid).toBe("a");
  });

  test("returns empty when no processes are running", () => {
    const procs = [
      makeProcess({ pid: "a", name: "idle", state: "idle" }),
      makeProcess({ pid: "b", name: "dead", state: "dead" }),
    ];
    const { selected } = selectRunnable(procs, procs, {
      strategy: "priority",
      maxConcurrent: 5,
      roundRobinIndex: 0,
      heuristics: [],
      currentStrategies: [],
    });

    expect(selected).toHaveLength(0);
  });
});

describe("transition — housekeep scheduling (Wave 4)", () => {
  test("handleHousekeep emits submit_llm effects for runnable processes", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent("test"));
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });

    // worker-A is in "running" state after addProcess
    const orchestrator = [...s1.processes.values()].find(p => p.name === "worker-A");
    expect(orchestrator).toBeDefined();
    expect(orchestrator!.state).toBe("running");

    const [, effects] = transition(s1, timerEvent("housekeep"));

    // Should emit submit_llm for the running worker-A
    const submitEffects = effects.filter(e => e.type === "submit_llm");
    expect(submitEffects.length).toBeGreaterThanOrEqual(1);

    const orchSubmit = submitEffects.find(e => "pid" in e && e.pid === orchestrator!.pid);
    expect(orchSubmit).toBeDefined();
  });

  test("inflight processes are excluded from scheduling submission", () => {
    const state = makeState();
    const [s1boot] = transition(state, bootEvent("test"));
    const s1 = addProcess(s1boot, "worker-A", { priority: 90 });

    const orchestrator = [...s1.processes.values()].find(p => p.name === "worker-A");
    expect(orchestrator).toBeDefined();

    // Mark worker as inflight
    const stateWithInflight = {
      ...s1,
      inflight: new Set([orchestrator!.pid]),
    };

    const [, effects] = transition(stateWithInflight, timerEvent("housekeep"));

    // submit_llm should NOT contain the inflight worker
    const orchSubmits = effects.filter(
      e => e.type === "submit_llm" && "pid" in e && e.pid === orchestrator!.pid
    );
    expect(orchSubmits).toHaveLength(0);
  });

  test("schedulerRoundRobinIndex is updated in state after round-robin scheduling", () => {
    const state = makeState({ maxConcurrentProcesses: 1 });
    const [s1] = transition(state, bootEvent("test"));

    // Override state to use round-robin strategy with multiple running processes
    const processes = new Map(s1.processes);
    processes.set("w1", makeProcess({ pid: "w1", name: "worker-1", priority: 50, state: "running" }));
    processes.set("w2", makeProcess({ pid: "w2", name: "worker-2", priority: 50, state: "running" }));

    const rrState: KernelState = {
      ...s1,
      processes,
      schedulerStrategy: "round-robin",
      schedulerMaxConcurrent: 1,
      schedulerRoundRobinIndex: 0,
    };

    const [newState] = transition(rrState, timerEvent("housekeep"));

    // Round-robin index should have advanced
    expect(newState.schedulerRoundRobinIndex).toBeGreaterThan(0);
  });

  test("maxConcurrent limit is respected in housekeep scheduling", () => {
    const state = makeState({ maxConcurrentProcesses: 1 });
    const [s1] = transition(state, bootEvent("test"));

    const processes = new Map(s1.processes);
    // Add multiple running workers
    processes.set("w1", makeProcess({ pid: "w1", name: "worker-1", priority: 80, state: "running" }));
    processes.set("w2", makeProcess({ pid: "w2", name: "worker-2", priority: 70, state: "running" }));
    processes.set("w3", makeProcess({ pid: "w3", name: "worker-3", priority: 60, state: "running" }));

    const stateWithWorkers: KernelState = {
      ...s1,
      processes,
      schedulerMaxConcurrent: 2,
    };

    const [, effects] = transition(stateWithWorkers, timerEvent("housekeep"));

    // Should emit at most schedulerMaxConcurrent submit_llm effects
    const submitEffects = effects.filter(e => e.type === "submit_llm");
    expect(submitEffects.length).toBeLessThanOrEqual(2);
  });
});

describe("handleTopologyDeclared", () => {
  test("null topology → zero effects", () => {
    const state = makeState();
    const event: KernelEvent = {
      type: "topology_declared",
      topology: null,
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    expect(effects).toHaveLength(0);
  });

  test("valid topology → spawn effects emitted", () => {
    const state = makeState();
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "par", children: [
        { type: "task", name: "A", objective: "do A" },
        { type: "task", name: "B", objective: "do B" },
      ]},
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    expect(spawns).toHaveLength(2);
  });

  test("invalid topology → error protocol emitted", () => {
    const state = makeState();
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "seq", children: [] },
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    const errors = effects.filter(e => e.type === "emit_protocol" && (e as any).action === "os_topology_error");
    expect(errors).toHaveLength(1);
  });

  test("halt command → kernel halts", () => {
    const state = makeState();
    const event: KernelEvent = {
      type: "topology_declared",
      topology: null,
      memory: [],
      halt: { status: "achieved", summary: "goal completed" },
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    expect(newState.halted).toBe(true);
    expect(effects.some(e => e.type === "halt")).toBe(true);
  });

  test("memory commands → protocol effects emitted", () => {
    const state = makeState();
    const event: KernelEvent = {
      type: "topology_declared",
      topology: null,
      memory: [
        { kind: "learn", heuristic: "test", confidence: 0.8, context: "test" },
      ],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    const memEffects = effects.filter(e => e.type === "emit_protocol" && (e as any).action === "os_metacog_memory");
    expect(memEffects).toHaveLength(1);
  });

  test("topology with seq: only entry node spawned", () => {
    const state = makeState();
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "seq", children: [
        { type: "task", name: "A", objective: "first" },
        { type: "task", name: "B", objective: "second" },
      ]},
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].name).toBe("A");
  });

  test("topology with gate (unmet): gated nodes not spawned", () => {
    const state = makeState();
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "gate",
        condition: { type: "blackboard_key_exists", key: "data" },
        child: { type: "task", name: "worker", objective: "process data" },
      },
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    expect(spawns).toHaveLength(0);
  });

  test("topology with gate (met): gated nodes spawned", () => {
    const stateWithBB = { ...makeState(), blackboard: new Map([["data", { value: "test", writtenBy: "system", version: 1 }]]) };
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "gate",
        condition: { type: "blackboard_key_exists", key: "data" },
        child: { type: "task", name: "worker", objective: "process data" },
      },
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(stateWithBB, event);
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].name).toBe("worker");
  });

  test("existing process matched by name: no spawn, no kill", () => {
    const state = addProcess(makeState(), "A", { objective: "do A" });
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "task", name: "A", objective: "do A" },
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    const kills = effects.filter(e => e.type === "kill_process");
    expect(spawns).toHaveLength(0);
    expect(kills).toHaveLength(0);
  });

  test("process not in topology: killed", () => {
    const state = addProcess(
      addProcess(makeState(), "A"),
      "B",
    );
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "task", name: "A", objective: "do A" },
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    const kills = effects.filter(e => e.type === "kill_process");
    expect(kills).toHaveLength(1);
    expect(kills[0].name).toBe("B");
  });

  test("inflight process not in topology: drained (not killed)", () => {
    const stateWithProcs = addProcess(
      addProcess(makeState(), "A"),
      "B",
    );
    // Mark A as inflight (by its pid)
    const stateWithInflight = { ...stateWithProcs, inflight: new Set(["os-proc-test-A"]) };
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "task", name: "B", objective: "do B" },
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(stateWithInflight, event);
    const drains = effects.filter(e => e.type === "drain_process");
    const kills = effects.filter(e => e.type === "kill_process");
    expect(drains).toHaveLength(1);
    expect(drains[0].name).toBe("A");
    expect(kills).toHaveLength(0);
  });

  test("optimizer warnings emitted as protocol effects", () => {
    const state = makeState();
    // Create a wide parallel topology (>8 children) to trigger width warning
    const children = Array.from({ length: 10 }, (_, i) => ({
      type: "task" as const, name: `T${i}`, objective: `task ${i}`,
    }));
    const event: KernelEvent = {
      type: "topology_declared",
      topology: { type: "par", children },
      memory: [],
      halt: null,
      timestamp: Date.now(),
      seq: 0,
    };
    const [newState, effects] = transition(state, event);
    const warnings = effects.filter(e => e.type === "emit_protocol" && (e as any).action === "os_topology_warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// metacog_response_received
// ---------------------------------------------------------------------------

describe("transition — metacog_response_received", () => {
  function metacogResponseEvent(response: string, seq = 0): KernelEvent {
    return {
      type: "metacog_response_received",
      response,
      timestamp: Date.now(),
      seq,
    };
  }

  test("null topology produces no spawn/kill effects and clears inflight", () => {
    const state = { ...makeState(), metacogInflight: true };
    const response = JSON.stringify({
      assessment: "all good",
      topology: null,
      memory: [],
      halt: null,
    });
    const [newState, effects] = transition(state, metacogResponseEvent(response));

    expect(newState.metacogInflight).toBe(false);
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    const kills = effects.filter(e => e.type === "kill_process");
    expect(spawns).toHaveLength(0);
    expect(kills).toHaveLength(0);
  });

  test("topology with par tasks spawns processes via reconciliation", () => {
    const state = { ...makeState(), metacogInflight: true };
    const response = JSON.stringify({
      assessment: "need workers",
      topology: {
        type: "par",
        children: [
          { type: "task", name: "A", objective: "do A" },
          { type: "task", name: "B", objective: "do B" },
        ],
      },
      memory: [],
      halt: null,
    });
    const [newState, effects] = transition(state, metacogResponseEvent(response));

    expect(newState.metacogInflight).toBe(false);
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    expect(spawns).toHaveLength(2);
  });

  test("halt command sets halted state", () => {
    const state = { ...makeState(), metacogInflight: true };
    const response = JSON.stringify({
      assessment: "goal achieved",
      topology: null,
      memory: [],
      halt: { status: "achieved", summary: "goal completed" },
    });
    const [newState, effects] = transition(state, metacogResponseEvent(response));

    expect(newState.halted).toBe(true);
    expect(newState.haltReason).toContain("achieved");
    expect(newState.metacogInflight).toBe(false);
    const haltEffects = effects.filter(e => e.type === "halt");
    expect(haltEffects).toHaveLength(1);
  });

  test("invalid JSON response clears inflight and produces no effects", () => {
    const state = { ...makeState(), metacogInflight: true };
    const [newState, effects] = transition(state, metacogResponseEvent("not json at all"));

    expect(newState.metacogInflight).toBe(false);
    // Should produce an error protocol effect
    const errorEffects = effects.filter(
      e => e.type === "emit_protocol" && (e as any).action === "os_metacog_error",
    );
    expect(errorEffects).toHaveLength(1);
    // No spawn/kill effects
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    expect(spawns).toHaveLength(0);
  });

  test("clears pending triggers after processing when living processes exist", () => {
    const base = makeState();
    const processes = new Map(base.processes);
    processes.set("alive-1", {
      ...makeProcess("alive-1", "worker"),
      state: "running",
    } as any);
    const state = {
      ...base,
      processes,
      metacogInflight: true,
      pendingTriggers: ["boot", "process_completed"] as any[],
    };
    const response = JSON.stringify({
      assessment: "processed",
      topology: null,
      memory: [],
      halt: null,
    });
    const [newState] = transition(state, metacogResponseEvent(response));

    expect(newState.pendingTriggers).toHaveLength(0);
  });

  test("preserves pending triggers when all processes are dead", () => {
    const state = {
      ...makeState(),
      metacogInflight: true,
      pendingTriggers: ["process_completed"] as any[],
    };
    const response = JSON.stringify({
      assessment: "processed",
      topology: null,
      memory: [],
      halt: null,
    });
    const [newState] = transition(state, metacogResponseEvent(response));

    // Triggers preserved so metacog gets another evaluation pass
    expect(newState.pendingTriggers).toHaveLength(1);
    expect(newState.pendingTriggers[0]).toBe("process_completed");
  });

  test("records metacog history entry with assessment and trigger", () => {
    const state = {
      ...makeState(),
      metacogInflight: true,
      pendingTriggers: ["boot"] as any[],
      tickCount: 5,
    };
    const response = JSON.stringify({
      assessment: "system healthy",
      topology: null,
      memory: [],
      halt: null,
    });
    const [newState] = transition(state, metacogResponseEvent(response));

    expect(newState.metacogHistory).toHaveLength(1);
    expect(newState.metacogHistory[0].tick).toBe(5);
    expect(newState.metacogHistory[0].assessment).toBe("system healthy");
    expect(newState.metacogHistory[0].trigger).toBe("boot");
  });

  test("increments metacogEvalCount", () => {
    const state = {
      ...makeState(),
      metacogInflight: true,
      metacogEvalCount: 3,
    };
    const response = JSON.stringify({
      assessment: "check",
      topology: null,
      memory: [],
      halt: null,
    });
    const [newState] = transition(state, metacogResponseEvent(response));

    expect(newState.metacogEvalCount).toBe(4);
    expect(newState.lastMetacogTick).toBe(state.tickCount);
  });

  test("legacy commands format is handled gracefully (no crash)", () => {
    const state = { ...makeState(), metacogInflight: true };
    const response = JSON.stringify({
      assessment: "legacy",
      commands: [{ kind: "noop", reason: "test" }],
    });
    const [newState, effects] = transition(state, metacogResponseEvent(response));

    expect(newState.metacogInflight).toBe(false);
    // Should produce a protocol event acknowledging legacy format
    const protocolEffects = effects.filter(e => e.type === "emit_protocol");
    expect(protocolEffects.length).toBeGreaterThanOrEqual(1);
  });

  test("memory commands emit persist_memory effects", () => {
    const state = { ...makeState(), metacogInflight: true };
    const response = JSON.stringify({
      assessment: "learning",
      topology: null,
      memory: [
        { kind: "learn", heuristic: "test heuristic", confidence: 0.9, context: "test context" },
        { kind: "record_strategy", strategy: { id: "s1", name: "test" } },
      ],
      halt: null,
    });
    const [newState, effects] = transition(state, metacogResponseEvent(response));

    expect(newState.metacogInflight).toBe(false);
    const memoryEffects = effects.filter(e => e.type === "persist_memory");
    expect(memoryEffects).toHaveLength(2);
  });
});

describe("transition — awareness_response_received", () => {
  function awarenessEvent(
    overrides?: Partial<{
      notes: string[];
      adjustments: any[];
      flaggedHeuristics: { id: string; reason: string }[];
    }>,
    seq = 0,
  ): KernelEvent {
    return {
      type: "awareness_response_received",
      notes: overrides?.notes ?? [],
      adjustments: overrides?.adjustments ?? [],
      flaggedHeuristics: overrides?.flaggedHeuristics ?? [],
      timestamp: Date.now(),
      seq,
    };
  }

  test("stores awareness notes in state", () => {
    const state = makeState();
    const [newState] = transition(
      state,
      awarenessEvent({ notes: ["consider cost efficiency", "watch for oscillation"] }),
    );

    expect(newState.awarenessNotes).toEqual(["consider cost efficiency", "watch for oscillation"]);
  });

  // killThresholdAdjustment, metacogFocus, and blindSpots removed from KernelState.
  // Awareness adjustments are no longer processed in the transition function.

  test("emits protocol event for observability", () => {
    const state = makeState();
    const [, effects] = transition(
      state,
      awarenessEvent({
        notes: ["note-1", "note-2"],
        adjustments: [
          { kind: "adjust_kill_threshold", delta: 0.1, reason: "test" },
          { kind: "suggest_metacog_focus", area: "cost", reason: "test" },
        ],
      }),
    );

    const protocolEffects = effects.filter(
      e => e.type === "emit_protocol" && (e as any).action === "os_awareness_eval",
    );
    expect(protocolEffects).toHaveLength(1);
    const msg = (protocolEffects[0] as any).message as string;
    expect(msg).toContain("2 notes");
    expect(msg).toContain("2 adjustments");
  });

  test("replaces previous notes (not appends)", () => {
    const state = { ...makeState(), awarenessNotes: ["old-note-1", "old-note-2"] };
    const [newState] = transition(
      state,
      awarenessEvent({ notes: ["new-note"] }),
    );

    expect(newState.awarenessNotes).toEqual(["new-note"]);
    expect(newState.awarenessNotes).not.toContain("old-note-1");
  });

  // oscillationWarnings, killThresholdAdjustment, metacogFocus, blindSpots removed.
  // Multiple adjustment types and noop tests no longer applicable.
});

// ---------------------------------------------------------------------------
// llm_turn_completed
// ---------------------------------------------------------------------------

function llmTurnCompletedEvent(
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
    type: "llm_turn_completed",
    pid,
    success: opts.success ?? true,
    tokensUsed: opts.tokensUsed ?? 100,
    commands,
    response: opts.response ?? "",
    timestamp: Date.now(),
    seq: 0,
  } as KernelEvent;
}

describe("transition — llm_turn_completed", () => {
  test("processes commands like process_completed (bb_write)", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const [newState] = transition(state, llmTurnCompletedEvent(orchestratorPid, {
      commands: [
        { kind: "bb_write", key: "result:test", value: { data: "hello" } },
        { kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } },
      ],
    }));

    const entry = newState.blackboard.get("result:test");
    expect(entry).toBeDefined();
    expect(entry!.value).toEqual({ data: "hello" });
    expect(entry!.writtenBy).toBe(orchestratorPid);
  });

  test("drain check — kills process if pid in drainingPids", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();

    // Add a worker that is being drained
    const workerState = addProcess(state, "drain-worker", { parentPid: orchestratorPid });
    const workerPid = `os-proc-test-drain-worker`;

    // Mark pid as draining
    const drainingPids = new Set(workerState.drainingPids);
    drainingPids.add(workerPid);
    const stateWithDrain = { ...workerState, drainingPids };

    const [newState] = transition(stateWithDrain, llmTurnCompletedEvent(workerPid, {
      commands: [{ kind: "idle" }],
    }));

    const proc = newState.processes.get(workerPid)!;
    expect(proc.state).toBe("dead");
    expect(proc.exitReason).toBe("drained");
    expect(newState.drainingPids.has(workerPid)).toBe(false);
  });

  test("increments tickCount", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();
    const initialTickCount = state.tickCount;

    const [newState] = transition(state, llmTurnCompletedEvent(orchestratorPid, {
      commands: [{ kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } }],
    }));

    expect(newState.tickCount).toBe(initialTickCount + 1);
  });

  test("removes pid from inflight", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();

    // Mark pid as inflight
    const inflight = new Set(state.inflight);
    inflight.add(orchestratorPid);
    const stateWithInflight = { ...state, inflight };

    const [newState] = transition(stateWithInflight, llmTurnCompletedEvent(orchestratorPid, {
      commands: [{ kind: "spawn_child", descriptor: { type: "lifecycle", name: "w1", objective: "work" } }],
    }));

    expect(newState.inflight.has(orchestratorPid)).toBe(false);
  });

  test("handles failure (success=false)", () => {
    const { state, orchestratorPid } = bootAndGetOrchestrator();

    const [newState, effects] = transition(state, llmTurnCompletedEvent(orchestratorPid, {
      success: false,
      response: "LLM error",
    }));

    const proc = newState.processes.get(orchestratorPid)!;
    expect(proc.state).toBe("dead");
    expect(proc.exitReason).toContain("execution_failed");
    expect(effects.some(e => e.type === "emit_protocol" && (e as any).action === "os_process_kill")).toBe(true);
    expect(newState.pendingTriggers).toContain("process_failed");
  });

  test("idle command keeps process alive", () => {
    const { state } = bootAndGetOrchestrator();
    // Add a worker process manually
    const workerState = addProcess(state, "w1", { priority: 50 });
    const worker = [...workerState.processes.values()].find(p => p.name === "w1")!;
    // Worker goes idle
    const [s2] = transition(workerState, llmTurnCompletedEvent(worker.pid, {
      commands: [{ kind: "idle", wakeOnSignals: ["tick:1"] }],
    }));

    const updatedWorker = s2.processes.get(worker.pid)!;
    expect(updatedWorker.state).toBe("idle");
    expect(updatedWorker.wakeOnSignals).toEqual(["tick:1"]);
  });
});
