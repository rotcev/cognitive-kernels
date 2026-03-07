import type { KernelRun, RuntimeProtocolEvent } from "../types.js";
import type { OsSystemSnapshot } from "../os/types.js";
import type { DbConnection } from "./connection.js";
import { runs, runEvents } from "./schema.js";
import { eq, desc } from "drizzle-orm";

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
}

// ─── In-memory backend (for tests / no-DB mode) ─────────────────

class InMemoryStorageBackend implements StorageBackend {
  readonly kind = "memory" as const;
  private connected = false;
  private events = new Map<string, RuntimeProtocolEvent[]>();

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
  getRunState(): { snapshot: OsSystemSnapshot | null; source: "live" | "final" | "missing" } {
    return { snapshot: null, source: "missing" };
  }
  async appendEvents(runId: string, events: RuntimeProtocolEvent[]): Promise<void> {
    const existing = this.events.get(runId) ?? [];
    existing.push(...events);
    this.events.set(runId, existing);
  }
  async saveSnapshot(): Promise<void> {}
}

// ─── Neon/Postgres backend ──────────────────────────────────────

export class NeonStorageBackend implements StorageBackend {
  readonly kind = "neon" as const;
  private connected = false;
  private readonly db: DbConnection;
  private cachedRuns: KernelRun[] = [];
  private cachedEvents = new Map<string, RuntimeProtocolEvent[]>();
  private cachedSnapshots = new Map<string, { snapshot: OsSystemSnapshot; source: "live" | "final" }>();

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

    // Get current max seq
    const existing = await this.db.select({ seq: runEvents.seq })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.seq))
      .limit(1);

    let nextSeq = (existing[0]?.seq ?? 0) + 1;

    const rows = events.map(event => ({
      runId,
      seq: nextSeq++,
      type: event.action,
      payload: event as unknown as Record<string, unknown>,
      createdAt: event.timestamp,
    }));

    await this.db.insert(runEvents).values(rows);

    // Update event cache
    const cached = this.cachedEvents.get(runId) ?? [];
    cached.push(...events);
    this.cachedEvents.set(runId, cached);
  }

  async saveSnapshot(runId: string, snapshot: OsSystemSnapshot, source: "live" | "final"): Promise<void> {
    this.cachedSnapshots.set(runId, { snapshot, source });

    // Persist as a special event
    await this.appendEvents(runId, [{
      action: `snapshot:${source}`,
      status: "completed",
      timestamp: new Date().toISOString(),
      message: JSON.stringify(snapshot),
      eventSource: "os",
    }]);
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
