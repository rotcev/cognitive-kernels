/**
 * cognitive-lens type definitions — the contract between Lens and the UI.
 *
 * These types are self-contained. They do not depend on the kernel codebase.
 * Products import from `cognitive-lens` and never see kernel internals.
 */

// ── Kernel primitives (inlined to avoid kernel dependency) ───────

export type ProcessType = "daemon" | "lifecycle" | "event";

export type ProcessState =
  | "spawned"
  | "running"
  | "sleeping"
  | "idle"
  | "suspended"
  | "checkpoint"
  | "dead";

export type DagEdge = {
  from: string;
  to: string;
  relation: "parent-child" | "dependency" | "ipc" | "signal";
  label?: string;
};

export type ProtocolEventStatus = "started" | "completed" | "failed";

export type ProtocolEvent = {
  action: string;
  status: ProtocolEventStatus;
  timestamp: string;
  objective?: string;
  agentId?: string;
  agentName?: string;
  attempt?: number;
  dependencyIds?: string[];
  message?: string;
  eventSource?: string;
  detail?: Record<string, unknown>;
};

// ── Process Role ─────────────────────────────────────────────────

export type LensProcessRole = "kernel" | "sub-kernel" | "worker" | "shell";

// ── Process ──────────────────────────────────────────────────────

export interface LensProcess {
  pid: string;
  name: string;
  type: ProcessType;
  state: ProcessState;
  role: LensProcessRole;
  parentPid: string | null;
  children: string[];
  objective: string;
  priority: number;
  tickCount: number;
  tokensUsed: number;
  tokenBudget: number | null;
  model: string;
  spawnedAt: string;
  lastActiveAt: string;
  exitCode?: number;
  exitReason?: string;
  checkpoint?: { reason: string; savedAt: string };
  wakeOnSignals?: string[];
  backendKind: "llm" | "system" | "kernel" | undefined;
  selfReports: LensSelfReport[];
  blackboardIO: LensBBIOEntry[];
}

export interface LensSelfReport {
  tick: number;
  summary: string;
}

// ── Blackboard I/O ───────────────────────────────────────────────

export interface LensBBIOEntry {
  key: string;
  direction: "read" | "write";
  value: unknown;
  valuePreview: string;
}

export interface LensBBEntry {
  key: string;
  value: unknown;
  writer: string;
  tick?: number;
  readBy: string[];
}

// ── DAG ──────────────────────────────────────────────────────────

export interface LensDagNode {
  pid: string;
  name: string;
  type: ProcessType;
  state: ProcessState;
  role: LensProcessRole;
  priority: number;
  parentPid: string | null;
}

export type LensEdge = DagEdge;

// ── Metrics ──────────────────────────────────────────────────────

export interface LensMetrics {
  totalTokens: number;
  tokenRate: number;
  processCount: number;
  runningCount: number;
  sleepingCount: number;
  deadCount: number;
  checkpointedCount: number;
  suspendedCount: number;
  dagDepth: number;
  dagEdgeCount: number;
  wallTimeElapsedMs: number;
  tickCount: number;
}

// ── Heuristic ────────────────────────────────────────────────────

export interface LensHeuristic {
  id: string;
  heuristic: string;
  confidence: number;
  context: string;
  scope: "global" | "local";
  reinforcementCount: number;
}

// ── Deferral ─────────────────────────────────────────────────────

export interface LensDeferral {
  id: string;
  name: string;
  conditionType: string;
  conditionKey: string;
  waitedTicks: number;
  reason: string;
}

// ── Terminal Line ────────────────────────────────────────────────

export type LensTerminalLevel =
  | "system"
  | "info"
  | "thinking"
  | "tool"
  | "output"
  | "error";

export interface LensTerminalLine {
  seq: number;
  timestamp: string;
  pid: string;
  processName: string;
  level: LensTerminalLevel;
  text: string;
}

// ── Full Snapshot ────────────────────────────────────────────────

export interface LensSnapshot {
  runId: string;
  tick: number;
  goal: string;
  elapsed: number;

  processes: LensProcess[];
  dag: { nodes: LensDagNode[]; edges: LensEdge[] };
  blackboard: Record<string, LensBBEntry>;
  heuristics: LensHeuristic[];
  deferrals: LensDeferral[];
  metrics: LensMetrics;
}

// ── Snapshot Delta ───────────────────────────────────────────────

export interface LensSnapshotDelta {
  tick: number;
  timestamp: string;
  processes?: {
    added: LensProcess[];
    removed: string[];
    changed: LensProcessDelta[];
  };
  dag?: {
    addedEdges: LensEdge[];
    removedEdges: LensEdge[];
    addedNodes: LensDagNode[];
    removedNodes: string[];
  };
  blackboard?: {
    updated: LensBBEntry[];
    removed: string[];
  };
  metrics?: Partial<LensMetrics>;
  events?: LensTerminalLine[];
}

export interface LensProcessDelta {
  pid: string;
  changed: Partial<
    Pick<
      LensProcess,
      | "state"
      | "tickCount"
      | "tokensUsed"
      | "lastActiveAt"
      | "exitCode"
      | "exitReason"
      | "checkpoint"
      | "selfReports"
      | "blackboardIO"
    >
  >;
}

// ── Terminal Filter ──────────────────────────────────────────────

export type LensTerminalFilter = {
  pids?: string[];
  levels?: LensTerminalLevel[];
};

// ── WebSocket Protocol ───────────────────────────────────────────

export type LensClientMessage =
  | { type: "subscribe"; runId: string }
  | { type: "unsubscribe"; runId: string }
  | { type: "subscribe_process"; runId: string; pid: string }
  | { type: "unsubscribe_process"; runId: string; pid: string }
  | { type: "subscribe_terminal"; runId: string; filter?: LensTerminalFilter }
  | { type: "unsubscribe_terminal"; runId: string }
  | { type: "command_query"; runId: string; question: string }
  | { type: "send_message"; runId: string; pid: string; text: string };

export type LensServerMessage =
  | { type: "snapshot"; runId: string; snapshot: LensSnapshot }
  | { type: "delta"; runId: string; delta: LensSnapshotDelta }
  | { type: "event"; runId: string; event: ProtocolEvent }
  | { type: "cognitive_event"; runId: string; cognitiveEvent: import("./cognitive-events.js").LensCognitiveEvent }
  | { type: "terminal_line"; runId: string; pid: string; line: LensTerminalLine }
  | { type: "run_end"; runId: string; reason: string }
  | { type: "narrative"; runId: string; text: string }
  | { type: "command_response"; runId: string; text: string; done: boolean }
  | { type: "message_ack"; runId: string; pid: string; text: string; deliveredAt: string | null }
  | { type: "error"; message: string };
