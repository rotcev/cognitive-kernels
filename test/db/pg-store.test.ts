import { describe, expect, test, vi } from "vitest";

const PG_STORE_MODULE_PATH = "../../src/db/pg-store.js";

interface RunRecord {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

interface EventRecord {
  runId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

interface EventInput {
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

interface HeuristicRecord {
  id: string;
  heuristic: string;
  confidence: number;
  context: string;
  scope: "global" | "local";
  reinforcementCount: number;
  createdAt: Date;
  updatedAt: Date;
}

async function importPgStoreContract() {
  try {
    return await import(PG_STORE_MODULE_PATH);
  } catch (error) {
    throw new Error(
      `Missing implementation for story4:pg-store. Expected module ${PG_STORE_MODULE_PATH}.`,
      { cause: error as Error },
    );
  }
}

function createInsertChain() {
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };

  return chain;
}

function createMockDb() {
  const insertChains: Array<ReturnType<typeof createInsertChain>> = [];

  const db = {
    insert: vi.fn(() => {
      const chain = createInsertChain();
      insertChains.push(chain);
      return chain;
    }),
    query: {
      runs: {
        findFirst: vi.fn(),
      },
      runEvents: {
        findMany: vi.fn(),
      },
      heuristics: {
        findFirst: vi.fn(),
      },
    },
    _insertChains: insertChains,
  };

  return db;
}

describe("story4:pg-store", () => {
  test("saveRun performs an upsert by run id", async () => {
    const pgStore = await importPgStoreContract();
    const db = createMockDb();
    const store = pgStore.createPgStore(db);

    const run: RunRecord = {
      id: "run-1",
      status: "running",
      createdAt: new Date("2026-03-01T12:00:00.000Z"),
      updatedAt: new Date("2026-03-01T12:00:05.000Z"),
      metadata: { objective: "story-4" },
    };

    await store.saveRun(run);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db._insertChains).toHaveLength(1);

    const [chain] = db._insertChains;
    expect(chain.values).toHaveBeenCalledTimes(1);
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1", status: "running" }));
    expect(chain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(chain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ status: "running" }) }));
  });

  test("getRun returns null when run id does not exist", async () => {
    const pgStore = await importPgStoreContract();
    const db = createMockDb();
    db.query.runs.findFirst.mockResolvedValue(undefined);
    const store = pgStore.createPgStore(db);

    const run = await store.getRun("missing-run");

    expect(db.query.runs.findFirst).toHaveBeenCalledTimes(1);
    expect(run).toBeNull();
  });

  test("appendEvents batches inserts and assigns contiguous sequence numbers", async () => {
    const pgStore = await importPgStoreContract();
    const db = createMockDb();
    db.query.runEvents.findMany.mockResolvedValue([{ seq: 7 }]);
    const store = pgStore.createPgStore(db);

    const events: EventInput[] = Array.from({ length: 1200 }, (_, i) => ({
      type: i % 2 === 0 ? "tick" : "log",
      payload: { index: i },
      createdAt: new Date(`2026-03-01T12:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`),
    }));

    await store.appendEvents("run-1", events);

    expect(db.insert).toHaveBeenCalled();
    expect(db._insertChains.length).toBeGreaterThan(1);

    const allRows = db._insertChains.flatMap((chain) => chain.values.mock.calls.map((call) => call[0])).flatMap((rows) =>
      Array.isArray(rows) ? rows : [rows],
    ) as EventRecord[];

    expect(allRows).toHaveLength(1200);
    expect(allRows[0]).toEqual(expect.objectContaining({ runId: "run-1", seq: 8 }));
    expect(allRows.at(-1)).toEqual(expect.objectContaining({ runId: "run-1", seq: 1207 }));
  });

  test("getEvents supports filtering by sequence, type, and limit", async () => {
    const pgStore = await importPgStoreContract();
    const db = createMockDb();
    db.query.runEvents.findMany.mockResolvedValue([
      {
        runId: "run-1",
        seq: 11,
        type: "tick",
        payload: { a: 1 },
        createdAt: "2026-03-01T12:00:11.000Z",
      },
      {
        runId: "run-1",
        seq: 12,
        type: "exit",
        payload: { code: 0 },
        createdAt: "2026-03-01T12:00:12.000Z",
      },
    ]);

    const store = pgStore.createPgStore(db);
    const events = await store.getEvents("run-1", { afterSeq: 10, types: ["tick", "exit"], limit: 2 });

    expect(db.query.runEvents.findMany).toHaveBeenCalledTimes(1);
    expect(db.query.runEvents.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2 }),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({ seq: 11, type: "tick" }));
    expect(events[1]).toEqual(expect.objectContaining({ seq: 12, type: "exit" }));
  });

  test("timestamps round-trip as Date objects", async () => {
    const pgStore = await importPgStoreContract();
    const db = createMockDb();
    db.query.runs.findFirst.mockResolvedValue({
      id: "run-1",
      status: "completed",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:05:00.000Z",
      metadata: { source: "test" },
    });
    const store = pgStore.createPgStore(db);

    const run = await store.getRun("run-1");

    expect(run).not.toBeNull();
    expect(run.createdAt).toBeInstanceOf(Date);
    expect(run.updatedAt).toBeInstanceOf(Date);
    expect(run.createdAt.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(run.updatedAt.toISOString()).toBe("2026-03-01T10:05:00.000Z");
  });

  test("upsertHeuristic inserts or updates by heuristic id", async () => {
    const pgStore = await importPgStoreContract();
    const db = createMockDb();
    const store = pgStore.createPgStore(db);

    const heuristic: HeuristicRecord = {
      id: "h-1",
      heuristic: "Prefer observer with shell tools after worker completion",
      confidence: 0.82,
      context: "coordination",
      scope: "global",
      reinforcementCount: 4,
      createdAt: new Date("2026-03-01T11:00:00.000Z"),
      updatedAt: new Date("2026-03-01T11:30:00.000Z"),
    };

    await store.upsertHeuristic(heuristic);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const [chain] = db._insertChains;
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ id: "h-1", confidence: 0.82 }));
    expect(chain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(chain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ confidence: 0.82 }) }));
  });
});
