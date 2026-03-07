import type { z } from "zod";
import type {
  KernelRun,
  KernelRunInput,
  RuntimeProtocolEvent,
} from "../types.js";
import type { KernelRunState } from "../runs/run-manager.js";
import type { RunTopologyView } from "../runs/monitoring.js";

export type ApiSchemaSet = {
  createRun: z.ZodType<{
    goal: string;
    provider?: "claude" | "codex";
    configPath?: string;
    cwd?: string;
  }>;
  runIdParams: z.ZodType<{
    runId: string;
  }>;
  eventsQuery: z.ZodType<{
    limit?: number;
  }>;
};

export type RunsApiDependencies = {
  startRun?(input: KernelRunInput): Promise<KernelRun>;
  listRuns?(): Promise<KernelRun[]> | KernelRun[];
  getRun?(runId: string): Promise<KernelRun | null | undefined> | KernelRun | null | undefined;
  getRunEvents?(runId: string, options: { limit?: number }): Promise<RuntimeProtocolEvent[]>;
  getRunTopology?(
    runId: string,
  ): Promise<RunTopologyResponse>;
  subscribeRunEvents?(
    runId: string,
    listener: (event: RuntimeProtocolEvent) => void,
    signal?: AbortSignal,
  ): () => void;
  cancelRun?(runId: string): Promise<KernelRun>;
};

export type RunsApiOptions = {
  dependencies?: RunsApiDependencies;
  defaultCwd?: string;
  defaultConfigPath?: string;
  defaultProvider?: "claude" | "codex";
  schemas?: Partial<ApiSchemaSet>;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type RunListResponse = {
  runs: KernelRun[];
};

export type RunResponse = {
  run: KernelRun;
};

export type RunTopologyResponse = {
  run: KernelRun;
  stateSource: KernelRunState["source"];
  topology: RunTopologyView;
};

export type RunEventsResponse = {
  runId: string;
  events: RuntimeProtocolEvent[];
};
