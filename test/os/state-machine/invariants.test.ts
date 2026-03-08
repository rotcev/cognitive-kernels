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

/** Generate a random JSON string for metacog responses. */
const arbMetacogJsonResponse: fc.Arbitrary<string> = fc.oneof(
  // Valid topology format
  fc.record({
    assessment: fc.string({ minLength: 1, maxLength: 50 }),
    topology: fc.constant(null),
    memory: fc.constant([]),
    halt: fc.constant(null),
  }).map(obj => JSON.stringify(obj)),
  // Valid legacy format
  fc.record({
    commands: fc.constant([]),
  }).map(obj => JSON.stringify(obj)),
  // Invalid JSON
  fc.string({ minLength: 1, maxLength: 50 }).filter(s => {
    try { JSON.parse(s); return false; } catch { return true; }
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
  // metacog_response_received with random JSON strings
  fc.record({
    type: fc.constant("metacog_response_received" as const),
    response: arbMetacogJsonResponse,
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  // awareness_response_received with random adjustments/notes
  fc.record({
    type: fc.constant("awareness_response_received" as const),
    adjustments: fc.array(fc.record({
      processName: fc.string({ minLength: 1, maxLength: 20 }),
      field: fc.constantFrom("priority", "objective"),
      value: fc.string({ minLength: 1, maxLength: 20 }),
    }), { minLength: 0, maxLength: 3 }),
    notes: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 3 }),
    flaggedHeuristics: fc.constant([]),
    timestamp: fc.constant(Date.now()),
    seq: fc.nat(),
  }),
  // llm_turn_completed with random pid/commands
  fc.record({
    type: fc.constant("llm_turn_completed" as const),
    pid: fc.constantFrom("p0", "p1", "p2", "p3", "p4", "nonexistent"),
    success: fc.boolean(),
    response: fc.string({ maxLength: 50 }),
    tokensUsed: fc.nat({ max: 5000 }),
    commands: fc.array(fc.constant({ kind: "idle" as const }), { minLength: 0, maxLength: 3 }),
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

          // Boot always creates at least 1 process (metacog-daemon)
          expect(newState.processes.size).toBeGreaterThanOrEqual(1);

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

describe("Transition effect completeness (property-based)", () => {
  test("INVARIANT: effects array fully determines all observable side effects", () => {
    fc.assert(
      fc.property(arbState, arbEvent, (state, event) => {
        const [newState, effects] = transition(state, event);

        // All effect types must be from the known set — no unknown side channels.
        const knownEffectTypes = new Set([
          "submit_llm", "submit_ephemeral", "submit_metacog", "submit_awareness",
          "start_shell", "start_subkernel",
          "schedule_timer", "cancel_timer",
          "persist_snapshot", "persist_memory",
          "emit_protocol", "halt",
          "activate_process", "idle_process",
          "signal_emit", "child_done_signal",
          "flush_ipc", "rebuild_dag", "schedule_pass", "apply_strategies",
          "run_llm", "run_metacog", "run_awareness", "run_ephemeral", "run_shell", "run_subkernel",
          "spawn_topology_process", "kill_process", "drain_process",
        ]);
        for (const e of effects) {
          expect(knownEffectTypes.has(e.type)).toBe(true);
        }

        // If state changed, there must be corresponding effects or state fields changed.
        // Specifically: if a process was added, there must be a submit_llm or activate_process effect.
        const newPids = new Set(newState.processes.keys());
        const oldPids = new Set(state.processes.keys());
        for (const pid of newPids) {
          if (!oldPids.has(pid)) {
            // New process — must have an effect that references it
            const hasEffect = effects.some(
              e => ("pid" in e && e.pid === pid)
            );
            // Boot creates processes without immediate submission (scheduling loop handles it),
            // but daemon restart and dead executive recovery do emit submit_llm.
            // The key invariant: new processes are either submitted or at least referenced in protocol.
            if (event.type !== "boot") {
              expect(hasEffect).toBe(true);
            }
          }
        }

        // If halt effect was emitted, it must be the authoritative halt signal.
        const haltEffects = effects.filter(e => e.type === "halt");
        if (haltEffects.length > 0) {
          expect(newState.halted).toBe(true);
          // At most one halt effect per transition
          expect(haltEffects.length).toBe(1);
        }

        // If triggers were added to pendingTriggers, they should be from the known set.
        const knownTriggers = new Set([
          "boot",
          "process_failed", "dag_deadlock", "resource_exhaustion",
          "ipc_timeout", "priority_conflict", "checkpoint_restore",
          "goal_drift", "novel_situation", "tick_stall", "observation_failed",
        ]);
        for (const trigger of newState.pendingTriggers) {
          expect(knownTriggers.has(trigger)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("INVARIANT: submit_metacog emitted only when cadence or triggers warrant it", () => {
    fc.assert(
      fc.property(arbState, (state) => {
        // Ensure non-halted state for this test
        state.halted = false;
        state.startTime = Date.now() - 10000;
        state.tickCount = 10; // past boot phase

        const [, effects] = transition(state, {
          type: "timer_fired",
          timer: "metacog",
          timestamp: Date.now(),
          seq: 0,
        });

        const hasSubmitMetacog = effects.some(e => e.type === "submit_metacog");

        // If emitted, there must be a reason: triggers or cadence
        if (hasSubmitMetacog) {
          const hasTriggers = state.pendingTriggers.length > 0;
          const cadenceFires = state.tickCount > 0 &&
            state.tickCount % state.config.scheduler.metacogCadence === 0;
          // Goal drift might have been added during the transition itself
          const goalDriftDetected = state.tickCount - state.lastMetacogTick > 5 &&
            [...state.processes.values()].some(p => p.state !== "dead" && p.type !== "daemon");

          expect(hasTriggers || cadenceFires || goalDriftDetected).toBe(true);
        }
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

// ---------------------------------------------------------------------------
// Pure kernel invariants — property-based tests for new event handlers
// ---------------------------------------------------------------------------

describe("Pure kernel invariants", () => {
  test("INVARIANT: metacog_response_received always clears metacogInflight", () => {
    fc.assert(
      fc.property(arbState, arbMetacogJsonResponse, (state, response) => {
        // Pre-condition: metacog is inflight
        state.metacogInflight = true;
        state.halted = false;

        const [newState] = transition(state, {
          type: "metacog_response_received",
          response,
          timestamp: Date.now(),
          seq: 0,
        });

        // Post-condition: metacogInflight is ALWAYS cleared, regardless of response validity
        expect(newState.metacogInflight).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  test("INVARIANT: run_metacog never emitted when metacogInflight is true", () => {
    fc.assert(
      fc.property(arbState, (state) => {
        // Pre-condition: metacog is already inflight
        state.metacogInflight = true;
        state.halted = false;

        const [, effects] = transition(state, {
          type: "timer_fired",
          timer: "metacog",
          timestamp: Date.now(),
          seq: 0,
        });

        // Post-condition: no metacog effect should be emitted
        const hasRunMetacog = effects.some(e => e.type === "run_metacog");
        const hasSubmitMetacog = effects.some(e => e.type === "submit_metacog");
        expect(hasRunMetacog).toBe(false);
        expect(hasSubmitMetacog).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  test("INVARIANT: draining pid is killed on llm_turn_completed", () => {
    fc.assert(
      fc.property(
        arbState,
        fc.string({ minLength: 1, maxLength: 10 }),
        (state, pidSuffix) => {
          const pid = `drain-${pidSuffix}`;
          state.halted = false;

          // Set up: create a running process and add it to drainingPids
          state.processes.set(pid, {
            pid,
            type: "lifecycle",
            state: "running",
            name: "draining-worker",
            parentPid: null,
            objective: "test objective",
            priority: 50,
            spawnedAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            tickCount: 5,
            tokensUsed: 1000,
            model: "gpt-4",
            workingDir: "/tmp",
            children: [],
            onParentDeath: "orphan",
            restartPolicy: "never",
          });
          state.drainingPids.add(pid);

          const [newState] = transition(state, {
            type: "llm_turn_completed",
            pid,
            success: true,
            response: "done",
            tokensUsed: 100,
            commands: [{ kind: "idle" }],
            timestamp: Date.now(),
            seq: 0,
          });

          // Post-conditions: process is dead and removed from drainingPids
          const proc = newState.processes.get(pid);
          expect(proc).toBeDefined();
          expect(proc!.state).toBe("dead");
          expect(newState.drainingPids.has(pid)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
