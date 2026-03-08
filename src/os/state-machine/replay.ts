/**
 * Deterministic replay harness for the kernel state machine.
 *
 * Given an initial state and an event sequence, replay produces the
 * exact same final state and effect list — always. This is the
 * foundation for time-travel debugging and verification.
 *
 * Usage:
 *   const { finalState, effectLog, stateHistory } = replay(initialState, events);
 *
 * Invariant: replay(state, events) === replay(state, events) for all inputs.
 * (Modulo PIDs from randomUUID — Phase 6 will inject deterministic ID generation.)
 */

import type { KernelState } from "./state.js";
import type { KernelEvent } from "./events.js";
import type { KernelEffect } from "./effects.js";
import { transition } from "./transition.js";

export type ReplayStep = {
  /** The event that triggered this transition. */
  event: KernelEvent;
  /** State after this transition. */
  state: KernelState;
  /** Effects produced by this transition. */
  effects: KernelEffect[];
};

export type ReplayResult = {
  /** Final state after all events. */
  finalState: KernelState;
  /** Complete ordered effect log. */
  effectLog: KernelEffect[];
  /** Step-by-step history for time-travel debugging. */
  stateHistory: ReplayStep[];
  /** Total number of events processed. */
  eventCount: number;
};

/**
 * Replay an event sequence through the transition function.
 * Deterministic: same inputs → same outputs, always.
 */
export function replay(initialState: KernelState, events: KernelEvent[]): ReplayResult {
  let state = initialState;
  const effectLog: KernelEffect[] = [];
  const stateHistory: ReplayStep[] = [];

  for (const event of events) {
    const [newState, effects] = transition(state, event);

    stateHistory.push({ event, state: newState, effects });
    effectLog.push(...effects);
    state = newState;
  }

  return {
    finalState: state,
    effectLog,
    stateHistory,
    eventCount: events.length,
  };
}

/**
 * Verify replay determinism: run the same events twice,
 * check that the results match.
 *
 * Returns null if deterministic, or an error message if not.
 */
export function verifyDeterminism(
  initialState: KernelState,
  events: KernelEvent[],
): string | null {
  const r1 = replay(initialState, events);
  const r2 = replay(initialState, events);

  // Check halt status
  if (r1.finalState.halted !== r2.finalState.halted) {
    return `Halt mismatch: ${r1.finalState.halted} vs ${r2.finalState.halted}`;
  }

  // Check halt reason
  if (r1.finalState.haltReason !== r2.finalState.haltReason) {
    return `Halt reason mismatch: ${r1.finalState.haltReason} vs ${r2.finalState.haltReason}`;
  }

  // Check effect count
  if (r1.effectLog.length !== r2.effectLog.length) {
    return `Effect count mismatch: ${r1.effectLog.length} vs ${r2.effectLog.length}`;
  }

  // Check effect types match
  for (let i = 0; i < r1.effectLog.length; i++) {
    if (r1.effectLog[i].type !== r2.effectLog[i].type) {
      return `Effect type mismatch at index ${i}: ${r1.effectLog[i].type} vs ${r2.effectLog[i].type}`;
    }
  }

  // Check process count
  if (r1.finalState.processes.size !== r2.finalState.processes.size) {
    return `Process count mismatch: ${r1.finalState.processes.size} vs ${r2.finalState.processes.size}`;
  }

  return null; // deterministic!
}

/**
 * Check a list of invariant functions against every step of a replay.
 *
 * Returns an array of violations (empty = all invariants hold).
 */
export type InvariantFn = (state: KernelState, event: KernelEvent, effects: KernelEffect[]) => string | null;

export function checkInvariants(
  initialState: KernelState,
  events: KernelEvent[],
  invariants: InvariantFn[],
): { step: number; event: KernelEvent; violation: string }[] {
  const result = replay(initialState, events);
  const violations: { step: number; event: KernelEvent; violation: string }[] = [];

  for (let i = 0; i < result.stateHistory.length; i++) {
    const step = result.stateHistory[i];
    for (const inv of invariants) {
      const violation = inv(step.state, step.event, step.effects);
      if (violation) {
        violations.push({ step: i, event: step.event, violation });
      }
    }
  }

  return violations;
}
