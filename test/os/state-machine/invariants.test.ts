/**
 * Property-based invariant tests for the kernel transition function.
 *
 * These tests use fast-check to generate random event sequences and verify
 * that the transition function preserves critical invariants — the foundation
 * for mathematical provability of the cognitive kernel.
 *
 * Each property is a universal statement:
 *   ∀ state, event: transition(state, event) preserves [invariant]
 */

import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { transition } from "../../../src/os/state-machine/transition.js";
import { initialState, type KernelState } from "../../../src/os/state-machine/state.js";
import type { KernelEvent } from "../../../src/os/state-machine/events.js";
import type { OsProcessCommand } from "../../../src/os/types.js";
import { parseOsConfig } from "../../../src/os/config.js";

// ---------------------------------------------------------------------------
// Arbitrary generators
// ---------------------------------------------------------------------------

/** Generate a valid OsProcess for state construction. */
const arbProcess = (pid: string) => fc.record({
  pid: fc.constant(pid),
  type: fc.constantFrom("lifecycle" as const, "daemon" as const, "event" as const),
  state: fc.constantFrom("running" as const, "idle" as const, "dead" as const),
  name: fc.string({ minLength: 1, maxLength: 20 }),
  parentPid: fc.constant(null as string | null),
  objective: fc.string({ minLength: 1, maxLength: 50 }),
  priority: fc.integer({ min: 1, max: 100 }),
  spawnedAt: fc.constant(new Date().toISOString()),
  lastActiveAt: fc.constant(new Date().toISOString()),
  tickCount: fc.nat({ max: 100 }),
  tokensUsed: fc.nat({ max: 50000 }),
  model: fc.constant("gpt-4"),
  workingDir: fc.constant("/tmp"),
  children: fc.constant([] as string[]),
  onParentDeath: fc.constant("orphan" as const),
  restartPolicy: fc.constantFrom("never" as const, "always" as const, "on-failure" as const),
});

/** Generate a KernelState with 0-5 processes. */
const arbState = fc.integer({ min: 0, max: 5 }).chain(numProcs => {
  const config = parseOsConfig({
    enabled: true,
    kernel: {
      telemetryEnabled: false,
      watchdogIntervalMs: 600000,
      tokenBudget: fc.sample(fc.integer({ min: 100, max: 1000000 }), 1)[0],
      goalCompleteGracePeriodMs: fc.sample(fc.integer({ min: 100, max: 60000 }), 1)[0],
    },
  });

  const procs = Array.from({ length: numProcs }, (_, i) => `p${i}`);
  const procArbs = procs.map(pid => arbProcess(pid));

  return fc.tuple(...procArbs).map(processes => {
    const state = initialState(config, "test-run");
    state.goal = "test goal";
    state.startTime = Date.now() - 1000; // started 1s ago
    for (const proc of processes) {
      state.processes.set(proc.pid, proc);
    }
    return state;
  });
});

/** Generate a simple OsProcessCommand. */
const arbCommand: fc.Arbitrary<OsProcessCommand> = fc.oneof(
  fc.record({ kind: fc.constant("idle" as const) }),
  fc.record({ kind: fc.constant("exit" as const), code: fc.integer({ min: 0, max: 1 }), reason: fc.string({ minLength: 1, maxLength: 20 }) }),
  fc.record({ kind: fc.constant("bb_write" as const), key: fc.string({ minLength: 1, maxLength: 20 }), value: fc.string({ minLength: 1, maxLength: 50 }) }),
  fc.record({ kind: fc.constant("sleep" as const), durationMs: fc.integer({ min: 100, max: 30000 }) }),
  fc.record({
    kind: fc.constant("self_report" as const),
    efficiency: fc.double({ min: 0, max: 1 }),
    blockers: fc.constant([] as string[]),
    resourcePressure: fc.constantFrom("low" as const, "medium" as const, "high" as const),
    suggestedAction: fc.constantFrom("continue" as const, "need_help" as const),
  }),
  fc.record({
    kind: fc.constant("spawn_child" as const),
    descriptor: fc.record({
      type: fc.constantFrom("lifecycle" as const, "event" as const),
      name: fc.string({ minLength: 1, maxLength: 20 }),
      objective: fc.string({ minLength: 1, maxLength: 50 }),
    }),
  }),
);

