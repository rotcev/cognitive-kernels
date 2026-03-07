import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  KernelRun,
  KernelRunInput,
  KernelRunLogChunk,
  KernelRunLogStream,
  RuntimeProtocolEvent,
} from "../types.js";
import { KernelRunManager, type KernelRunManagerOptions, type KernelRunState } from "../runs/run-manager.js";
import { createDbConnection } from "../db/connection.js";
import { NeonStorageBackend } from "../db/storage-backend.js";
import {
  buildRunDashboardView,
  buildRunTimelineView,
  buildRunTopologyView,
} from "../runs/monitoring.js";

const startRunInputSchema = z
  .object({
    goal: z.string().min(1),
    provider: z.enum(["claude", "codex"]).optional(),
    configPath: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

const runIdInputSchema = z
  .object({
    runId: z.string().min(1),
  })
  .strict();

const eventsInputSchema = z
  .object({
    runId: z.string().min(1),
    limit: z.number().int().positive().max(2000).optional(),
  })
  .strict();

const logsInputSchema = z
  .object({
    runId: z.string().min(1),
    stream: z.enum(["stdout", "stderr", "protocol"]),
    limit: z.number().int().positive().max(2000).optional(),
    afterLine: z.number().int().nonnegative().optional(),
  })
  .strict();

const timelineInputSchema = z
  .object({
    runId: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

type ControlPlaneRunManager = Pick<
  KernelRunManager,
  | "startRun"
  | "listRuns"
  | "getRun"
  | "getRunState"
  | "getRunEvents"
  | "getRunLog"
  | "pauseRun"
  | "resumeRun"
  | "cancelRun"
>;

export type CognitiveKernelsControlPlaneOptions = {
  runManager: ControlPlaneRunManager;
  defaultCwd: string;
  defaultConfigPath?: string;
};

export class CognitiveKernelsControlPlane {
  private readonly runManager: ControlPlaneRunManager;
  private readonly defaultCwd: string;
  private readonly defaultConfigPath?: string;

  constructor(options: CognitiveKernelsControlPlaneOptions) {
    this.runManager = options.runManager;
    this.defaultCwd = options.defaultCwd;
    this.defaultConfigPath = options.defaultConfigPath;
  }

  listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [
      {
        name: "start_run",
        description: "Start a new cognitive-kernels OS run.",
        inputSchema: {
          type: "object",
          properties: {
            goal: { type: "string" },
            provider: { type: "string", enum: ["claude", "codex"] },
            configPath: { type: "string" },
            cwd: { type: "string" },
          },
          required: ["goal"],
          additionalProperties: false,
        },
      },
      {
        name: "list_runs",
        description: "List tracked cognitive-kernels runs.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "get_run",
        description: "Get stored metadata for a run.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
      {
        name: "get_run_live_state",
        description: "Get the current live kernel state for a run. Active runs refuse stale archived state.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
      {
        name: "get_run_dashboard",
        description: "Render a text-first live dashboard with topology, pressure points, and recent structural events.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
      {
        name: "get_run_topology",
        description: "Render the live process topology as an ASCII tree plus dependency edges.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
      {
        name: "get_run_timeline",
        description: "Render a text timeline of recent structural protocol events.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            limit: { type: "number" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
      {
        name: "get_run_events",
        description: "Read raw protocol events for a run.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            limit: { type: "number" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
      {
        name: "get_run_logs",
        description: "Read stdout, stderr, or protocol log lines for a run with cursor-based polling.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            stream: { type: "string", enum: ["stdout", "stderr", "protocol"] },
            limit: { type: "number" },
            afterLine: { type: "number" },
          },
          required: ["runId", "stream"],
          additionalProperties: false,
        },
      },
      {
        name: "pause_run",
        description: "Pause a running run.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
      {
        name: "resume_run",
        description: "Resume a paused run.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
      {
        name: "cancel_run",
        description: "Cancel an active run.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
          required: ["runId"],
          additionalProperties: false,
        },
      },
    ];
  }

  listResources(): Array<{ uri: string; name: string; mimeType: string; description: string }> {
    const runs = this.runManager.listRuns();
    const resources: Array<{ uri: string; name: string; mimeType: string; description: string }> = [
      {
        uri: buildRunsIndexUri(),
        name: "runs-index",
        mimeType: "application/json",
        description: "Tracked cognitive-kernels runs.",
      },
    ];

    for (const run of runs) {
      resources.push(
        {
          uri: buildRunStatusUri(run.id),
          name: `run-${run.id}-status`,
          mimeType: "application/json",
          description: `Status for run ${run.id}`,
        },
        {
          uri: buildRunStateUri(run.id),
          name: `run-${run.id}-live-state`,
          mimeType: "application/json",
          description: `Live state for run ${run.id}`,
        },
        {
          uri: buildRunDashboardUri(run.id),
          name: `run-${run.id}-dashboard`,
          mimeType: "text/markdown",
          description: `Text dashboard for run ${run.id}`,
        },
        {
          uri: buildRunTopologyUri(run.id),
          name: `run-${run.id}-topology`,
          mimeType: "text/markdown",
          description: `Topology view for run ${run.id}`,
        },
        {
          uri: buildRunTimelineUri(run.id),
          name: `run-${run.id}-timeline`,
          mimeType: "text/markdown",
          description: `Timeline view for run ${run.id}`,
        },
        {
          uri: buildRunEventsUri(run.id),
          name: `run-${run.id}-events`,
          mimeType: "application/json",
          description: `Raw events for run ${run.id}`,
        },
        {
          uri: buildRunLogUri(run.id, "stdout"),
          name: `run-${run.id}-stdout`,
          mimeType: "application/json",
          description: `Stdout log chunk for run ${run.id}`,
        },
        {
          uri: buildRunLogUri(run.id, "stderr"),
          name: `run-${run.id}-stderr`,
          mimeType: "application/json",
          description: `Stderr log chunk for run ${run.id}`,
        },
        {
          uri: buildRunLogUri(run.id, "protocol"),
          name: `run-${run.id}-protocol`,
          mimeType: "application/json",
          description: `Protocol log chunk for run ${run.id}`,
        },
      );
    }

    return resources;
  }

  async readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
    const parsed = new URL(uri);

    if (isRunsIndexUri(parsed)) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ runs: this.runManager.listRuns() }, null, 2),
      };
    }

    const runId = extractRunId(parsed);

    if (parsed.pathname.endsWith("/status")) {
      const run = this.getRunOrThrow(runId);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(run, null, 2),
      };
    }

    if (parsed.pathname.endsWith("/state")) {
      const { state } = await this.getMonitoringState(runId);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(state, null, 2),
      };
    }

    if (parsed.pathname.endsWith("/dashboard")) {
      const { run, snapshot } = await this.requireFreshSnapshot(runId);
      const events = await this.runManager.getRunEvents(run.id, { limit: 200 });
      const dashboard = buildRunDashboardView(run, snapshot, events);
      return {
        uri,
        mimeType: "text/markdown",
        text: dashboard.text,
      };
    }

    if (parsed.pathname.endsWith("/topology")) {
      const { run, snapshot } = await this.requireFreshSnapshot(runId);
      const topology = buildRunTopologyView(run, snapshot);
      return {
        uri,
        mimeType: "text/markdown",
        text: topology.text,
      };
    }

    if (parsed.pathname.endsWith("/timeline")) {
      const run = this.getRunOrThrow(runId);
      const limit = parseOptionalPositiveInt(parsed.searchParams.get("limit")) ?? 50;
      const events = await this.runManager.getRunEvents(run.id, { limit });
      const timeline = buildRunTimelineView(run, events, limit);
      return {
        uri,
        mimeType: "text/markdown",
        text: timeline.text,
      };
    }

    if (parsed.pathname.endsWith("/events")) {
      const limit = parseOptionalPositiveInt(parsed.searchParams.get("limit"));
      const events = await this.runManager.getRunEvents(runId, { limit });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(events, null, 2),
      };
    }

    const stream = extractLogStream(parsed.pathname);
    if (stream) {
      const logs = await this.runManager.getRunLog(runId, {
        stream,
        limit: parseOptionalPositiveInt(parsed.searchParams.get("limit")),
        afterLine: parseOptionalNonNegativeInt(parsed.searchParams.get("afterLine")),
      });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(logs, null, 2),
      };
    }

    throw new Error(`Unsupported resource uri: ${uri}`);
  }

  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    switch (name) {
      case "start_run": {
        const input = startRunInputSchema.parse(args ?? {});
        const runInput: KernelRunInput = {
          goal: input.goal,
          provider: input.provider,
          cwd: input.cwd ?? this.defaultCwd,
          configPath: input.configPath ?? this.defaultConfigPath,
        };
        const run = await this.runManager.startRun(runInput);
        return successTextResult(formatRunText(run), { run });
      }

      case "list_runs": {
        const runs = this.runManager.listRuns();
        return successTextResult(formatRunList(runs), { runs });
      }

      case "get_run": {
        const input = runIdInputSchema.parse(args ?? {});
        const run = this.getRunOrThrow(input.runId);
        return successTextResult(formatRunText(run), { run });
      }

      case "get_run_live_state": {
        const input = runIdInputSchema.parse(args ?? {});
        const { run, state } = await this.getMonitoringState(input.runId);
        return successTextResult(JSON.stringify(state.snapshot, null, 2), {
          run,
          liveState: state.snapshot,
          source: state.source,
        });
      }

      case "get_run_dashboard": {
        const input = runIdInputSchema.parse(args ?? {});
        const { run, snapshot, source } = await this.requireFreshSnapshot(input.runId);
        const events = await this.runManager.getRunEvents(run.id, { limit: 200 });
        const dashboard = buildRunDashboardView(run, snapshot, events);
        return successTextResult(dashboard.text, {
          dashboard,
          source,
        });
      }

      case "get_run_topology": {
        const input = runIdInputSchema.parse(args ?? {});
        const { run, snapshot, source } = await this.requireFreshSnapshot(input.runId);
        const topology = buildRunTopologyView(run, snapshot);
        return successTextResult(topology.text, {
          topology,
          source,
        });
      }

      case "get_run_timeline": {
        const input = timelineInputSchema.parse(args ?? {});
        const run = this.getRunOrThrow(input.runId);
        const limit = input.limit ?? 50;
        const events = await this.runManager.getRunEvents(run.id, { limit });
        const timeline = buildRunTimelineView(run, events, limit);
        return successTextResult(timeline.text, { timeline });
      }

      case "get_run_events": {
        const input = eventsInputSchema.parse(args ?? {});
        const events = await this.runManager.getRunEvents(input.runId, { limit: input.limit });
        return successTextResult(JSON.stringify(events, null, 2), { events });
      }

      case "get_run_logs": {
        const input = logsInputSchema.parse(args ?? {});
        const logs = await this.runManager.getRunLog(input.runId, {
          stream: input.stream,
          limit: input.limit,
          afterLine: input.afterLine,
        });
        return successTextResult(JSON.stringify(logs, null, 2), { logs });
      }

      case "pause_run": {
        const input = runIdInputSchema.parse(args ?? {});
        const run = await this.runManager.pauseRun(input.runId);
        return successTextResult(formatRunText(run), { run });
      }

      case "resume_run": {
        const input = runIdInputSchema.parse(args ?? {});
        const run = await this.runManager.resumeRun(input.runId);
        return successTextResult(formatRunText(run), { run });
      }

      case "cancel_run": {
        const input = runIdInputSchema.parse(args ?? {});
        const run = await this.runManager.cancelRun(input.runId);
        return successTextResult(formatRunText(run), { run });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private getRunOrThrow(runId: string): KernelRun {
    const run = this.runManager.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  private async getMonitoringState(runId: string): Promise<{ run: KernelRun; state: KernelRunState }> {
    const run = this.getRunOrThrow(runId);
    const state = await this.runManager.getRunState(run.id);

    if (run.status === "running" || run.status === "paused") {
      if (state.source !== "live" || !state.snapshot) {
        throw new Error(`Live state unavailable for active run ${run.id}. Wait for the live state file to appear.`);
      }
    } else if (!state.snapshot) {
      throw new Error(`No state is available for run ${run.id}.`);
    }

    return { run, state };
  }

  private async requireFreshSnapshot(
    runId: string,
  ): Promise<{ run: KernelRun; snapshot: NonNullable<KernelRunState["snapshot"]>; source: KernelRunState["source"] }> {
    const { run, state } = await this.getMonitoringState(runId);
    if (!state.snapshot) {
      throw new Error(`No state is available for run ${run.id}.`);
    }
    return {
      run,
      snapshot: state.snapshot,
      source: state.source,
    };
  }
}

export type CreateCognitiveKernelsMcpServerOptions = {
  runManagerOptions?: KernelRunManagerOptions;
  defaultConfigPath?: string;
  defaultCwd?: string;
};

export async function createCognitiveKernelsMcpServer(
  options: CreateCognitiveKernelsMcpServerOptions = {},
): Promise<{
  server: Server;
  controlPlane: CognitiveKernelsControlPlane;
  runManager: KernelRunManager;
}> {
  let storageBackend: NeonStorageBackend | undefined;
  if (process.env.DATABASE_URL) {
    const db = createDbConnection(process.env.DATABASE_URL);
    storageBackend = new NeonStorageBackend(db);
    await storageBackend.connect();
    await storageBackend.loadRuns();
    process.stderr.write("MCP: Neon storage backend connected\n");
  }

  const runManager = new KernelRunManager({ ...options.runManagerOptions, storageBackend });
  await runManager.initialize();

  const controlPlane = new CognitiveKernelsControlPlane({
    runManager,
    defaultConfigPath: options.defaultConfigPath,
    defaultCwd: options.defaultCwd ?? process.cwd(),
  });

  const server = new Server(
    {
      name: "cognitive-kernels-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
        resources: {
          listChanged: true,
          subscribe: false,
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: controlPlane.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await controlPlane.callTool(request.params.name, request.params.arguments ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: controlPlane.listResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [await controlPlane.readResource(request.params.uri)],
  }));

  return {
    server,
    controlPlane,
    runManager,
  };
}

export async function startCognitiveKernelsMcpServer(
  options: CreateCognitiveKernelsMcpServerOptions = {},
): Promise<void> {
  const { server } = await createCognitiveKernelsMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function successTextResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function formatRunList(runs: KernelRun[]): string {
  if (runs.length === 0) {
    return "No tracked runs.";
  }

  return [
    "Tracked runs",
    ...runs.map((run) => `- ${shortId(run.id)} [${run.status}] pid=${run.pid ?? "n/a"} goal=${run.input.goal}`),
  ].join("\n");
}

function formatRunText(run: KernelRun): string {
  const lines = [
    `Run ${shortId(run.id)} [${run.status}]`,
    `Goal: ${run.input.goal}`,
    `CWD: ${run.input.cwd}`,
    `PID: ${run.pid ?? "n/a"}`,
    `Created: ${run.createdAt}`,
  ];

  if (run.startedAt) {
    lines.push(`Started: ${run.startedAt}`);
  }
  if (run.endedAt) {
    lines.push(`Ended: ${run.endedAt}`);
  }
  if (run.error) {
    lines.push(`Error: ${run.error}`);
  }

  return lines.join("\n");
}

function buildRunsIndexUri(): string {
  return "cognitive-kernels:///runs";
}

function buildRunStatusUri(runId: string): string {
  return `cognitive-kernels:///runs/${runId}/status`;
}

function buildRunStateUri(runId: string): string {
  return `cognitive-kernels:///runs/${runId}/state`;
}

function buildRunDashboardUri(runId: string): string {
  return `cognitive-kernels:///runs/${runId}/dashboard`;
}

function buildRunTopologyUri(runId: string): string {
  return `cognitive-kernels:///runs/${runId}/topology`;
}

function buildRunTimelineUri(runId: string): string {
  return `cognitive-kernels:///runs/${runId}/timeline`;
}

function buildRunEventsUri(runId: string): string {
  return `cognitive-kernels:///runs/${runId}/events`;
}

function buildRunLogUri(runId: string, stream: KernelRunLogStream): string {
  return `cognitive-kernels:///runs/${runId}/logs/${stream}`;
}

function isRunsIndexUri(parsed: URL): boolean {
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  return parsed.protocol === "cognitive-kernels:" && segments.length === 1 && segments[0] === "runs";
}

function extractRunId(parsed: URL): string {
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const runsIndex = segments.findIndex((segment) => segment === "runs");
  if (runsIndex === -1 || runsIndex + 1 >= segments.length) {
    throw new Error(`Invalid run resource uri: ${parsed.toString()}`);
  }
  return segments[runsIndex + 1] ?? "";
}

function extractLogStream(pathname: string): KernelRunLogStream | undefined {
  if (pathname.endsWith("/logs/stdout")) {
    return "stdout";
  }
  if (pathname.endsWith("/logs/stderr")) {
    return "stderr";
  }
  if (pathname.endsWith("/logs/protocol")) {
    return "protocol";
  }
  return undefined;
}

function parseOptionalPositiveInt(input: string | null): number | undefined {
  if (!input) {
    return undefined;
  }
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function parseOptionalNonNegativeInt(input: string | null): number | undefined {
  if (!input) {
    return undefined;
  }
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
