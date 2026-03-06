import type { MetacogCommand } from './types.js';
import type { TelemetrySnapshot } from './types.js';

// ─── Public Types ────────────────────────────────────────────────

export interface BottleneckReport {
  highTokensPerOutputLine: Array<{
    pid: string;
    name: string;
    tokensPerOutputLine: number;
  }>;
  priorityInversions: Array<{
    pid: string;
    name: string;
    waitTimeMs: number;
    blockedByLowerPriority: string[];
  }>;
  starvationRisk: Array<{
    pid: string;
    name: string;
    lastActivationMs: number;
    idleGapMs: number;
  }>;
  convoyEffects: Array<{ pids: string[]; clusterDurationMs: number }>;
  ipcBacklog: never[];
}

export interface Recommendation {
  kind: MetacogCommand['kind'];
  targetPid?: string;
  rationale: string;
  payload: Record<string, unknown>;
}

// ─── Detection Thresholds ────────────────────────────────────────

/** tokensPerOutputLine above this is considered a bottleneck. */
const HIGH_TOKENS_PER_OUTPUT_LINE_THRESHOLD = 50;

/** Process idle gap above this (ms) is starvation risk — 5 minutes. */
const STARVATION_THRESHOLD_MS = 300_000;

/** Window size for convoy-effect clustering (ms). */
const CONVOY_WINDOW_MS = 10_000;

/** Minimum completions inside CONVOY_WINDOW_MS to constitute a convoy. */
const CONVOY_MIN_COMPLETIONS = 3;

/** Pending IPC messages above this threshold is a backlog. */
const IPC_BACKLOG_THRESHOLD = 5;

/**
 * Assumed base priority when ProcessMetrics does not carry per-process priority.
 * Phase 5 instrumentation should propagate OsProcess.priority into telemetry.
 */
const DEFAULT_PRIORITY = 50;

// ─── PerfAnalyzer ────────────────────────────────────────────────

export class PerfAnalyzer {
  constructor(private readonly snapshot: TelemetrySnapshot) {}

  /**
   * Runs all five detection passes and returns a unified BottleneckReport.
   */
  analyze(): BottleneckReport {
    return {
      highTokensPerOutputLine: this.detectHighTokensPerOutputLine(),
      priorityInversions: this.detectPriorityInversions(),
      starvationRisk: this.detectStarvation(),
      convoyEffects: this.detectConvoyEffects(),
      ipcBacklog: [],
    };
  }

  /**
   * Maps each detected bottleneck to an actionable MetacogCommand recommendation.
   */
  recommend(): Recommendation[] {
    const report = this.analyze();
    const recs: Recommendation[] = [];

    // ── highTokensPerOutputLine → reprioritize downward ──────────
    for (const entry of report.highTokensPerOutputLine) {
      recs.push({
        kind: 'reprioritize',
        targetPid: entry.pid,
        rationale:
          `Process ${entry.pid} has tokensPerOutputLine=${entry.tokensPerOutputLine.toFixed(1)} ` +
          `(threshold: ${HIGH_TOKENS_PER_OUTPUT_LINE_THRESHOLD}). ` +
          `Reducing priority to throttle resource consumption.`,
        payload: { newPriority: DEFAULT_PRIORITY - 5 },
      });
    }

    // ── priorityInversions → reprioritize upward ─────────────────
    for (const entry of report.priorityInversions) {
      recs.push({
        kind: 'reprioritize',
        targetPid: entry.pid,
        rationale:
          `Priority inversion: process ${entry.pid} waited ${entry.waitTimeMs}ms ` +
          `while lower-priority processes [${entry.blockedByLowerPriority.join(', ')}] ` +
          `ran ahead of it. Raising priority to restore ordering.`,
        payload: { newPriority: DEFAULT_PRIORITY + 15 },
      });
    }

    // ── starvationRisk → reprioritize upward ─────────────────────
    for (const entry of report.starvationRisk) {
      recs.push({
        kind: 'reprioritize',
        targetPid: entry.pid,
        rationale:
          `Starvation risk: process ${entry.pid} has been idle for ` +
          `${(entry.idleGapMs / 1000).toFixed(0)}s ` +
          `(threshold: ${STARVATION_THRESHOLD_MS / 1000}s). ` +
          `Boosting priority so it gets scheduled before the next metacog cycle.`,
        payload: { newPriority: DEFAULT_PRIORITY + 10 },
      });
    }

    // ── convoyEffects → rewrite_dag ───────────────────────────────
    for (const convoy of report.convoyEffects) {
      recs.push({
        kind: 'rewrite_dag',
        rationale:
          `Convoy effect detected: ${convoy.pids.length} processes completed within ` +
          `a ${convoy.clusterDurationMs}ms window, indicating burst completion and ` +
          `potential head-of-line blocking. Switching to a pipeline topology would ` +
          `interleave execution and reduce queuing latency.`,
        payload: {
          suggestion: 'switch to pipeline topology',
          affectedPids: convoy.pids,
        },
      });
    }

    return recs;
  }

