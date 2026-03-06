import type { ProcessStreamCallback } from "../types.js";
import type { OsProcess, OsProcessTurnResult, OsHeuristic, TopologyBlueprint, SchedulingStrategy, ExecutorCheckpointState } from "./types.js";

/**
 * Interface for process executor backends.
 * Each backend handles a specific kind of process (LLM, shell, sub-kernel).
 */
export interface ExecutorBackend {
  readonly name: string;

  /** Initialize resources for a process (e.g., spawn a child process or boot a kernel). */
  start(proc: OsProcess): Promise<void>;

  /** Execute one turn for a process, returning commands to be processed by the kernel. */
  executeOne(proc: OsProcess): Promise<OsProcessTurnResult>;

  /** Clean up resources for a process (e.g., kill child process, halt kernel). */
  dispose(pid: string): void;

  /** Number of actively managed processes. */
  readonly activeCount: number;
}

/**
 * Optional interface for backends that accept context injection (blackboard, heuristics, etc.).
 * Only the LLM backend needs this — shell and sub-kernel backends don't use prompt injection.
 */
export interface ExecutorContextInjectable {
  setBlackboardSnapshot(snapshot: Record<string, unknown>): void;
  setHeuristicsSnapshot(heuristics: OsHeuristic[]): void;
  setBlueprintsSnapshot(blueprints: TopologyBlueprint[]): void;
  setProcessTableSnapshot(processes: OsProcess[]): void;
  setStrategiesSnapshot(strategies: SchedulingStrategy[]): void;
}

/** Type guard to check if a backend supports context injection. */
export function isContextInjectable(backend: ExecutorBackend): backend is ExecutorBackend & ExecutorContextInjectable {
  return "setBlackboardSnapshot" in backend && typeof (backend as unknown as ExecutorContextInjectable).setBlackboardSnapshot === "function";
}

/**
 * Optional interface for backends that support streaming LLM events.
 * Only the LLM backend implements this — shell and sub-kernel backends don't stream.
 */
export interface ExecutorStreamable {
  setStreamCallback(callback: ProcessStreamCallback | null): void;
}

/** Type guard to check if a backend supports streaming. */
export function isStreamable(backend: ExecutorBackend): backend is ExecutorBackend & ExecutorStreamable {
  return "setStreamCallback" in backend && typeof (backend as unknown as ExecutorStreamable).setStreamCallback === "function";
}

/**
 * Optional interface for backends that support checkpoint-restore (GAP-7).
 * Backends that can serialize their per-process state implement this.
 * Shell backends cannot checkpoint (external OS processes are not serializable).
 */
export interface ExecutorCheckpointable {
  canCheckpoint(pid: string): boolean;
  captureCheckpointState(pid: string): ExecutorCheckpointState | null;
  restoreFromCheckpoint(pid: string, state: ExecutorCheckpointState): void;
}

/** Type guard to check if a backend supports checkpointing. */
export function isCheckpointable(backend: ExecutorBackend): backend is ExecutorBackend & ExecutorCheckpointable {
  return "canCheckpoint" in backend && typeof (backend as unknown as ExecutorCheckpointable).canCheckpoint === "function";
}
