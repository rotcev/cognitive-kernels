/**
 * KernelEffect — every side effect the kernel can request.
 *
 * Effects are the OUTPUT side of the state machine:
 *   transition(state, event) → (state', effects)
 *
 * In Phase 2, effects are captured as data but still executed immediately
 * by the interpretEffects() adapter. In Phase 4, the runtime loop will
 * interpret them asynchronously.
 */

type BaseEffect = {
  /** Monotonic sequence number for ordering. */
  seq: number;
};

/** Submit an LLM process for execution. */
export type SubmitLlmEffect = BaseEffect & {
  type: "submit_llm";
  pid: string;
  name: string;
  model: string;
};

/** Submit an ephemeral (fire-and-forget scout) for execution. */
export type SubmitEphemeralEffect = BaseEffect & {
  type: "submit_ephemeral";
  pid: string;
  ephemeralId: string;
  name: string;
  model: string;
};

/** Trigger metacog evaluation. */
export type SubmitMetacogEffect = BaseEffect & {
  type: "submit_metacog";
  triggerCount: number;
};

/** Trigger awareness daemon evaluation. */
export type SubmitAwarenessEffect = BaseEffect & {
  type: "submit_awareness";
};

/** Start a shell (system) process. */
export type StartShellEffect = BaseEffect & {
  type: "start_shell";
  pid: string;
  name: string;
  command: string;
  args: string[];
};

/** Start a sub-kernel process. */
export type StartSubkernelEffect = BaseEffect & {
  type: "start_subkernel";
  pid: string;
  name: string;
  goal: string;
};

/** Schedule a wall-clock timer. */
export type ScheduleTimerEffect = BaseEffect & {
  type: "schedule_timer";
  timer: string;
  delayMs: number;
};

/** Cancel a wall-clock timer. */
export type CancelTimerEffect = BaseEffect & {
  type: "cancel_timer";
  timer: string;
};

/** Persist a snapshot to storage. */
export type PersistSnapshotEffect = BaseEffect & {
  type: "persist_snapshot";
  runId: string;
};

/** Persist data to memory store. */
export type PersistMemoryEffect = BaseEffect & {
  type: "persist_memory";
  operation: string;
};

/** Emit a protocol event (for Lens observability). */
export type EmitProtocolEffect = BaseEffect & {
  type: "emit_protocol";
  action: string;
  message: string;
};

/** Kernel is halting. */
export type HaltEffect = BaseEffect & {
  type: "halt";
  reason: string;
};

/** The discriminated union of all kernel effects. */
export type KernelEffect =
  | SubmitLlmEffect
  | SubmitEphemeralEffect
  | SubmitMetacogEffect
  | SubmitAwarenessEffect
  | StartShellEffect
  | StartSubkernelEffect
  | ScheduleTimerEffect
  | CancelTimerEffect
  | PersistSnapshotEffect
  | PersistMemoryEffect
  | EmitProtocolEffect
  | HaltEffect
  ;

/** Distributive Omit for KernelEffect union (preserves discriminant). */
export type KernelEffectInput = KernelEffect extends infer E
  ? E extends KernelEffect
    ? Omit<E, "seq">
    : never
  : never;

/** Helper to create a sequencer function for effect logging. */
export function createEffectSequencer(): () => number {
  let seq = 0;
  return () => seq++;
}
