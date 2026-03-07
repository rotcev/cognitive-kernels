import type { KernelRun, RuntimeProtocolEvent } from "../types.js";
import type { OsSystemSnapshot } from "../os/types.js";
import type { DbConnection } from "./connection.js";
import { runs, runEvents, runSnapshots } from "./schema.js";
import { eq, desc, gt, and, sql } from "drizzle-orm";

export interface StorageBackend {
  readonly kind: "memory" | "neon";
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  saveRun(run: KernelRun): Promise<void>;
  listRuns(): KernelRun[];
  getRun(id: string): KernelRun | undefined;
  getRunEvents(id: string, options?: { limit?: number }): RuntimeProtocolEvent[];
  getRunState(id: string): { snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" };
  appendEvents(runId: string, events: RuntimeProtocolEvent[]): Promise<void>;
  saveSnapshot(runId: string, snapshot: OsSystemSnapshot, source: "live" | "final"): Promise<void>;

  // Incremental polling methods (for cross-process Lens)
  fetchEventsSince(runId: string, afterSeq: number): Promise<{ events: RuntimeProtocolEvent[]; lastSeq: number }>;
  fetchLatestSnapshot(runId: string): Promise<{ snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" }>;
}

// ─── In-memory backend (for tests / no-DB mode) ─────────────────

class InMemoryStorageBackend implements StorageBackend {
  readonly kind = "memory" as const;
  private connected = false;
  private events = new Map<string, RuntimeProtocolEvent[]>();
  private snapshots = new Map<string, { snapshot: OsSystemSnapshot; source: "live" | "final" }>();

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async saveRun(): Promise<void> {}
  listRuns(): KernelRun[] { return []; }
  getRun(): KernelRun | undefined { return undefined; }
  getRunEvents(id: string): RuntimeProtocolEvent[] {
    return this.events.get(id) ?? [];
  }
  getRunState(id: string): { snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" } {
    const cached = this.snapshots.get(id);
    return cached ?? { snapshot: null, source: "missing" };
  }
  async appendEvents(runId: string, events: RuntimeProtocolEvent[]): Promise<void> {
    const existing = this.events.get(runId) ?? [];
    existing.push(...events);
    this.events.set(runId, existing);
  }
  async saveSnapshot(runId: string, snapshot: OsSystemSnapshot, source: "live" | "final"): Promise<void> {
    this.snapshots.set(runId, { snapshot, source });
  }

  async fetchEventsSince(runId: string, afterSeq: number): Promise<{ events: RuntimeProtocolEvent[]; lastSeq: number }> {
    const all = this.events.get(runId) ?? [];
    const newEvents = all.slice(afterSeq);
    return { events: newEvents, lastSeq: all.length };
  }

  async fetchLatestSnapshot(runId: string): Promise<{ snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" }> {
    return this.getRunState(runId);
  }
}

// ─── Neon/Postgres backend ──────────────────────────────────────

export class NeonStorageBackend implements StorageBackend {
  readonly kind = "neon" as const;
  private connected = false;
  private readonly db: DbConnection;
  private cachedRuns: KernelRun[] = [];
  private cachedEvents = new Map<string, RuntimeProtocolEvent[]>();
  private cachedSnapshots = new Map<string, { snapshot: OsSystemSnapshot; source: "live" | "final" }>();
  private seqCounters = new Map<string, number>(); // runId → last seq written

  constructor(db: DbConnection) {
    this.db = db;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    // Verify connectivity with a simple query
    await this.db.select().from(runs).limit(1);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async saveRun(run: KernelRun): Promise<void> {
    const metadata = {
      pid: run.pid,
      command: run.command,
      args: run.args,
      input: run.input,
      artifacts: run.artifacts,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
    };

    await this.db.insert(runs).values({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt ?? run.createdAt,
      metadata,
    }).onConflictDoUpdate({
      target: runs.id,
      set: {
        status: run.status,
        updatedAt: run.updatedAt ?? new Date().toISOString(),
        metadata,
      },
    });

    // Update cache
    const idx = this.cachedRuns.findIndex(r => r.id === run.id);
    if (idx >= 0) {
      this.cachedRuns[idx] = run;
    } else {
      this.cachedRuns.push(run);
    }
  }

  listRuns(): KernelRun[] {
    return [...this.cachedRuns];
  }

  getRun(id: string): KernelRun | undefined {
    return this.cachedRuns.find(r => r.id === id);
  }

  getRunEvents(id: string): RuntimeProtocolEvent[] {
    return this.cachedEvents.get(id) ?? [];
  }

  getRunState(id: string): { snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" } {
    const cached = this.cachedSnapshots.get(id);
    return cached ?? { snapshot: null, source: "missing" };
  }

  async appendEvents(runId: string, events: RuntimeProtocolEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Seq counter tracked in memory — eliminates the SELECT max(seq) round-trip.
    // Single INSERT per batch = 1 HTTP request to Neon.
    let nextSeq = (this.seqCounters.get(runId) ?? 0) + 1;

    const rows = events.map(event => ({
      runId,
      seq: nextSeq++,
      type: event.action,
      payload: event as unknown as Record<string, unknown>,
      createdAt: event.timestamp,
    }));

    await this.db.insert(runEvents).values(rows);
    this.seqCounters.set(runId, nextSeq - 1);

    // Update event cache
    const cached = this.cachedEvents.get(runId) ?? [];
    cached.push(...events);
    this.cachedEvents.set(runId, cached);
  }

  async saveSnapshot(runId: string, snapshot: OsSystemSnapshot, source: "live" | "final"): Promise<void> {
    this.cachedSnapshots.set(runId, { snapshot, source });

    const now = new Date().toISOString();

    // UPSERT: one row per (runId, source). Live snapshots are overwritten each tick
    // instead of accumulating rows. Final snapshot written once at run end.
    // = 1 HTTP request to Neon per call, no row bloat.
    await this.db.insert(runSnapshots).values({
      runId,
      tick: snapshot.tickCount,
      source,
      data: snapshot as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [runSnapshots.runId, runSnapshots.source],
      set: {
        tick: snapshot.tickCount,
        data: snapshot as unknown as Record<string, unknown>,
        updatedAt: now,
      },
    });
  }

  /**
   * Fetch events created after a given seq number.
   * Used by LensStoragePoller for efficient incremental polling.
   * Single query, indexed on (run_id, seq).
   */
  async fetchEventsSince(runId: string, afterSeq: number): Promise<{ events: RuntimeProtocolEvent[]; lastSeq: number }> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(runEvents.seq);

    if (rows.length === 0) {
      return { events: [], lastSeq: afterSeq };
    }

    const events = rows.map(r => r.payload as unknown as RuntimeProtocolEvent);
    const lastSeq = rows[rows.length - 1].seq;

    // Update local caches
    const cached = this.cachedEvents.get(runId) ?? [];
    cached.push(...events);
    this.cachedEvents.set(runId, cached);

    // Keep seq counter in sync (highest seq seen)
    const currentMax = this.seqCounters.get(runId) ?? 0;
    if (lastSeq > currentMax) this.seqCounters.set(runId, lastSeq);

    return { events, lastSeq };
  }

  /**
   * Fetch the latest snapshot for a run directly from DB.
   * Used by LensStoragePoller for cross-process observation.
   * Prefers "final" over "live". At most 2 rows per run (one live, one final).
   * Single query, indexed on (run_id, source).
   */
  async fetchLatestSnapshot(runId: string): Promise<{ snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" }> {
    // At most 2 rows per run (one live, one final) thanks to UPSERT.
    const rows = await this.db
      .select()
      .from(runSnapshots)
      .where(eq(runSnapshots.runId, runId));

    if (rows.length === 0) {
      return { snapshot: null, source: "missing" };
    }

    // Prefer final over live
    const row = rows.find(r => r.source === "final") ?? rows[0];
    const snapshot = row.data as unknown as OsSystemSnapshot;
    const source = row.source as "live" | "final";

    // Update cache
    this.cachedSnapshots.set(runId, { snapshot, source });

    return { snapshot, source };
  }

  async loadRuns(): Promise<void> {
    const rows = await this.db.select().from(runs).orderBy(desc(runs.createdAt));
    this.cachedRuns = rows.map(row => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        status: row.status as KernelRun["status"],
        pid: (meta.pid as number) ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        command: (meta.command as string) ?? "",
        args: (meta.args as string[]) ?? [],
        input: meta.input as KernelRun["input"],
        artifacts: meta.artifacts as KernelRun["artifacts"],
        startedAt: meta.startedAt as string | undefined,
        endedAt: meta.endedAt as string | undefined,
        exitCode: meta.exitCode as number | undefined,
      } as KernelRun;
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────

export function createStorageBackend(): StorageBackend {
  return new InMemoryStorageBackend();
}
