import type { KernelRun, RuntimeProtocolEvent } from "../types.js";
import type { DeferCondition, OsDagEdge, OsProcess, OsSystemSnapshot } from "../os/types.js";

type FocusProcess = {
  pid: string;
  name: string;
  state: OsProcess["state"];
  priority: number;
  tokensUsed: number;
};

export type RunTopologyView = {
  runId: string;
  status: KernelRun["status"];
  goal: string;
  summary: {
    processCount: number;
    rootCount: number;
    dependencyCount: number;
    runningCount: number;
    stalledCount: number;
    deadCount: number;
    maxDepth: number;
    totalTokensUsed: number;
  };
  tokenLeaders: FocusProcess[];
  stalled: FocusProcess[];
  treeText: string;
  dependencyText: string;
  text: string;
};

export type RunTimelineView = {
  runId: string;
  status: KernelRun["status"];
  eventCount: number;
  displayedCount: number;
  omittedCount: number;
  lines: string[];
  text: string;
};

export type RunDashboardView = {
  runId: string;
  status: KernelRun["status"];
  goal: string;
  topology: RunTopologyView;
  timeline: RunTimelineView;
  text: string;
};

export function buildRunTopologyView(run: KernelRun, snapshot: OsSystemSnapshot): RunTopologyView {
  const processById = new Map(snapshot.processes.map((process) => [process.pid, process]));
  const childrenByParent = new Map<string | null, OsProcess[]>();

  for (const process of snapshot.processes) {
    const parentKey = process.parentPid && processById.has(process.parentPid)
      ? process.parentPid
      : null;
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push(process);
    childrenByParent.set(parentKey, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareProcesses);
  }

  const roots = childrenByParent.get(null) ?? [];
  const dependencyEdges = snapshot.dagTopology.edges.filter((edge) => edge.relation === "dependency");
  const tokenLeaders = snapshot.processes
    .slice()
    .sort((left, right) => right.tokensUsed - left.tokensUsed || compareProcesses(left, right))
    .slice(0, 5)
    .map(toFocusProcess);
  const stalled = snapshot.processes
    .filter((process) => isStalledState(process.state))
    .sort((left, right) => right.priority - left.priority || right.tokensUsed - left.tokensUsed)
    .slice(0, 5)
    .map(toFocusProcess);

  const lines = ["ROOT"];
  for (let index = 0; index < roots.length; index += 1) {
    appendProcessTree(lines, childrenByParent, roots[index], "", index === roots.length - 1);
  }

  const treeText = lines.join("\n");
  const dependencyText = renderDependencyText(dependencyEdges, processById);
  const totalTokensUsed = snapshot.progressMetrics.totalTokensUsed;
  const summary = {
    processCount: snapshot.processes.length,
    rootCount: roots.length,
    dependencyCount: dependencyEdges.length,
    runningCount: snapshot.processes.filter((process) => process.state === "running").length,
    stalledCount: snapshot.processes.filter((process) => isStalledState(process.state)).length,
    deadCount: snapshot.processes.filter((process) => process.state === "dead").length,
    maxDepth: snapshot.dagMetrics.maxDepth,
    totalTokensUsed,
  };

  const text = [
    `Run ${shortId(run.id)} [${run.status.toUpperCase()}]`,
    `Goal: ${snapshot.goal}`,
    `Topology: ${summary.processCount} processes, ${summary.dependencyCount} dependencies, depth ${summary.maxDepth}`,
    `State: running=${summary.runningCount} stalled=${summary.stalledCount} dead=${summary.deadCount} tokens=${summary.totalTokensUsed}`,
    "",
    "Topology",
    treeText,
    "",
    "Dependencies",
    dependencyText,
    "",
    "Attention",
    renderFocusList("Token-heavy", tokenLeaders, "No token-heavy processes yet."),
    renderFocusList("High-priority stalled", stalled, "No stalled processes."),
    renderDeferrals(snapshot),
  ].join("\n");

  return {
    runId: run.id,
    status: run.status,
    goal: snapshot.goal,
    summary,
    tokenLeaders,
    stalled,
    treeText,
    dependencyText,
    text,
  };
}

export function buildRunTimelineView(
  run: KernelRun,
  events: RuntimeProtocolEvent[],
  limit = 25,
): RunTimelineView {
  const filtered = events.filter((event) => event.action !== "os_llm_stream");
  const displayed = filtered.slice(Math.max(0, filtered.length - limit));
  const lines = displayed.map(formatEventLine);
  const omittedCount = Math.max(0, filtered.length - displayed.length);
  const text = [
    `Run ${shortId(run.id)} timeline [${run.status.toUpperCase()}]`,
    omittedCount > 0
      ? `Showing last ${displayed.length} of ${filtered.length} structural events`
      : `Showing ${displayed.length} structural events`,
    "",
    ...(lines.length > 0 ? lines : ["No structural events recorded yet."]),
  ].join("\n");

  return {
    runId: run.id,
    status: run.status,
    eventCount: filtered.length,
    displayedCount: displayed.length,
    omittedCount,
    lines,
    text,
  };
}

