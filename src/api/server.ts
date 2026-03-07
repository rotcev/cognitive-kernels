import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { buildRunTopologyView } from "../runs/monitoring.js";
import type { KernelRun, RuntimeProtocolEvent } from "../types.js";
import type { KernelRunManager, KernelRunState } from "../runs/run-manager.js";
import { createRunsApiApp } from "./app.js";

type RuntimeAdapter = {
  subscribeRunEvents(
    runId: string,
    listener: (event: RuntimeProtocolEvent) => void,
    signal?: AbortSignal,
  ): () => void;
};

export type CreateRunsApiServerOptions = {
  runManager: Pick<
    KernelRunManager,
    "startRun" | "listRuns" | "getRun" | "getRunEvents" | "getRunState" | "cancelRun"
  >;
  runtimeAdapter?: RuntimeAdapter;
  defaultCwd: string;
  defaultConfigPath?: string;
  host?: string;
  port?: number;
};

export type RunsApiServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

export async function createRunsApiServer(options: CreateRunsApiServerOptions): Promise<RunsApiServer> {
  const app = createRunsApiApp({
    defaultCwd: options.defaultCwd,
    defaultConfigPath: options.defaultConfigPath,
    dependencies: {
      startRun: (input) => options.runManager.startRun(input),
      listRuns: () => options.runManager.listRuns(),
      getRun: (runId) => options.runManager.getRun(runId),
      getRunEvents: (runId, query) => options.runManager.getRunEvents(runId, query),
      subscribeRunEvents: options.runtimeAdapter?.subscribeRunEvents.bind(options.runtimeAdapter),
      getRunTopology: async (runId) => {
        const run = options.runManager.getRun(runId);
        if (!run) {
          const error = new Error(`Run not found: ${runId}`) as Error & { code: string; statusCode: number };
          error.code = "RUN_NOT_FOUND";
          error.statusCode = 404;
          throw error;
        }

        const state = await options.runManager.getRunState(run.id);
        const snapshot = requireTopologySnapshot(run, state);
        return {
          run,
          stateSource: state.source,
          topology: buildRunTopologyView(run, snapshot),
        };
      },
      cancelRun: (runId) => options.runManager.cancelRun(runId),
    },
  });

  const server = createServer((req, res) => {
    // CORS headers for cross-origin UI access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    void handleNodeRequest(app.fetch.bind(app), req, res);
  });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine API server address.");
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    close: () => closeServer(server),
  };
}

function requireTopologySnapshot(
  run: KernelRun,
  state: KernelRunState,
): NonNullable<KernelRunState["snapshot"]> {
  if ((run.status === "running" || run.status === "paused") && (state.source !== "live" || !state.snapshot)) {
    const error = new Error(`Live state unavailable for active run ${run.id}.`) as Error & {
      code: string;
      statusCode: number;
    };
    error.code = "STATE_UNAVAILABLE";
    error.statusCode = 409;
    throw error;
  }

  if (!state.snapshot) {
    const error = new Error(`No state is available for run ${run.id}.`) as Error & {
      code: string;
      statusCode: number;
    };
    error.code = "STATE_UNAVAILABLE";
    error.statusCode = 409;
    throw error;
  }

  return state.snapshot;
}

async function handleNodeRequest(
  fetchHandler: (request: Request) => Response | Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
  const url = new URL(req.url ?? "/", origin);
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: req.method ?? "GET",
    headers: new Headers(toHeaderPairs(req.headers)),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req) as ReadableStream,
    duplex: req.method === "GET" || req.method === "HEAD" ? undefined : "half",
  };
  const request = new Request(url, requestInit);

  const response = await fetchHandler(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const body = Readable.fromWeb(response.body as any);
  body.on("error", (error) => {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.destroy(error);
  });
  body.pipe(res);
}

function toHeaderPairs(headers: IncomingMessage["headers"]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      pairs.push([key, value]);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        pairs.push([key, item]);
      }
    }
  }
  return pairs;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
