import type { ProcessStreamCallback } from "../types.js";
import type { OsProcess, OsProcessTurnResult, OsHeuristic, TopologyBlueprint, SchedulingStrategy, ExecutorCheckpointState } from "./types.js";
import type { ExecutorBackend } from "./executor-backend.js";
import { isContextInjectable, isStreamable, isCheckpointable } from "./executor-backend.js";

/**
 * Composite executor that routes each process to the correct backend based on
 * the process's `backend.kind` field. Sits where OsProcessExecutor used to sit
 * in the kernel, presenting the same public API.
 */
export class ProcessExecutorRouter {
  private readonly backends: Map<string, ExecutorBackend> = new Map();

  constructor(backends: ExecutorBackend[]) {
    for (const b of backends) {
      this.backends.set(b.name, b);
    }
  }

  /** Get a backend by name. */
  getBackend(name: string): ExecutorBackend | undefined {
    return this.backends.get(name);
  }

  /** Total active count across all backends. */
  get threadCount(): number {
    let total = 0;
    for (const b of this.backends.values()) {
      total += b.activeCount;
    }
    return total;
  }

  /**
   * Start a process in the correct backend.
   * Called when a new system or sub-kernel process is spawned.
   */
  async startProcess(proc: OsProcess): Promise<void> {
    const backend = this.resolveBackend(proc);
    await backend.start(proc);
  }

  /**
   * Execute a single process turn through the correct backend.
   */
  async executeOne(proc: OsProcess): Promise<OsProcessTurnResult> {
    const backend = this.resolveBackend(proc);
    return backend.executeOne(proc);
  }

  /**
   * Execute a batch of processes with concurrency limiting.
   * Partitions by backend kind, delegates to each backend.
   */
  async executeBatch(
    processes: OsProcess[],
    maxConcurrent: number,
  ): Promise<OsProcessTurnResult[]> {
    if (processes.length === 0) return [];

    const results: OsProcessTurnResult[] = [];
    const limit = Math.max(1, maxConcurrent);

    // Simple concurrency pool (same pattern as the original OsProcessExecutor)
    let index = 0;
    const next = async (): Promise<void> => {
      while (index < processes.length) {
        const proc = processes[index++]!;
        const backend = this.resolveBackend(proc);
        const result = await backend.executeOne(proc);
        results.push(result);
      }
    };

    const workers = Array.from({ length: Math.min(limit, processes.length) }, () => next());
    await Promise.all(workers);

    return results;
  }

  /**
   * Dispose a process across all backends.
   */
  disposeThread(pid: string): void {
    for (const b of this.backends.values()) {
      b.dispose(pid);
    }
  }

  /** Forward context injection to all context-injectable backends. */
  setBlackboardSnapshot(snapshot: Record<string, unknown>): void {
    for (const b of this.backends.values()) {
      if (isContextInjectable(b)) {
        b.setBlackboardSnapshot(snapshot);
      }
    }
  }

  /** Forward heuristics injection to all context-injectable backends. */
  setHeuristicsSnapshot(heuristics: OsHeuristic[]): void {
    for (const b of this.backends.values()) {
      if (isContextInjectable(b)) {
        b.setHeuristicsSnapshot(heuristics);
      }
    }
  }

  /** Forward scheduling strategies injection to all context-injectable backends. */
  setStrategiesSnapshot(strategies: SchedulingStrategy[]): void {
    for (const b of this.backends.values()) {
      if (isContextInjectable(b)) {
        b.setStrategiesSnapshot(strategies);
      }
    }
  }

  /** Forward blueprints injection to all context-injectable backends. */
  setBlueprintsSnapshot(blueprints: TopologyBlueprint[]): void {
    for (const b of this.backends.values()) {
      if (isContextInjectable(b)) {
        b.setBlueprintsSnapshot(blueprints);
      }
    }
  }

  /** Forward process table injection to all context-injectable backends. */
  setProcessTableSnapshot(processes: OsProcess[]): void {
    for (const b of this.backends.values()) {
      if (isContextInjectable(b)) {
        b.setProcessTableSnapshot(processes);
      }
    }
  }

  /** Forward stream callback to all streamable backends. */
  setStreamCallback(callback: ProcessStreamCallback | null): void {
    for (const b of this.backends.values()) {
      if (isStreamable(b)) {
        b.setStreamCallback(callback);
      }
    }
  }

  // ─── Checkpoint-Restore (GAP-7) ──────────────────────────────────

  /** Check if a process's backend supports checkpointing. */
  canCheckpoint(proc: OsProcess): boolean {
    const backend = this.resolveBackend(proc);
    return isCheckpointable(backend) && backend.canCheckpoint(proc.pid);
  }

  /** Capture executor-specific checkpoint state for a process. */
  captureCheckpointState(proc: OsProcess): ExecutorCheckpointState | null {
    const backend = this.resolveBackend(proc);
    if (!isCheckpointable(backend)) return null;
    return backend.captureCheckpointState(proc.pid);
  }

  /** Restore executor state from a checkpoint. */
  restoreFromCheckpoint(proc: OsProcess, state: ExecutorCheckpointState): void {
    const backend = this.resolveBackend(proc);
    if (isCheckpointable(backend)) {
      backend.restoreFromCheckpoint(proc.pid, state);
    }
  }

  /**
   * Resolve the correct backend for a process based on its backend kind.
   * Defaults to "llm" when no backend is specified.
   */
  private resolveBackend(proc: OsProcess): ExecutorBackend {
    const kind = proc.backend?.kind ?? "llm";
    const backend = this.backends.get(kind);
    if (!backend) {
      throw new Error(`No executor backend registered for kind "${kind}" (process ${proc.pid})`);
    }
    return backend;
  }
}
