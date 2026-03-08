import { describe, expect, test } from "vitest";
import { replay, verifyDeterminism, checkInvariants, type InvariantFn } from "../../../src/os/state-machine/replay.js";
import { initialState } from "../../../src/os/state-machine/state.js";
import type { KernelEvent } from "../../../src/os/state-machine/events.js";
import { parseOsConfig } from "../../../src/os/config.js";

function makeInitialState(tokenBudget = 50000) {
  const config = parseOsConfig({
    enabled: true,
    kernel: { tokenBudget, telemetryEnabled: false, watchdogIntervalMs: 600000 },
  });
  return initialState(config, "replay-test");
}

describe("Replay harness", () => {
  test("replays a boot → halt_check sequence", () => {
    const state = makeInitialState();
    const events: KernelEvent[] = [
      { type: "boot", goal: "test replay", timestamp: 1000, seq: 0 },
      { type: "halt_check", result: false, reason: null, timestamp: 2000, seq: 1 },
      { type: "halt_check", result: false, reason: null, timestamp: 3000, seq: 2 },
    ];

    const result = replay(state, events);

    expect(result.eventCount).toBe(3);
    expect(result.stateHistory).toHaveLength(3);
    expect(result.finalState.goal).toBe("test replay");
    expect(result.finalState.processes.size).toBe(1); // metacog-daemon (no goal-orchestrator)
    expect(result.effectLog.length).toBeGreaterThan(0);
  });

  test("replays boot → external halt → further events are no-ops", () => {
    const state = makeInitialState();
    const events: KernelEvent[] = [
      { type: "boot", goal: "test halt", timestamp: 1000, seq: 0 },
      { type: "external_command", command: "halt", timestamp: 2000, seq: 1 },
      { type: "halt_check", result: false, reason: null, timestamp: 3000, seq: 2 },
      { type: "halt_check", result: false, reason: null, timestamp: 4000, seq: 3 },
    ];

    const result = replay(state, events);

    expect(result.finalState.halted).toBe(true);
    expect(result.finalState.haltReason).toBe("external_halt");

    // After halt, no more effects
    const effectsAfterHalt = result.stateHistory.slice(2).flatMap(s => s.effects);
    expect(effectsAfterHalt).toHaveLength(0);
  });

  test("state history enables time-travel to any point", () => {
    const state = makeInitialState(100);
    const events: KernelEvent[] = [
      { type: "boot", goal: "time travel test", timestamp: 1000, seq: 0 },
      { type: "halt_check", result: false, reason: null, timestamp: 2000, seq: 1 },
    ];

    const result = replay(state, events);

    // Step 0: after boot
    expect(result.stateHistory[0].state.goal).toBe("time travel test");
    expect(result.stateHistory[0].state.processes.size).toBe(1); // metacog-daemon only

    // Step 1: after halt_check
    expect(result.stateHistory[1].state.halted).toBe(false); // under budget
  });
});

describe("Determinism verification", () => {
  test("verifyDeterminism returns null for deterministic sequences", () => {
    const state = makeInitialState();
    const events: KernelEvent[] = [
      { type: "boot", goal: "determinism test", timestamp: 1000, seq: 0 },
      { type: "halt_check", result: false, reason: null, timestamp: 2000, seq: 1 },
      { type: "external_command", command: "halt", timestamp: 3000, seq: 2 },
    ];

    const error = verifyDeterminism(state, events);
    expect(error).toBeNull();
  });

  test("verifyDeterminism works with empty event sequence", () => {
    const state = makeInitialState();
    const error = verifyDeterminism(state, []);
    expect(error).toBeNull();
  });
});

describe("Invariant checking", () => {
  const haltPermanence: InvariantFn = (state, _event, _effects) => {
    // This invariant checks at each step — the state after transition
    // should be halted if a halt effect was produced
    const hasHaltEffect = _effects.some(e => e.type === "halt");
    if (hasHaltEffect && !state.halted) {
      return "halt effect produced but state is not halted";
    }
    return null;
  };

  const effectMonotonicity: InvariantFn = (_state, _event, effects) => {
    for (let i = 1; i < effects.length; i++) {
      if (effects[i].seq <= effects[i - 1].seq) {
        return `effect seq not monotonic at index ${i}: ${effects[i].seq} <= ${effects[i - 1].seq}`;
      }
    }
    return null;
  };

  const goalNeverEmpty: InvariantFn = (state, event) => {
    // After boot, goal should always be set
    if (event.type === "boot" && state.goal === "") {
      return "goal is empty after boot";
    }
    return null;
  };

  test("all invariants hold for a standard event sequence", () => {
    const state = makeInitialState();
    const events: KernelEvent[] = [
      { type: "boot", goal: "invariant check", timestamp: 1000, seq: 0 },
      { type: "halt_check", result: false, reason: null, timestamp: 2000, seq: 1 },
      { type: "external_command", command: "halt", timestamp: 3000, seq: 2 },
      { type: "halt_check", result: false, reason: null, timestamp: 4000, seq: 3 },
    ];

    const violations = checkInvariants(state, events, [
      haltPermanence,
      effectMonotonicity,
      goalNeverEmpty,
    ]);

    expect(violations).toHaveLength(0);
  });

  test("checkInvariants catches violations when they occur", () => {
    // Create a custom invariant that always fails
    const alwaysFails: InvariantFn = () => "test violation";

    const state = makeInitialState();
    const events: KernelEvent[] = [
      { type: "boot", goal: "test", timestamp: 1000, seq: 0 },
    ];

    const violations = checkInvariants(state, events, [alwaysFails]);

    expect(violations).toHaveLength(1);
    expect(violations[0].violation).toBe("test violation");
    expect(violations[0].step).toBe(0);
  });
});
