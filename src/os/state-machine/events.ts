/**
 * KernelEvent — the complete set of events that drive kernel state transitions.
 *
 * Every event has:
 * - `type`: discriminant tag
 * - `timestamp`: epoch ms when the event occurred
 * - `seq`: monotonically increasing sequence number (total ordering)
 *
 * Events are the INPUT side of the state machine:
 *   transition(state, event) → (state', effects)
 *
 * Design principle: events carry enough context to be self-describing
 * in a log, but NOT the full payload (e.g., we log `commandCount` not
 * the entire command array). Full payloads live in the state.
 */

/** Base fields present on every event. */
type BaseEvent = {
  timestamp: number;
  seq: number;
};

/** Kernel booted with a goal. */
export type BootEvent = BaseEvent & {
  type: "boot";
  goal: string;
};

/** An LLM process completed a turn. */
export type ProcessCompletedEvent = BaseEvent & {
  type: "process_completed";
  pid: string;
  name: string;
  success: boolean;
  commandCount: number;
  tokensUsed: number;
};

/** A process was submitted to the LLM executor. */
export type ProcessSubmittedEvent = BaseEvent & {
  type: "process_submitted";
  pid: string;
  name: string;
  model: string;
};

/** An ephemeral (fire-and-forget scout) completed. */
export type EphemeralCompletedEvent = BaseEvent & {
  type: "ephemeral_completed";
  id: string;
  name: string;
  success: boolean;
};

/** A wall-clock timer fired. */
export type TimerFiredEvent = BaseEvent & {
  type: "timer_fired";
  timer: "housekeep" | "metacog" | "watchdog" | "snapshot";
};

/** Metacog evaluation completed. */
export type MetacogEvaluatedEvent = BaseEvent & {
  type: "metacog_evaluated";
  commandCount: number;
  triggerCount: number;
};

/** Awareness daemon evaluation completed. */
export type AwarenessEvaluatedEvent = BaseEvent & {
  type: "awareness_evaluated";
  hasAdjustment: boolean;
};

/** Shell process produced output or exited. */
export type ShellOutputEvent = BaseEvent & {
  type: "shell_output";
  pid: string;
  hasStdout: boolean;
  hasStderr: boolean;
  exitCode?: number;
};

/** External command received (halt, pause, resume). */
export type ExternalCommandEvent = BaseEvent & {
  type: "external_command";
  command: "halt" | "pause" | "resume";
};

/** shouldHalt() was evaluated. */
export type HaltCheckEvent = BaseEvent & {
  type: "halt_check";
  result: boolean;
  reason: string | null;
};

/** The discriminated union of all kernel events. */
export type KernelEvent =
  | BootEvent
  | ProcessCompletedEvent
  | ProcessSubmittedEvent
  | EphemeralCompletedEvent
  | TimerFiredEvent
  | MetacogEvaluatedEvent
  | AwarenessEvaluatedEvent
  | ShellOutputEvent
  | ExternalCommandEvent
  | HaltCheckEvent
  ;

/**
 * Distributive Omit that preserves the discriminated union.
 * `Omit<KernelEvent, K>` collapses the union into a single type,
 * losing the discriminant. This version distributes over the union
 * so each variant keeps its own fields.
 */
export type KernelEventInput = KernelEvent extends infer E
  ? E extends KernelEvent
    ? Omit<E, "timestamp" | "seq">
    : never
  : never;

/** Helper to create a sequencer function for event logging. */
export function createEventSequencer(): () => number {
  let seq = 0;
  return () => seq++;
}