/** Generate a KernelEvent that the transition function handles. */
const arbEvent: fc.Arbitrary<KernelEvent> = fc.oneof(
  fc.record({
    type: fc.constant("boot" as const),
    goal: fc.string({ minLength: 1, maxLength: 50 }),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  fc.record({
    type: fc.constant("halt_check" as const),
    result: fc.constant(false),
    reason: fc.constant(null as string | null),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  fc.record({
    type: fc.constant("external_command" as const),
    command: fc.constantFrom("halt" as const, "pause" as const, "resume" as const),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  // process_completed with random commands for processes that may or may not exist
  fc.record({
    type: fc.constant("process_completed" as const),
    pid: fc.constantFrom("p0", "p1", "p2", "p3", "p4", "nonexistent"),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    success: fc.boolean(),
    commandCount: fc.nat({ max: 5 }),
    tokensUsed: fc.nat({ max: 5000 }),
    commands: fc.array(arbCommand, { minLength: 0, maxLength: 3 }),
    response: fc.string({ maxLength: 50 }),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  fc.record({
    type: fc.constant("timer_fired" as const),
    timer: fc.constantFrom("housekeep" as const, "metacog" as const, "watchdog" as const, "snapshot" as const),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  fc.record({
    type: fc.constant("metacog_evaluated" as const),
    commandCount: fc.nat({ max: 10 }),
    triggerCount: fc.nat({ max: 5 }),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  fc.record({
    type: fc.constant("awareness_evaluated" as const),
    hasAdjustment: fc.boolean(),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  fc.record({
    type: fc.constant("shell_output" as const),
    pid: fc.constantFrom("p0", "p1", "nonexistent"),
    hasStdout: fc.boolean(),
    hasStderr: fc.boolean(),
    exitCode: fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  fc.record({
    type: fc.constant("process_submitted" as const),
    pid: fc.constantFrom("p0", "p1", "nonexistent"),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    model: fc.constant("gpt-4"),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
);

// ---------------------------------------------------------------------------
// Invariant properties
// ---------------------------------------------------------------------------

describe("Transition invariants (property-based)", () => {
  test("INVARIANT: transition is total — never throws for any valid (state, event) pair", () => {
    fc.assert(
      fc.property(arbState, arbEvent, (state, event) => {
        // Must not throw
        const [newState, effects] = transition(state, event);
        expect(newState).toBeDefined();
        expect(Array.isArray(effects)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  test("INVARIANT: halt is permanent — once halted, state stays halted", () => {
    fc.assert(
      fc.property(arbState, arbEvent, (state, event) => {
        // Pre-condition: state is halted
        state.halted = true;
        state.haltReason = "test_halt";

        const [newState] = transition(state, event);

        // Post-condition: still halted
        if (event.type !== "boot") {
          // boot resets state, so we only check non-boot events
          expect(newState.halted).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("INVARIANT: halt effect implies halted state", () => {
    fc.assert(
      fc.property(arbState, arbEvent, (state, event) => {
        const [newState, effects] = transition(state, event);

        const hasHaltEffect = effects.some(e => e.type === "halt");
        if (hasHaltEffect) {
          expect(newState.halted).toBe(true);
          expect(newState.haltReason).not.toBeNull();
        }
      }),
      { numRuns: 500 },
    );
  });

  test("INVARIANT: effect sequences are monotonically increasing", () => {
    fc.assert(
      fc.property(arbState, arbEvent, (state, event) => {
        const [, effects] = transition(state, event);

        for (let i = 1; i < effects.length; i++) {
          expect(effects[i].seq).toBeGreaterThan(effects[i - 1].seq);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("INVARIANT: transition does not mutate input state", () => {
    fc.assert(
      fc.property(arbState, arbEvent, (state, event) => {
        // Snapshot key fields before transition
        const beforeGoal = state.goal;
        const beforeHalted = state.halted;
        const beforeProcessCount = state.processes.size;
        const beforeHaltReason = state.haltReason;

        transition(state, event);

        // Must be unchanged after transition
        expect(state.goal).toBe(beforeGoal);
        expect(state.halted).toBe(beforeHalted);
        expect(state.processes.size).toBe(beforeProcessCount);
        expect(state.haltReason).toBe(beforeHaltReason);
      }),
      { numRuns: 500 },
    );
  });

  test("INVARIANT: boot always produces processes and sets goal", () => {
    fc.assert(
      fc.property(
        arbState,
        fc.string({ minLength: 1, maxLength: 50 }),
        (state, goal) => {
          const [newState, effects] = transition(state, {
            type: "boot", goal, timestamp: Date.now(), seq: 0,
          });

          // Boot always creates at least 2 processes (orchestrator + metacog)
          expect(newState.processes.size).toBeGreaterThanOrEqual(2);

          // Boot produces emit_protocol effects (no submit_llm — tick loop handles that)
          expect(effects.some(e => e.type === "emit_protocol")).toBe(true);

          // Goal is always set
          expect(newState.goal).toBe(goal);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("INVARIANT: token budget termination — if budget exceeded and no inflight, halt", () => {
    fc.assert(
      fc.property(
        arbState,
        fc.integer({ min: 100, max: 10000 }),
        (state, budget) => {
          // Set up: budget exceeded, no inflight
          state.config = parseOsConfig({
            enabled: true,
            kernel: { tokenBudget: budget, telemetryEnabled: false, watchdogIntervalMs: 600000 },
          });
          state.halted = false;
          state.inflight.clear();
          state.activeEphemeralCount = 0;

          // Ensure total tokens exceed budget
          let totalTokens = 0;
          for (const proc of state.processes.values()) {
            totalTokens += proc.tokensUsed;
          }
          if (totalTokens < budget && state.processes.size > 0) {
            // Force one process to exceed
            const firstProc = state.processes.values().next().value!;
            firstProc.tokensUsed = budget + 1;
          }

          // Only test if we actually exceed budget
          totalTokens = 0;
          for (const proc of state.processes.values()) {
            totalTokens += proc.tokensUsed;
          }
          if (totalTokens >= budget) {
            const [newState] = transition(state, {
              type: "halt_check", result: false, reason: null,
              timestamp: Date.now(), seq: 0,
            });
            expect(newState.halted).toBe(true);
            expect(newState.haltReason).toBe("token_budget_exceeded");
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test("INVARIANT: external halt always terminates", () => {
    fc.assert(
      fc.property(arbState, (state) => {
        state.halted = false; // ensure not already halted

        const [newState, effects] = transition(state, {
          type: "external_command", command: "halt",
          timestamp: Date.now(), seq: 0,
        });

        expect(newState.halted).toBe(true);
        expect(newState.haltReason).toBe("external_halt");
        expect(effects.some(e => e.type === "halt")).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("Transition replay determinism", () => {
  test("same event sequence on same initial state → same final state", () => {
    fc.assert(
      fc.property(
        fc.array(arbEvent, { minLength: 1, maxLength: 10 }),
        (events) => {
          const config = parseOsConfig({
            enabled: true,
            kernel: { tokenBudget: 50000, telemetryEnabled: false, watchdogIntervalMs: 600000 },
          });

          // Run the same event sequence twice
          let state1 = initialState(config, "run-1");
          let state2 = initialState(config, "run-2");

          const effectTypes1: string[][] = [];
          const effectTypes2: string[][] = [];

          for (const event of events) {
            const [s1, e1] = transition(state1, event);
            const [s2, e2] = transition(state2, event);

            effectTypes1.push(e1.map(e => e.type));
            effectTypes2.push(e2.map(e => e.type));

            state1 = s1;
            state2 = s2;
          }

          // Same effect type sequences (PIDs may differ due to randomUUID)
          expect(effectTypes1).toEqual(effectTypes2);

          // Same halt status
          expect(state1.halted).toBe(state2.halted);
          expect(state1.haltReason).toBe(state2.haltReason);

          // Same process count
          expect(state1.processes.size).toBe(state2.processes.size);
        },
      ),
      { numRuns: 200 },
    );
  });
});
