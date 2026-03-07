import type { ThreadOptions } from "@openai/codex-sdk";

export type BrainProvider = "claude" | "codex";

export type BrainRuntimeConfig = {
  provider: BrainProvider;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  env: Record<string, string>;
  config: Record<string, unknown>;
};

export type StreamEventUsage = {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  durationMs: number;
  numTurns: number;
};

export type StreamEventValue =
  | string
  | number
  | boolean
  | null
  | StreamEventValue[]
  | { [key: string]: StreamEventValue };

export type StreamToolEventBase = {
  toolName: string;
  toolUseId: string;
  provider: BrainProvider;
  argumentsSummary?: StreamEventValue;
  resultSummary?: StreamEventValue;
};

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | ({ type: "tool_started" } & StreamToolEventBase)
  | ({ type: "tool_progress"; elapsedSeconds: number } & StreamToolEventBase)
  | ({ type: "tool_completed" } & StreamToolEventBase)
  | ({ type: "tool_failed"; error: string } & StreamToolEventBase)
  | { type: "status"; status: string }
  | { type: "task_started"; taskId: string; description: string }
  | { type: "task_completed"; taskId: string; status: string; summary: string }
  | { type: "usage"; usage: StreamEventUsage };

export type StreamEventCallback = (event: StreamEvent) => void;

export type ProcessStreamCallback = (
  pid: string,
  processName: string,
  event: StreamEvent,
) => void;

export type TurnResult = {
  finalResponse: string;
  usage?: StreamEventUsage | Record<string, number> | null;
};

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type ExtendedBrainThreadOptions = ThreadOptions & {
  mcpServers?: Record<string, McpServerConfig>;
};

export interface BrainThread {
  readonly id: string | null;
  run(
    input: string,
    turnOptions?: {
      outputSchema?: unknown;
      agentLogPath?: string;
      onStreamEvent?: StreamEventCallback;
    },
  ): Promise<TurnResult>;
}

export interface Brain {
  startThread(options?: ExtendedBrainThreadOptions): BrainThread;
}

export type RuntimeProtocolAction = string;

export type RuntimeProtocolStatus = "started" | "completed" | "failed";

export type RuntimeProtocolEvent = {
  action: RuntimeProtocolAction;
  status: RuntimeProtocolStatus;
  timestamp: string;
  objective?: string;
  agentId?: string;
  agentName?: string;
  attempt?: number;
  dependencyIds?: string[];
  message?: string;
  eventSource?: string;
  /** Structured detail — carries typed cognitive data alongside the human-readable message. */
  detail?: Record<string, unknown>;
};

export type KernelRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type KernelRunArtifacts = {
  runDir: string;
  runFilePath: string;
  outputPath: string;
  protocolLogPath: string;
  livePath: string;
  snapshotPath: string;
  stdoutPath: string;
  stderrPath: string;
};

export type KernelRunLogStream = "stdout" | "stderr" | "protocol";

export type KernelRunLogLine = {
  lineNumber: number;
  text: string;
};

export type KernelRunLogChunk = {
  runId: string;
  stream: KernelRunLogStream;
  lines: KernelRunLogLine[];
  totalLines: number;
  nextAfterLine: number;
  hasMore: boolean;
};

export type KernelRunInput = {
  goal: string;
  configPath?: string;
  cwd: string;
  provider?: BrainProvider;
};

export type KernelRun = {
  id: string;
  status: KernelRunStatus;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  command: string;
  args: string[];
  input: KernelRunInput;
  artifacts?: KernelRunArtifacts;
};