export function buildRunDashboardView(
  run: KernelRun,
  snapshot: OsSystemSnapshot,
  events: RuntimeProtocolEvent[],
): RunDashboardView {
  const topology = buildRunTopologyView(run, snapshot);
  const timeline = buildRunTimelineView(run, events, 12);
  const elapsedMs = Date.now() - Date.parse(run.startedAt ?? run.createdAt);
  const text = [
    `Run ${shortId(run.id)} [${run.status.toUpperCase()}]`,
    `Goal: ${snapshot.goal}`,
    `Started: ${run.startedAt ?? run.createdAt}`,
    `Elapsed: ${humanDuration(elapsedMs)} | Tick: ${snapshot.tickCount} | Active: ${snapshot.progressMetrics.activeProcessCount} | Stalled: ${snapshot.progressMetrics.stalledProcessCount}`,
    `Blackboard keys: ${snapshot.ipcSummary.blackboardKeyCount} | Signals: ${snapshot.ipcSummary.signalCount} | Heuristics: ${snapshot.recentHeuristics.length}`,
    "",
    "Current topology",
    topology.treeText,
    "",
    "Pressure points",
    renderFocusList("Token-heavy", topology.tokenLeaders, "No token-heavy processes yet."),
    renderFocusList("High-priority stalled", topology.stalled, "No stalled processes."),
    renderDeferrals(snapshot),
    "",
    "Recent structural events",
    ...(timeline.lines.length > 0 ? timeline.lines : ["No structural events recorded yet."]),
  ].join("\n");

  return {
    runId: run.id,
    status: run.status,
    goal: snapshot.goal,
    topology,
    timeline,
    text,
  };
}

function appendProcessTree(
  lines: string[],
  childrenByParent: Map<string | null, OsProcess[]>,
  process: OsProcess,
  prefix: string,
  isLast: boolean,
): void {
  const branch = isLast ? "└─" : "├─";
  lines.push(`${prefix}${branch} ${formatProcessNode(process)}`);

  const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
  const children = childrenByParent.get(process.pid) ?? [];
  for (let index = 0; index < children.length; index += 1) {
    appendProcessTree(lines, childrenByParent, children[index], childPrefix, index === children.length - 1);
  }
}

function formatProcessNode(process: OsProcess): string {
  const state = process.state.toUpperCase();
  const parent = process.parentPid ? ` parent=${process.parentPid}` : "";
  const objective = truncate(process.objective, 70);
  return `${process.name} (${process.pid}) [${process.type}/${state}] p=${process.priority} tok=${process.tokensUsed} ticks=${process.tickCount}${parent} :: ${objective}`;
}

function renderDependencyText(
  dependencyEdges: OsDagEdge[],
  processById: Map<string, OsProcess>,
): string {
  if (dependencyEdges.length === 0) {
    return "No explicit dependency edges.";
  }

  return dependencyEdges
    .map((edge) => {
      const fromName = processById.get(edge.from)?.name ?? edge.from;
      const toName = processById.get(edge.to)?.name ?? edge.to;
      const label = edge.label ? ` :: ${edge.label}` : "";
      return `- ${fromName} (${edge.from}) -> ${toName} (${edge.to})${label}`;
    })
    .join("\n");
}

function renderFocusList(title: string, items: FocusProcess[], emptyMessage: string): string {
  if (items.length === 0) {
    return `${title}: ${emptyMessage}`;
  }

  return `${title}: ${items
    .map((item) => `${item.name}(${item.pid})[${item.state}] p=${item.priority} tok=${item.tokensUsed}`)
    .join(", ")}`;
}

function renderDeferrals(snapshot: OsSystemSnapshot): string {
  const deferrals = snapshot.deferrals ?? [];
  if (deferrals.length === 0) {
    return "Deferrals: none.";
  }

  return `Deferrals: ${deferrals
    .map((deferral) => `${deferral.name} waited=${deferral.waitedTicks} condition=${formatDeferCondition(deferral.condition)} reason=${truncate(deferral.reason, 80)}`)
    .join(" | ")}`;
}

function formatEventLine(event: RuntimeProtocolEvent): string {
  const timestamp = formatShortTimestamp(event.timestamp);
  const actor = event.agentName
    ? `${event.agentName}${event.agentId ? `(${event.agentId})` : ""}`
    : event.agentId ?? "kernel";
  const message = event.message ? ` :: ${truncate(event.message, 120)}` : "";
  return `${timestamp} ${event.action} ${event.status} [${actor}]${message}`;
}

function toFocusProcess(process: OsProcess): FocusProcess {
  return {
    pid: process.pid,
    name: process.name,
    state: process.state,
    priority: process.priority,
    tokensUsed: process.tokensUsed,
  };
}

function compareProcesses(left: OsProcess, right: OsProcess): number {
  return right.priority - left.priority
    || left.spawnedAt.localeCompare(right.spawnedAt)
    || left.name.localeCompare(right.name);
}

function isStalledState(state: OsProcess["state"]): boolean {
  return state === "idle" || state === "sleeping" || state === "suspended" || state === "checkpoint";
}

function formatShortTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return `${date.toISOString().slice(11, 23)}Z`;
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  if (ms < 1000) {
    return `${Math.floor(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength - 3)}...`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatDeferCondition(condition: DeferCondition): string {
  switch (condition.type) {
    case "blackboard_key_exists":
      return `bb:${condition.key}:exists`;
    case "blackboard_key_match":
      return `bb:${condition.key}==${JSON.stringify(condition.value)}`;
    case "blackboard_value_contains":
      return `bb:${condition.key}:contains(${condition.substring})`;
    case "process_dead":
      return `process:${condition.pid}:dead`;
    case "process_dead_by_name":
      return `process:${condition.name}:dead`;
    case "all_of":
      return `all(${condition.conditions.map(formatDeferCondition).join(", ")})`;
    case "any_of":
      return `any(${condition.conditions.map(formatDeferCondition).join(", ")})`;
    default:
      return "unknown";
  }
}
