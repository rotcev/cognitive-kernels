/**
 * Pure metacog context builder — reads only from KernelState.
 *
 * Replaces the impure `OsKernel.buildMetacogContext()` which reads from
 * mutable kernel fields, IPC bus, DAG engine, memory store, etc.
 *
 * This is a pure function: same KernelState in → same MetacogContext out.
 * No I/O, no side effects, no Date.now() dependencies (except wallTimeElapsedMs).
 */

import type { KernelState } from "./state.js";
import type { MetacogContext, OsIpcSummary, OsDagDelta, OsProgressMetrics } from "../types.js";

/**
 * Build a MetacogContext entirely from KernelState — no I/O, no mutable kernel fields.
 */
export function buildMetacogContextPure(state: KernelState): MetacogContext {
  const ticksSinceLastEval = state.tickCount - state.lastMetacogTick;

  // Trigger: first pending trigger, if any
  const trigger = state.pendingTriggers.length > 0
    ? state.pendingTriggers[0]
    : undefined;

  // IPC summary from blackboard state
  const ipcActivity: OsIpcSummary = {
    signalCount: 0, // Signal count not tracked in KernelState — signals are fire-and-forget
    blackboardKeyCount: state.blackboard.size,
  };

  // Minimal zero DAG delta — transition doesn't track incremental deltas.
  // The transition function works on state snapshots, not diffs.
  const dagDelta: OsDagDelta = {
    since: new Date(state.startTime).toISOString(),
    nodesAdded: [],
    nodesRemoved: [],
    edgesAdded: [],
    edgesRemoved: [],
    nodesUpdated: [],
  };

  // Progress metrics from process table
  const allProcesses = Array.from(state.processes.values());
  const totalTokensUsed = allProcesses.reduce((sum, p) => sum + p.tokensUsed, 0);
  const activeProcessCount = allProcesses.filter(p => p.state === "running").length;
  const stalledProcessCount = allProcesses.filter(
    p => p.state === "sleeping" || p.state === "idle",
  ).length;

  const progressMetrics: OsProgressMetrics = {
    activeProcessCount,
    stalledProcessCount,
    totalTokensUsed,
    tokenBudgetRemaining: state.config.kernel.tokenBudget - totalTokensUsed,
    wallTimeElapsedMs: Date.now() - state.startTime,
    tickCount: state.tickCount,
  };

  // System complexity (same formula as kernel.ts)
  const aliveProcessCount = allProcesses.filter(p => p.state !== "dead").length;
  const stalledRatio = aliveProcessCount > 0
    ? stalledProcessCount / aliveProcessCount
    : 0;
  const systemComplexity = aliveProcessCount * (1 + stalledRatio);

  // Blackboard value summaries — exclude system: prefixed keys
  const summaries: Record<string, string> = {};
  for (const [key, entry] of state.blackboard) {
    if (key.startsWith("system:")) continue;
    const val = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
    summaries[key] = val.length > 200 ? val.slice(0, 200) + "..." : val;
  }

  // Kill threshold calibration
  const avgTokenSavedPerKill = state.killEvalHistory.length > 0
    ? state.killEvalHistory.reduce((sum: number, r: any) => sum + r.tokenDelta, 0) / state.killEvalHistory.length
    : undefined;

  // Deferrals
  const deferrals = state.deferrals.size > 0
    ? Array.from(state.deferrals.values()).map(ds => ({
        id: ds.id,
        name: ds.descriptor.name ?? "unnamed",
        condition: ds.condition,
        waitedTicks: state.tickCount - ds.registeredByTick,
        reason: ds.reason,
      }))
    : undefined;

  // Observation results from blackboard (keys starting with observation:)
  const observationResults: Array<{ key: string; value: unknown }> = [];
  for (const [key, entry] of state.blackboard) {
    if (key.startsWith("observation:")) {
      observationResults.push({ key, value: entry.value });
    }
  }

  // Flagged heuristics from blackboard
  const flaggedHeuristicsEntry = state.blackboard.get("awareness:heuristic-flags");
  const flaggedHeuristics = flaggedHeuristicsEntry
    && Array.isArray(flaggedHeuristicsEntry.value)
    && (flaggedHeuristicsEntry.value as any[]).length > 0
    ? flaggedHeuristicsEntry.value as Array<{ id: string; reason: string }>
    : undefined;

  // sinceLastWakeSec: seconds since last metacog wake
  const sinceLastWakeSec = state.lastMetacogWakeAt > 0
    ? (Date.now() - state.lastMetacogWakeAt) / 1000
    : undefined;

  return {
    ticksSinceLastEval,
    trigger,
    processEvents: [], // Events are consumed-on-read in the old model; pure transition uses state snapshots
    ipcActivity,
    dagDelta,
    progressMetrics,
    relevantHeuristics: state.schedulerHeuristics,
    systemComplexity,
    awarenessNotes: state.awarenessNotes.length > 0 ? [...state.awarenessNotes] : undefined,
    metacogFocus: state.metacogFocus ?? undefined,
    oscillationWarnings: state.oscillationWarnings.length > 0 ? [...state.oscillationWarnings] : undefined,
    detectedBlindSpots: state.blindSpots.length > 0 ? [...state.blindSpots] : undefined,
    blackboardValueSummaries: Object.keys(summaries).length > 0 ? summaries : undefined,
    deferrals,
    observationResults: observationResults.length > 0 ? observationResults : undefined,
    flaggedHeuristics,
    killThresholdAdjustment: state.killThresholdAdjustment !== 0 ? state.killThresholdAdjustment : undefined,
    avgTokenSavedPerKill,
    sinceLastWakeSec,
  };
}
