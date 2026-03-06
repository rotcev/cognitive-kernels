/**
 * Counterfactual Simulator — GAP 2 (R5)
 *
 * Implements a lightweight, heuristic counterfactual replay mechanism.
 * When the kernel executes significant metacog commands (kill, spawn, reprioritize),
 * it captures a snapshot of the process table into a ring buffer.
 *
 * The simulateCounterfactual() function then asks:
 *   "What would have happened if we had NOT taken action A?"
 *
 * This is a heuristic projection (not a full re-execution). It uses:
 *   - Rolling average token rates to estimate future consumption
 *   - Wall-time elapsed to estimate time delta
 *
 * Results are logged to the causal attribution store and surfaced in the
 * metacog context for the next evaluation tick.
 */

import type { OsProcess } from "./types.js";

// ─── Kernel Action ────────────────────────────────────────────────

export type KernelActionKind = "kill" | "spawn" | "reprioritize";

export interface KernelAction {
  kind: KernelActionKind;
  pid: string;
  /** Snapshot of the targeted process's resource usage at action time. */
  processMeta: {
    name: string;
    tokensUsed: number;
    tickCount: number;
    /** Estimated tokens per tick at action time. */
    tokensPerTick: number;
    priority: number;
  };
  timestamp: number;
  tick: number;
}

// ─── Process Snapshot Entry ───────────────────────────────────────

export interface ProcessSnapshotEntry {
  pid: string;
  name: string;
  state: string;
  type: string;
  tokensUsed: number;
  tickCount: number;
  /** Estimated tokens per tick (tokensUsed / max(tickCount, 1)). */
  tokensPerTick: number;
  priority: number;
}

// ─── Topology Event Snapshot ──────────────────────────────────────

/** A ring-buffer entry: state of the process table at the moment of a kernel action. */
export interface TopologyEventSnapshot {
  /** Monotonically increasing index within the ring buffer. */
  index: number;
  tick: number;
  timestamp: number;
  /** The action that triggered this snapshot. */
  triggeringAction: KernelAction;
  /** Snapshot of all non-dead processes at this moment. */
  processes: ProcessSnapshotEntry[];
}

// ─── Counterfactual Result ────────────────────────────────────────

export interface CounterfactualResult {
  snapshotTick: number;
  omittedAction: KernelAction;
  /** PIDs of processes that would still be alive if the action was NOT taken. */
  projectedExtraAliveProcesses: string[];
  /**
   * Estimated additional tokens that would have been consumed.
   * Positive = omitting the action would have cost more tokens.
   * Negative = omitting the action would have saved tokens (rare for kills).
   */
  estimatedTokenDelta: number;
  /**
   * Estimated additional wall-time in ms.
   * Based on the killed process's average token rate and the tick interval.
   */
  estimatedTimeDeltaMs: number;
  /** Human-readable summary for causal attribution logging. */
  reasoning: string;
}

// ─── CounterfactualSimulator ──────────────────────────────────────

export class CounterfactualSimulator {
  private readonly ringBuffer: TopologyEventSnapshot[] = [];
  private readonly maxSnapshots: number;
  /** Approximate ms per tick (used for time delta estimation). */
  private msPerTick: number;
  private nextIndex = 0;

  constructor(maxSnapshots = 20, msPerTick = 200) {
    this.maxSnapshots = maxSnapshots;
    this.msPerTick = msPerTick;
  }

  /** Update the tick interval estimate (called from kernel config). */
  setMsPerTick(ms: number): void {
    this.msPerTick = ms;
  }

