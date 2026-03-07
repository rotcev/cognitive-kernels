/**
 * Transforms raw OsSystemSnapshot into LensSnapshot.
 * Pure function — no IO, no LLM.
 */

import type {
  OsSystemSnapshot,
  OsProcess,
  OsHeuristic,
} from "../os/types.js";
import { classifyRole } from "./role-classifier.js";
import type {
  LensSnapshot,
  LensProcess,
  LensDagNode,
  LensEdge,
  LensBBEntry,
  LensBBIOEntry,
  LensHeuristic,
  LensDeferral,
  LensMetrics,
  LensSelfReport,
} from "./types.js";

/**
 * Build a complete LensSnapshot from a kernel OsSystemSnapshot.
 *
 * The snapshot's `blackboard` field is Record<string, unknown> (values only).
 * To get full metadata (writtenBy, readBy), we reconstruct from process data.
 */
export function buildLensSnapshot(
  snap: OsSystemSnapshot,
  prevTokens?: { total: number; timestamp: number },
): LensSnapshot {
  const processes = snap.processes.map((p) =>
    buildLensProcess(p, snap.processes, snap.blackboard),
  );

  const dag = buildLensDag(snap);
  const blackboard = buildLensBB(snap);
  const heuristics = buildLensHeuristics(snap.recentHeuristics ?? []);
  const deferrals = buildLensDeferrals(snap.deferrals ?? []);
  const metrics = buildLensMetrics(snap, prevTokens);

  return {
    runId: snap.runId,
    tick: snap.tickCount,
    goal: snap.goal,
    elapsed: snap.progressMetrics?.wallTimeElapsedMs ?? 0,
    processes,
    dag,
    blackboard,
    heuristics,
    deferrals,
    metrics,
  };
}

function buildLensProcess(
  proc: OsProcess,
  allProcs: OsProcess[],
  blackboard?: Record<string, unknown>,
): LensProcess {
  const role = classifyRole(proc, allProcs);
  const bbIO = buildProcessBBIO(proc, blackboard);
  const selfReports: LensSelfReport[] = (proc.selfReports ?? []).map((r) => ({
    tick: r.tick,
    summary: r.reason ?? `efficiency=${r.efficiency}, pressure=${r.resourcePressure}`,
  }));

  return {
    pid: proc.pid,
    name: proc.name,
    type: proc.type,
    state: proc.state,
    role,
    parentPid: proc.parentPid,
    children: proc.children,
    objective: proc.objective,
    priority: proc.priority,
    tickCount: proc.tickCount,
    tokensUsed: proc.tokensUsed,
    tokenBudget: proc.tokenBudget ?? null,
    model: proc.model,
    spawnedAt: proc.spawnedAt,
    lastActiveAt: proc.lastActiveAt,
    exitCode: proc.exitCode,
    exitReason: proc.exitReason,
    checkpoint: proc.checkpoint
      ? { reason: proc.checkpoint.conversationSummary, savedAt: proc.checkpoint.capturedAt }
      : undefined,
    backendKind: proc.backend?.kind,
    wakeOnSignals: proc.wakeOnSignals,
    selfReports,
    blackboardIO: bbIO,
  };
}

function buildProcessBBIO(
  proc: OsProcess,
  blackboard?: Record<string, unknown>,
): LensBBIOEntry[] {
  const entries: LensBBIOEntry[] = [];
  const written = new Set(proc.blackboardKeysWritten ?? []);

  // Keys this process wrote
  for (const key of written) {
    const value = blackboard?.[key];
    entries.push({
      key,
      direction: "write",
      value: value ?? null,
      valuePreview: previewValue(value),
    });
  }

  // We can't determine reads from the snapshot alone (readBy is stripped).
  // The Lens will augment this from protocol events when available.

  return entries;
}

function buildLensDag(snap: OsSystemSnapshot): { nodes: LensDagNode[]; edges: LensEdge[] } {
  const nodes: LensDagNode[] = snap.dagTopology.nodes.map((n) => {
    const proc = snap.processes.find((p) => p.pid === n.pid);
    return {
      pid: n.pid,
      name: n.name,
      type: n.type,
      state: n.state,
      role: proc ? classifyRole(proc, snap.processes) : "shell",
      priority: n.priority,
      parentPid: n.parentPid,
    };
  });

  const edges: LensEdge[] = snap.dagTopology.edges.map((e) => ({
    from: e.from,
    to: e.to,
    relation: e.relation,
    label: e.label,
  }));

  return { nodes, edges };
}

function buildLensBB(snap: OsSystemSnapshot): Record<string, LensBBEntry> {
  const result: Record<string, LensBBEntry> = {};

  if (!snap.blackboard) return result;

  for (const [key, value] of Object.entries(snap.blackboard)) {
    // Find writer from process data
    const writer = snap.processes.find((p) =>
      p.blackboardKeysWritten?.includes(key),
    );

    result[key] = {
      key,
      value,
      writer: writer?.name ?? "unknown",
      readBy: [], // Can't determine from snapshot alone; augmented from events
    };
  }

  return result;
}

function buildLensHeuristics(heuristics: OsHeuristic[]): LensHeuristic[] {
  return heuristics.map((h) => ({
    id: h.id,
    heuristic: h.heuristic,
    confidence: h.confidence,
    context: h.context,
    scope: h.scope ?? "local",
    reinforcementCount: h.reinforcementCount,
  }));
}

function buildLensDeferrals(
  deferrals?: Array<{
    id: string;
    name: string;
    condition: { type: string; key?: string; [k: string]: unknown };
    waitedTicks: number;
    reason: string;
  }>,
): LensDeferral[] {
  if (!deferrals) return [];

  return deferrals.map((d) => ({
    id: d.id,
    name: d.name,
    conditionType: d.condition.type,
    conditionKey: (d.condition.key as string) ?? "",
    waitedTicks: d.waitedTicks,
    reason: d.reason,
  }));
}

function buildLensMetrics(
  snap: OsSystemSnapshot,
  prevTokens?: { total: number; timestamp: number },
): LensMetrics {
  const procs = snap.processes;
  const now = Date.now();

  let tokenRate = 0;
  if (prevTokens) {
    const dt = (now - prevTokens.timestamp) / 1000;
    if (dt > 0) {
      tokenRate = Math.round(
        ((snap.progressMetrics?.totalTokensUsed ?? 0) - prevTokens.total) / dt,
      );
    }
  }

  return {
    totalTokens: snap.progressMetrics?.totalTokensUsed ?? 0,
    tokenRate: Math.max(0, tokenRate),
    processCount: procs.length,
    runningCount: procs.filter((p) => p.state === "running").length,
    sleepingCount: procs.filter((p) => p.state === "sleeping").length,
    deadCount: procs.filter((p) => p.state === "dead").length,
    checkpointedCount: procs.filter((p) => p.state === "checkpoint").length,
    suspendedCount: procs.filter((p) => p.state === "suspended").length,
    dagDepth: snap.dagMetrics?.maxDepth ?? 0,
    dagEdgeCount: snap.dagMetrics?.edgeCount ?? snap.dagTopology?.edges?.length ?? 0,
    wallTimeElapsedMs: snap.progressMetrics?.wallTimeElapsedMs ?? 0,
    tickCount: snap.tickCount,
  };
}

/**
 * Truncated preview of a blackboard value.
 */
export function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 60 ? value.slice(0, 60) + "..." : value;
  const json = JSON.stringify(value);
  return json.length > 60 ? json.slice(0, 60) + "..." : json;
}
