export type ProcessState = "running" | "sleeping" | "idle" | "dead" | "checkpoint" | "suspended";
export type ProcessRole = "kernel" | "sub-kernel" | "worker" | "shell";
export type ProcessType = "lifecycle" | "daemon" | "event";
export type TerminalLevel = "system" | "info" | "thinking" | "tool" | "output" | "error";
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
export type RunStatus = "running" | "completed" | "failed" | "paused" | "canceled";

export interface LensProcess {
  pid: string;
  name: string;
  type: ProcessType;
  state: ProcessState;
  role: ProcessRole;
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
}

export interface LensMetrics {
  totalTokens: number;
  tokenRate: number;
  processCount: number;
  runningCount: number;
  sleepingCount: number;
  deadCount: number;
  wallTimeElapsedMs: number;
  tickCount: number;
}

export interface LensBBEntry {
  key: string;
  value: unknown;
  writer: string;
  readBy: string[];
}

export interface LensHeuristic {
  id: string;
  heuristic: string;
  confidence: number;
  context: string;
  scope: "global" | "local";
  reinforcementCount: number;
}

export interface LensDeferral {
  id: string;
  name: string;
  conditionType: string;
  conditionKey: string;
  waitedTicks: number;
  reason: string;
}

export interface LensTerminalLine {
  seq: number;
  timestamp: string;
  pid: string;
  processName: string;
  level: TerminalLevel;
  text: string;
}

export interface LensEvent {
  action: string;
  status: string;
  timestamp: string;
  agentName?: string;
  message: string;
}

export interface LensDagNode {
  pid: string;
  name: string;
  type: ProcessType;
  state: ProcessState;
  role: ProcessRole;
  priority: number;
  parentPid: string | null;
}

export interface LensDagEdge {
  from: string;
  to: string;
  relation: "parent-child" | "dependency";
  label?: string;
}

export interface LensRun {
  id: string;
  status: RunStatus;
  goal: string;
  createdAt: string;
  elapsed: number;
}

export interface LensSnapshot {
  runId: string;
  tick: number;
  goal: string;
  elapsed: number;
  processes: LensProcess[];
  dag: { nodes: LensDagNode[]; edges: LensDagEdge[] };
  blackboard: Record<string, LensBBEntry>;
  heuristics: LensHeuristic[];
  deferrals: LensDeferral[];
  metrics: LensMetrics;
}
