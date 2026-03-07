import { Hono } from "hono";
import { ZodError, type ZodType } from "zod";
import { runsApiSchemas } from "./schemas.js";
import type {
  ApiErrorBody,
  ApiSchemaSet,
  RunEventsResponse,
  RunListResponse,
  RunResponse,
  RunTopologyResponse,
  RunsApiDependencies,
  RunsApiOptions,
} from "./types.js";

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createRunsApiApp(options: RunsApiOptions = {}): Hono {
  const app = new Hono();
  const dependencies = options.dependencies ?? {};
  const schemas = mergeSchemas(options.schemas);

  app.get("/runs", async (c) => {
    const runs = await callOptional(dependencies.listRuns);
    return c.json<RunListResponse>({ runs: runs ?? [] });
  });

  app.post("/runs", async (c) => {
    const body = await parseJson(c.req.raw, schemas.createRun);
    const run = await requireDependency(
      dependencies.startRun,
      "start_run_not_implemented",
      "Starting runs is not implemented in this Phase 1 scaffold.",
    )({
      goal: body.goal,
      provider: body.provider ?? options.defaultProvider,
      cwd: body.cwd ?? options.defaultCwd ?? process.cwd(),
      configPath: body.configPath ?? options.defaultConfigPath,
    });

    return c.json<RunResponse>({ run }, 201);
  });

  app.get("/runs/:runId", async (c) => {
    const { runId } = parseValue(c.req.param(), schemas.runIdParams);
    const run = await requireRun(dependencies, runId);
    return c.json<RunResponse>({ run });
  });

  app.get("/runs/:runId/events", async (c) => {
    const { runId } = parseValue(c.req.param(), schemas.runIdParams);
    const query = parseValue(c.req.query(), schemas.eventsQuery);
    const accept = c.req.header("accept") ?? "";

    if (accept.includes("text/event-stream")) {
      const events = await requireDependency(
        dependencies.getRunEvents,
        "get_run_events_not_implemented",
        "Run events are not implemented in this Phase 1 scaffold.",
      )(runId, { limit: query.limit });
      return createSseResponse(runId, events, dependencies.subscribeRunEvents);
    }

    const events = await requireDependency(
      dependencies.getRunEvents,
      "get_run_events_not_implemented",
      "Run events are not implemented in this Phase 1 scaffold.",
    )(runId, { limit: query.limit });

    return c.json<RunEventsResponse>({ runId, events });
  });

  app.get("/runs/:runId/topology", async (c) => {
    const { runId } = parseValue(c.req.param(), schemas.runIdParams);
    const topology = await requireDependency(
      dependencies.getRunTopology,
      "get_run_topology_not_implemented",
      "Run topology is not implemented in this Phase 1 scaffold.",
    )(runId);

    return c.json<RunTopologyResponse>(topology);
  });

  app.delete("/runs/:runId", async (c) => {
    const { runId } = parseValue(c.req.param(), schemas.runIdParams);
    const run = await requireDependency(
      dependencies.cancelRun,
      "cancel_run_not_implemented",
      "Canceling runs is not implemented in this Phase 1 scaffold.",
    )(runId);

    return c.json<RunResponse>({ run }, 202);
  });

  app.onError((error, c) => {
    if (error instanceof ZodError) {
      return c.json<ApiErrorBody>(createValidationError(error.flatten()), 422);
    }

    const mapped = mapError(error);
    return c.json<ApiErrorBody>({ error: mapped.body }, mapped.status);
  });

  return app;
}

function mergeSchemas(schemas?: Partial<ApiSchemaSet>): ApiSchemaSet {
  return {
    ...runsApiSchemas,
    ...schemas,
  };
}

async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json request body.");
  }

  try {
    return schema.parse(await request.json());
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed.", {
        formErrors: ["Malformed JSON request body."],
        fieldErrors: {},
      });
    }
    throw error;
  }
}

function parseValue<T>(value: unknown, schema: ZodType<T>): T {
  return schema.parse(value);
}

async function requireRun(dependencies: RunsApiDependencies, runId: string) {
  const getRun = requireDependency(
    dependencies.getRun,
    "get_run_not_implemented",
    "Run lookup is not implemented in this Phase 1 scaffold.",
  );
  const run = await getRun(runId);
  if (!run) {
    throw new HttpError(404, "run_not_found", `Run not found: ${runId}`);
  }
  return run;
}

function requireDependency<T extends (...args: any[]) => any>(
  value: T | undefined,
  code: string,
  message: string,
): T {
  if (!value) {
    throw new HttpError(501, code, message);
  }
  return value;
}

async function callOptional<T extends (...args: any[]) => any>(
  value: T | undefined,
  ...args: Parameters<T>
): Promise<Awaited<ReturnType<T>> | undefined> {
  if (!value) {
    return undefined;
  }

  return value(...args);
}

function mapError(error: unknown): { status: 404 | 409 | 415 | 422 | 500 | 501; body: ApiErrorBody["error"] } {
  if (error instanceof HttpError) {
    return {
      status: toSupportedStatus(error.status),
      body: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  const candidate = error as Error & { code?: string; statusCode?: number; details?: unknown };
  const status = toSupportedStatus(candidate.statusCode);
  if (candidate instanceof Error && candidate.code) {
    return {
      status,
      body: {
        code: normalizeErrorCode(candidate.code),
        message: candidate.message,
        details: candidate.details,
      },
    };
  }

  return {
    status: 500,
    body: {
      code: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error",
    },
  };
}

function toSupportedStatus(status?: number): 404 | 409 | 415 | 422 | 500 | 501 {
  switch (status) {
    case 404:
    case 409:
    case 415:
    case 422:
    case 500:
    case 501:
      return status;
    default:
      return 500;
  }
}

function normalizeErrorCode(code: string): string {
  return code.trim().toLowerCase();
}

function createValidationError(details: unknown): ApiErrorBody {
  return {
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed.",
      details,
    },
  };
}

function createSseResponse(
  runId: string,
  snapshotEvents: RunEventsResponse["events"],
  subscribeRunEvents?: RunsApiDependencies["subscribeRunEvents"],
): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let closeAfterSnapshot = !subscribeRunEvents;
  const buffer: string[] = [serializeSseEvent("snapshot", { runId, events: snapshotEvents })];

  const flush = () => {
    if (closed || !controllerRef || buffer.length === 0) {
      return;
    }
    controllerRef.enqueue(encoder.encode(buffer.join("")));
    buffer.length = 0;
    if (closeAfterSnapshot) {
      controllerRef.close();
      controllerRef = null;
      cleanup();
    }
  };

  const scheduleFlush = (delayMs = 0) => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, delayMs);
  };

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    unsubscribe();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (subscribeRunEvents) {
        unsubscribe = subscribeRunEvents(runId, (event) => {
          buffer.push(serializeSseEvent("runtime", event));
          scheduleFlush();
        });
        closeAfterSnapshot = false;
      }
      scheduleFlush(15);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function serializeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