  /**
   * Capture a snapshot of the process table at the moment of a kernel action.
   * Maintains a ring buffer of the last `maxSnapshots` entries.
   */
  captureSnapshot(tick: number, action: KernelAction, processes: OsProcess[]): void {
    const snapshotEntry: TopologyEventSnapshot = {
      index: this.nextIndex++,
      tick,
      timestamp: Date.now(),
      triggeringAction: action,
      processes: processes
        .filter((p) => p.state !== "dead")
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          state: p.state,
          type: p.type,
          tokensUsed: p.tokensUsed,
          tickCount: p.tickCount,
          tokensPerTick: p.tickCount > 0 ? p.tokensUsed / p.tickCount : 0,
          priority: p.priority,
        })),
    };

    if (this.ringBuffer.length >= this.maxSnapshots) {
      this.ringBuffer.shift(); // evict oldest
    }
    this.ringBuffer.push(snapshotEntry);
  }

  /** Return all snapshots in the ring buffer (oldest first). */
  getSnapshots(): TopologyEventSnapshot[] {
    return [...this.ringBuffer];
  }

  /**
   * Return the most recent snapshot whose triggering action targeted the given PID.
   * Returns null if no such snapshot exists.
   */
  mostRecentSnapshotForPid(pid: string): { snapshot: TopologyEventSnapshot; index: number } | null {
    for (let i = this.ringBuffer.length - 1; i >= 0; i--) {
      const snapshot = this.ringBuffer[i]!;
      if (snapshot.triggeringAction.pid === pid) {
        return { snapshot, index: i };
      }
    }
    return null;
  }

  /**
   * Simulate the counterfactual: "what if we had NOT taken `omitAction`?"
   *
   * `snapshotIndex` is the index into ringBuffer (0 = oldest).
   * Returns null if the snapshot index is out of range.
   *
   * For KILL actions:
   *   - The killed process would still be alive
   *   - It would have consumed ~tokensPerTick * extraTicks more tokens
   *   - Time delta ≈ extraTicks * msPerTick
   *
   * For SPAWN actions (counterfactual: "what if we had NOT spawned"):
   *   - The spawned process wouldn't exist
   *   - We project tokens saved = the spawned process's current usage
   *
   * For REPRIORITIZE actions:
   *   - No existence change; token delta is estimated as negligible
   */
  simulateCounterfactual(
    snapshotIndex: number,
    omitAction: KernelAction,
    currentTick: number,
  ): CounterfactualResult | null {
    if (snapshotIndex < 0 || snapshotIndex >= this.ringBuffer.length) {
      return null;
    }

    const snapshot = this.ringBuffer[snapshotIndex]!;
    const ticksElapsed = Math.max(currentTick - snapshot.tick, 0);

    switch (omitAction.kind) {
      case "kill": {
        // If we had NOT killed pid X, it would still be alive.
        // Estimate its ongoing token consumption.
        const { tokensPerTick, name } = omitAction.processMeta;
        const estimatedTokenDelta = tokensPerTick * ticksElapsed;
        const estimatedTimeDeltaMs = ticksElapsed * this.msPerTick;

        const reasoning =
          `Counterfactual: if ${name} (${omitAction.pid}) was NOT killed at tick ${omitAction.tick}, ` +
          `it would have consumed ~${estimatedTokenDelta.toFixed(0)} more tokens ` +
          `(${tokensPerTick.toFixed(1)} tok/tick × ${ticksElapsed} ticks) ` +
          `and run ~${estimatedTimeDeltaMs.toFixed(0)}ms longer. ` +
          `Kill saved these resources.`;

        return {
          snapshotTick: snapshot.tick,
          omittedAction: omitAction,
          projectedExtraAliveProcesses: [omitAction.pid],
          estimatedTokenDelta,
          estimatedTimeDeltaMs,
          reasoning,
        };
      }

      case "spawn": {
        // If we had NOT spawned pid X, it wouldn't exist.
        // The spawned process's actual usage so far is the cost we avoided.
        const spawnedEntry = snapshot.processes.find((p) => p.pid === omitAction.pid);
        const tokensConsumedSoFar = spawnedEntry?.tokensUsed ?? 0;
        const tokensPerTick = spawnedEntry?.tokensPerTick ?? omitAction.processMeta.tokensPerTick;
        const projectedTotal = tokensConsumedSoFar + tokensPerTick * ticksElapsed;

        const reasoning =
          `Counterfactual: if ${omitAction.processMeta.name} (${omitAction.pid}) was NOT spawned ` +
          `at tick ${omitAction.tick}, ~${projectedTotal.toFixed(0)} tokens would have been saved.`;

        return {
          snapshotTick: snapshot.tick,
          omittedAction: omitAction,
          projectedExtraAliveProcesses: [],
          estimatedTokenDelta: -projectedTotal, // negative = tokens saved
          estimatedTimeDeltaMs: -(ticksElapsed * this.msPerTick),
          reasoning,
        };
      }

      case "reprioritize": {
        // Reprioritization doesn't affect existence; token delta is negligible.
        const reasoning =
          `Counterfactual: if ${omitAction.processMeta.name} (${omitAction.pid}) was NOT ` +
          `reprioritized at tick ${omitAction.tick}, scheduling order would differ. ` +
          `Estimated token impact: negligible.`;

        return {
          snapshotTick: snapshot.tick,
          omittedAction: omitAction,
          projectedExtraAliveProcesses: [],
          estimatedTokenDelta: 0,
          estimatedTimeDeltaMs: 0,
          reasoning,
        };
      }
    }
  }
}
