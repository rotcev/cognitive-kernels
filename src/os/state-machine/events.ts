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

import type { TopologyExpr, MetacogMemoryCommand } from "../topology/types.js";

/** Base fields present on every event. */
type BaseEvent = {
  timestamp: number;
  seq: number;
};

/** Kernel booted with a goal. */
export type BootEvent = BaseEvent & {
  type: "boot";
  goal: string;
  /** Optional context injected into the metacog system prompt by the caller. */
  metacogContext?: string;
  /** Working directory for spawned processes. */
  workingDir?: string;
  /** Whether memory-consolidator daemon should be spawned. */
  hasNewEpisodicData?: boolean;
  /** Objective for the memory-consolidator (provided when hasNewEpisodicData is true). */
  consolidatorObjective?: string;
  /** Whether awareness-daemon should be spawned. */
  awarenessEnabled?: boolean;
  /** Model for awareness-daemon. */
  awarenessModel?: string;
};

/** An LLM process completed a turn. */
export type ProcessCompletedEvent = BaseEvent & {
  type: "process_completed";
  pid: string;
  name: string;
  success: boolean;
  commandCount: number;
  tokensUsed: number;
  /** Full command array for transition function processing. */
  commands: import("../types.js").OsProcessCommand[];
  /** Raw LLM response text (needed for failure diagnostics). */
  response: string;
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
  /** Process table PID for the ephemeral (for killing the process entry). */
  tablePid?: string;
  /** Parent process PID that spawned this ephemeral. */
  parentPid?: string;
  /** LLM response text (for blackboard write). */
  response?: string;
  /** Duration in milliseconds. */
  durationMs?: number;
  /** Model used. */
  model?: string;
  /** Error message (on failure). */
  error?: string;
};

/** A wall-clock timer fired. */
export type TimerFiredEvent = BaseEvent & {
  type: "timer_fired";
  timer: "housekeep" | "metacog" | "watchdog" | "snapshot";
  /** Number of pending ephemerals (provided by kernel for housekeep decisions). */
  pendingEphemeralCount?: number;
  /** Current blackboard key count (for deadlock detection). */
  bbKeyCount?: number;
  /** Wall-clock ms when orchestrator was last force-woken. */
  lastForceWakeTime?: number;
  /** BB key count at last force-wake (for change detection). */
  bbKeysAtLastForceWake?: number;
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
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

/** External command received (halt, pause, resume). */
export type ExternalCommandEvent = BaseEvent & {
  type: "external_command";
  command: "halt" | "pause" | "resume";
  /** Custom halt reason (when command is "halt"). */
  reason?: string;
};

/** shouldHalt() was evaluated. */
export type HaltCheckEvent = BaseEvent & {
  type: "halt_check";
  result: boolean;
  reason: string | null;
};

/** Metacog declared a new desired topology. */
export type TopologyDeclaredEvent = BaseEvent & {
  type: "topology_declared";
  topology: TopologyExpr | null;
  memory: MetacogMemoryCommand[];
  halt: { status: "achieved" | "unachievable" | "stalled"; summary: string } | null;
};

/** Raw metacog LLM response received (before parsing into topology/commands). */
export type MetacogResponseReceivedEvent = BaseEvent & {
  type: "metacog_response_received";
  /** Raw JSON from metacog LLM. */
  response: string;
};

/** Awareness daemon LLM response received with parsed adjustments. */
export type AwarenessResponseReceivedEvent = BaseEvent & {
  type: "awareness_response_received";
  adjustments: any[];
  notes: string[];
  flaggedHeuristics: { id: string; reason: string }[];
};

/** An LLM worker process completed a turn with full payload. */
export type LlmTurnCompletedEvent = BaseEvent & {
  type: "llm_turn_completed";
  pid: string;
  success: boolean;
  response: string;
  tokensUsed: number;
  commands: any[];
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** A sub-kernel completed its run. */
export type SubkernelCompletedEvent = BaseEvent & {
  type: "subkernel_completed";
  pid: string;
  success: boolean;
  response: string;
  tokensUsed: number;
};

/** Shell process produced output and exited. */
export type ShellOutputReceivedEvent = BaseEvent & {
  type: "shell_output_received";
  pid: string;
  output: string;
  exitCode: number;
};

/** An MCP tool call completed. */
export type McpCallCompletedEvent = BaseEvent & {
  type: "mcp_call_completed";
  pid: string;
  tool: string;
  success: boolean;
  result?: string;
  error?: string;
};

/** IPC queue was flushed, waking blocked processes. */
export type IpcFlushedEvent = BaseEvent & {
  type: "ipc_flushed";
  wokenPids: string[];
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
  | TopologyDeclaredEvent
  | MetacogResponseReceivedEvent
  | AwarenessResponseReceivedEvent
  | LlmTurnCompletedEvent
  | SubkernelCompletedEvent
  | ShellOutputReceivedEvent
  | McpCallCompletedEvent
  | IpcFlushedEvent
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
