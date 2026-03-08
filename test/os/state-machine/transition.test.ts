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
      type: "process_completed",
      pid: "p1",
      name: "test",
      success: true,
      tokensUsed: 10,
      commandCount: 0,
      timestamp: Date.now(),
      seq: 0,
    } as KernelEvent);

    expect(newState).toBe(state); // same reference — no mutation
    expect(effects).toHaveLength(0);
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