  // ── Detection Passes ────────────────────────────────────────────

  private detectHighTokensPerOutputLine(): BottleneckReport['highTokensPerOutputLine'] {
    const results: BottleneckReport['highTokensPerOutputLine'] = [];

    for (const metrics of Object.values(this.snapshot.processMetrics)) {
      if (metrics.tokensPerOutputLine > HIGH_TOKENS_PER_OUTPUT_LINE_THRESHOLD) {
        results.push({
          pid: metrics.pid,
          // Use the process name populated by TelemetryCollector.onTick() if available,
          // falling back to pid for backward compatibility with older snapshots.
          name: metrics.name ?? metrics.pid,
          tokensPerOutputLine: metrics.tokensPerOutputLine,
        });
      }
    }

    return results;
  }

  private detectPriorityInversions(): BottleneckReport['priorityInversions'] {
    const allMetrics = Object.values(this.snapshot.processMetrics);

    // Only consider processes that have priority data (Phase 5 instrumentation)
    const withPriority = allMetrics.filter(m => m.priority !== undefined);
    if (withPriority.length === 0) return [];

    // Convention: higher priority number = higher scheduling priority (runs first).
    // This matches scheduler.ts: `sort((a, b) => b.priority - a.priority)` (descending).

    // Waiting processes: never activated (firstActivatedAt is null) AND have scheduling wait
    // — these are processes that should be running but haven't been scheduled yet.
    const waitingProcesses = withPriority.filter(
      m => m.firstActivatedAt === null && m.schedulingWaitMs > 0
    );

    // Running processes: activated but not yet completed
    const runningProcesses = withPriority.filter(
      m => m.firstActivatedAt !== null && m.completedAt === null
    );

    const inversions: BottleneckReport['priorityInversions'] = [];

    for (const w of waitingProcesses) {
      // Find running processes with LOWER priority (lower number) than W
      // — these are lower-priority processes that ran while W was waiting
      const blockers = runningProcesses.filter(r => r.priority! < w.priority!);
      if (blockers.length > 0) {
        inversions.push({
          pid: w.pid,
          name: w.name ?? w.pid,
          waitTimeMs: w.schedulingWaitMs,
          blockedByLowerPriority: blockers.map(r => r.pid),
        });
      }
    }

    return inversions;
  }

  private detectStarvation(): BottleneckReport['starvationRisk'] {
    const results: BottleneckReport['starvationRisk'] = [];
    const now = this.snapshot.timestamp;

    for (const metrics of Object.values(this.snapshot.processMetrics)) {
      // Best available estimate of last activation time:
      //   completedAt      — process ran to completion (most precise)
      //   firstActivatedAt — process started but not yet complete
      //   createdAt        — process was never activated at all (worst starvation)
      const lastActivationMs =
        metrics.completedAt ?? metrics.firstActivatedAt ?? metrics.createdAt;
      const idleGapMs = now - lastActivationMs;

      if (idleGapMs > STARVATION_THRESHOLD_MS) {
        results.push({
          pid: metrics.pid,
          name: metrics.pid,
          lastActivationMs,
          idleGapMs,
        });
      }
    }

    return results;
  }

  private detectConvoyEffects(): BottleneckReport['convoyEffects'] {
    // Build a sorted list of processes that have completed.
    const completed = Object.values(this.snapshot.processMetrics)
      .filter(m => m.completedAt !== null)
      .map(m => ({ pid: m.pid, completedAt: m.completedAt! }))
      .sort((a, b) => a.completedAt - b.completedAt);

    const convoys: BottleneckReport['convoyEffects'] = [];
    // Track PIDs already included in a reported convoy to avoid duplicates.
    const reported = new Set<string>();

    for (let i = 0; i < completed.length; i++) {
      const entry = completed[i];
      if (reported.has(entry.pid)) continue;

      const windowEnd = entry.completedAt + CONVOY_WINDOW_MS;
      const inWindow = completed.filter(
        c => c.completedAt >= entry.completedAt && c.completedAt <= windowEnd,
      );

      if (inWindow.length >= CONVOY_MIN_COMPLETIONS) {
        const first = inWindow[0]!;
        const last = inWindow[inWindow.length - 1]!;
        const clusterDurationMs = last.completedAt - first.completedAt;

        convoys.push({
          pids: inWindow.map(c => c.pid),
          clusterDurationMs,
        });

        for (const c of inWindow) {
          reported.add(c.pid);
        }
      }
    }

    return convoys;
  }

}
