import type { StorageBackend } from "./storage-backend.js";
import {
  heuristics,
  runEvents,
  runs,
  type HeuristicRow,
  type JsonObject,
  type RunEventRow,
  type RunRow,
} from "./schema.js";

const EVENT_INSERT_BATCH_SIZE = 500;

type DateLike = string | Date;

export interface RunRecord {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: JsonObject;
}

export interface EventRecord {
  runId: string;
  seq: number;
  type: string;
  payload: JsonObject;
  createdAt: Date;
}

export interface EventInput {
  type: string;
  payload: JsonObject;
  createdAt: Date;
}

export interface EventQuery {
  afterSeq?: number;
  types?: string[];
  limit?: number;
}

export interface HeuristicRecord {
  id: string;
  heuristic: string;
  confidence: number;
  context: string;
  scope: "global" | "local";
  reinforcementCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface InsertBuilder {
  values(values: unknown): {
    onConflictDoUpdate(config: { target: unknown; set: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface PgStoreDb {
  insert(table: unknown): InsertBuilder;
  query: {
    runs: {
      findFirst(config: Record<string, unknown>): Promise<RunRow | undefined>;
    };
    runEvents: {
      findMany(config: Record<string, unknown>): Promise<Array<Pick<RunEventRow, "seq"> & Partial<RunEventRow>>>;
    };
    heuristics: {
      findFirst(config: Record<string, unknown>): Promise<HeuristicRow | undefined>;
    };
  };
}

export interface PgStore {
  saveRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  appendEvents(runId: string, events: EventInput[]): Promise<void>;
  getEvents(runId: string, query?: EventQuery): Promise<EventRecord[]>;
  upsertHeuristic(heuristic: HeuristicRecord): Promise<void>;
}

function ensureConnected(backend?: StorageBackend): void {
  if (!backend) return;
  if (!backend.isConnected()) {
    throw new Error("Storage backend is not connected");
  }
}

function toIso(value: DateLike): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDate(value: DateLike): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    metadata: row.metadata,
  };
}

function toEventRecord(row: RunEventRow): EventRecord {
  return {
    runId: row.runId,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    createdAt: toDate(row.createdAt),
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  if (values.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

export function createPgStore(db: PgStoreDb, options?: { backend?: StorageBackend }): PgStore {
  const backend = options?.backend;

  return {
    async saveRun(runRecord): Promise<void> {
      ensureConnected(backend);
      const row: RunRow = {
        id: runRecord.id,
        status: runRecord.status,
        createdAt: toIso(runRecord.createdAt),
        updatedAt: toIso(runRecord.updatedAt),
        metadata: runRecord.metadata,
      };

      await db.insert(runs).values(row).onConflictDoUpdate({
        target: runs,
        set: {
          status: row.status,
          updatedAt: row.updatedAt,
          metadata: row.metadata,
        },
      });
    },

    async getRun(id): Promise<RunRecord | null> {
      ensureConnected(backend);
      const row = await db.query.runs.findFirst({ where: { id } });
      if (!row) return null;
      return toRunRecord(row);
    },

    async appendEvents(runId, events): Promise<void> {
      ensureConnected(backend);
      if (events.length === 0) return;

      const lastRows = await db.query.runEvents.findMany({
        where: { runId },
        orderBy: [{ seq: "desc" }],
        limit: 1,
      });

      const lastSeq = lastRows[0]?.seq ?? 0;
      const rows: RunEventRow[] = events.map((event, index) => ({
        runId,
        seq: lastSeq + index + 1,
        type: event.type,
        payload: event.payload,
        createdAt: toIso(event.createdAt),
      }));

      for (const batch of chunk(rows, EVENT_INSERT_BATCH_SIZE)) {
        await db.insert(runEvents).values(batch).onConflictDoUpdate({
          target: runEvents,
          set: {},
        });
      }
    },

    async getEvents(runId, query): Promise<EventRecord[]> {
      ensureConnected(backend);
      const rows = await db.query.runEvents.findMany({
        where: {
          runId,
          afterSeq: query?.afterSeq,
          types: query?.types,
        },
        orderBy: [{ seq: "asc" }],
        limit: query?.limit,
      });

      return rows.map((row) => toEventRecord(row as RunEventRow));
    },

    async upsertHeuristic(heuristicRecord): Promise<void> {
      ensureConnected(backend);
      const row: HeuristicRow = {
        id: heuristicRecord.id,
        heuristic: heuristicRecord.heuristic,
        confidence: heuristicRecord.confidence,
        context: heuristicRecord.context,
        scope: heuristicRecord.scope,
        reinforcementCount: heuristicRecord.reinforcementCount,
        createdAt: toIso(heuristicRecord.createdAt),
        updatedAt: toIso(heuristicRecord.updatedAt),
      };

      await db.insert(heuristics).values(row).onConflictDoUpdate({
        target: heuristics,
        set: {
          heuristic: row.heuristic,
          confidence: row.confidence,
          context: row.context,
          scope: row.scope,
          reinforcementCount: row.reinforcementCount,
          updatedAt: row.updatedAt,
        },
      });
    },
  };
}
