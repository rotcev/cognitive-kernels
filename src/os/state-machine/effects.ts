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

import type { TaskBackend } from "../topology/types.js";

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
  /** Structured detail payload — carries typed data alongside the human-readable message. */
  detail?: Record<string, unknown>;
};

/** Kernel is halting. */
export type HaltEffect = BaseEffect & {
  type: "halt";
  reason: string;
};

/** Activate a process (idle/sleeping → running in scheduler). */
export type ActivateProcessEffect = BaseEffect & {
  type: "activate_process";
  pid: string;
};

/** Set a process to idle state. */
export type IdleProcessEffect = BaseEffect & {
  type: "idle_process";
  pid: string;
  wakeOnSignals?: string[];
};

/** Emit an IPC signal. */
export type SignalEmitEffect = BaseEffect & {
  type: "signal_emit";
  signal: string;
  sender: string;
  payload?: Record<string, unknown>;
};

/** Emit a child:done signal to parent. */
export type ChildDoneSignalEffect = BaseEffect & {
  type: "child_done_signal";
  childPid: string;
  childName: string;
  parentPid: string;
  exitCode?: number;
  exitReason?: string;
};

/** Flush the IPC bus and activate woken processes. */
export type FlushIPCEffect = BaseEffect & {
  type: "flush_ipc";
};

/** Rebuild DAG topology from current process table. */
export type RebuildDAGEffect = BaseEffect & {
  type: "rebuild_dag";
};

/** Trigger a scheduling pass to select and submit runnable processes. */
export type SchedulePassEffect = BaseEffect & {
  type: "schedule_pass";
};

/** Apply matched scheduling strategies to scheduler and executor router. */
export type ApplyStrategiesEffect = BaseEffect & {
  type: "apply_strategies";
  strategyIds: string[];
};

/** Spawn a new process from topology reconciliation. */
export type SpawnTopologyProcessEffect = BaseEffect & {
  type: "spawn_topology_process";
  name: string;
  objective: string;
  model?: string;
  priority?: number;
  backend?: TaskBackend;
};

/** Kill a process removed from topology. */
export type KillProcessEffect = BaseEffect & {
  type: "kill_process";
  pid: string;
  name: string;
};

/** Drain an inflight process (let current turn finish, then kill). */
export type DrainProcessEffect = BaseEffect & {
  type: "drain_process";
  pid: string;
  name: string;
};

/** Execute an LLM process turn. */
export type RunLlmEffect = BaseEffect & {
  type: "run_llm";
  pid: string;
};

/** Execute a metacog evaluation pass. */
export type RunMetacogEffect = BaseEffect & {
  type: "run_metacog";
  context: any; // MetacogContext — transition builds this from state
};

/** Execute an awareness daemon pass. */
export type RunAwarenessEffect = BaseEffect & {
  type: "run_awareness";
  context: any; // AwarenessContext
};

/** Execute an ephemeral (fire-and-forget scout) process. */
export type RunEphemeralEffect = BaseEffect & {
  type: "run_ephemeral";
  pid: string;
  parentPid: string;
  objective: string;
  model?: string;
};

/** Execute a shell (system) command. */
export type RunShellEffect = BaseEffect & {
  type: "run_shell";
  pid: string;
  command: string;
  args: string[];
  workingDir?: string;
};

/** Execute a sub-kernel process. */
export type RunSubkernelEffect = BaseEffect & {
  type: "run_subkernel";
  pid: string;
  goal: string;
  maxTicks?: number;
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
  | ActivateProcessEffect
  | IdleProcessEffect
  | SignalEmitEffect
  | ChildDoneSignalEffect
  | FlushIPCEffect
  | RebuildDAGEffect
  | SchedulePassEffect
  | ApplyStrategiesEffect
  | SpawnTopologyProcessEffect
  | KillProcessEffect
  | DrainProcessEffect
  | RunLlmEffect
  | RunMetacogEffect
  | RunAwarenessEffect
  | RunEphemeralEffect
  | RunShellEffect
  | RunSubkernelEffect
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
