/**
 * Computes deltas between two LensSnapshots.
 * Used to push only changes to connected clients.
 */

import type {
  LensSnapshot,
  LensSnapshotDelta,
  LensProcess,
  LensProcessDelta,
  LensDagNode,
  LensEdge,
  LensBBEntry,
} from "./types.js";

/**
 * Compute the delta between a previous and current LensSnapshot.
 * Returns null if nothing changed.
 */
export function diffSnapshots(
  prev: LensSnapshot,
  curr: LensSnapshot,
): LensSnapshotDelta | null {
  const delta: LensSnapshotDelta = {
    tick: curr.tick,
    timestamp: new Date().toISOString(),
  };

  let hasChanges = false;

  // Process changes
  const procDelta = diffProcesses(prev.processes, curr.processes);
  if (procDelta) {
    delta.processes = procDelta;
    hasChanges = true;
  }

  // DAG changes
  const dagDelta = diffDag(prev.dag, curr.dag);
  if (dagDelta) {
    delta.dag = dagDelta;
    hasChanges = true;
  }

  // Blackboard changes
  const bbDelta = diffBlackboard(prev.blackboard, curr.blackboard);
  if (bbDelta) {
    delta.blackboard = bbDelta;
    hasChanges = true;
  }

  // Metrics changes
  const metricsDelta = diffMetrics(prev.metrics, curr.metrics);
  if (metricsDelta) {
    delta.metrics = metricsDelta;
    hasChanges = true;
  }

  return hasChanges ? delta : null;
}

function diffProcesses(
  prev: LensProcess[],
  curr: LensProcess[],
): LensSnapshotDelta["processes"] | null {
  const prevByPid = new Map(prev.map((p) => [p.pid, p]));
  const currByPid = new Map(curr.map((p) => [p.pid, p]));

  const added: LensProcess[] = [];
  const removed: string[] = [];
  const changed: LensProcessDelta[] = [];

  // Find added and changed
  for (const [pid, proc] of currByPid) {
    const prevProc = prevByPid.get(pid);
    if (!prevProc) {
      added.push(proc);
      continue;
    }

    const changes = diffSingleProcess(prevProc, proc);
    if (changes) {
      changed.push({ pid, changed: changes });
    }
  }

  // Find removed
  for (const pid of prevByPid.keys()) {
    if (!currByPid.has(pid)) {
      removed.push(pid);
    }
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }

  return { added, removed, changed };
}

function diffSingleProcess(
  prev: LensProcess,
  curr: LensProcess,
): LensProcessDelta["changed"] | null {
  const changes: LensProcessDelta["changed"] = {};
  let hasChanges = false;

  if (prev.state !== curr.state) {
    changes.state = curr.state;
    hasChanges = true;
  }
  if (prev.tickCount !== curr.tickCount) {
    changes.tickCount = curr.tickCount;
    hasChanges = true;
  }
  if (prev.tokensUsed !== curr.tokensUsed) {
    changes.tokensUsed = curr.tokensUsed;
    hasChanges = true;
  }
  if (prev.lastActiveAt !== curr.lastActiveAt) {
    changes.lastActiveAt = curr.lastActiveAt;
    hasChanges = true;
  }
  if (prev.exitCode !== curr.exitCode) {
    changes.exitCode = curr.exitCode;
    hasChanges = true;
  }
  if (prev.exitReason !== curr.exitReason) {
    changes.exitReason = curr.exitReason;
    hasChanges = true;
  }
  if (JSON.stringify(prev.checkpoint) !== JSON.stringify(curr.checkpoint)) {
    changes.checkpoint = curr.checkpoint;
    hasChanges = true;
  }
  if (curr.selfReports.length !== prev.selfReports.length) {
    changes.selfReports = curr.selfReports;
    hasChanges = true;
  }
  if (curr.blackboardIO.length !== prev.blackboardIO.length) {
    changes.blackboardIO = curr.blackboardIO;
    hasChanges = true;
  }

  return hasChanges ? changes : null;
}

function diffDag(
  prev: { nodes: LensDagNode[]; edges: LensEdge[] },
  curr: { nodes: LensDagNode[]; edges: LensEdge[] },
): LensSnapshotDelta["dag"] | null {
  const prevNodePids = new Set(prev.nodes.map((n) => n.pid));
  const currNodePids = new Set(curr.nodes.map((n) => n.pid));

  const addedNodes = curr.nodes.filter((n) => !prevNodePids.has(n.pid));
  const removedNodes = prev.nodes
    .filter((n) => !currNodePids.has(n.pid))
    .map((n) => n.pid);

  const edgeKey = (e: LensEdge) => `${e.from}->${e.to}:${e.relation}`;
  const prevEdgeKeys = new Set(prev.edges.map(edgeKey));
  const currEdgeKeys = new Set(curr.edges.map(edgeKey));

  const addedEdges = curr.edges.filter((e) => !prevEdgeKeys.has(edgeKey(e)));
  const removedEdges = prev.edges.filter(
    (e) => !currEdgeKeys.has(edgeKey(e)),
  );

  if (
    addedNodes.length === 0 &&
    removedNodes.length === 0 &&
    addedEdges.length === 0 &&
    removedEdges.length === 0
  ) {
    return null;
  }

  return { addedNodes, removedNodes, addedEdges, removedEdges };
}

function diffBlackboard(
  prev: Record<string, LensBBEntry>,
  curr: Record<string, LensBBEntry>,
): LensSnapshotDelta["blackboard"] | null {
  const updated: LensBBEntry[] = [];
  const removed: string[] = [];

  for (const [key, entry] of Object.entries(curr)) {
    const prevEntry = prev[key];
    if (!prevEntry || JSON.stringify(prevEntry.value) !== JSON.stringify(entry.value)) {
      updated.push(entry);
    }
  }

  for (const key of Object.keys(prev)) {
    if (!(key in curr)) {
      removed.push(key);
    }
  }

  if (updated.length === 0 && removed.length === 0) {
    return null;
  }

  return { updated, removed };
}

function diffMetrics(
  prev: LensSnapshot["metrics"],
  curr: LensSnapshot["metrics"],
): Partial<LensSnapshot["metrics"]> | null {
  const changes: Partial<LensSnapshot["metrics"]> = {};
  let hasChanges = false;

  const keys = Object.keys(curr) as (keyof typeof curr)[];
  for (const key of keys) {
    if (prev[key] !== curr[key]) {
      (changes as any)[key] = curr[key];
      hasChanges = true;
    }
  }

  return hasChanges ? changes : null;
}
