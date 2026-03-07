import { pgTable, text, integer, real, jsonb, primaryKey, serial } from "drizzle-orm/pg-core";

export const CURRENT_SCHEMA_VERSION = 2;

export type JsonObject = Record<string, unknown>;

// ─── Drizzle table definitions ───────────────────────────────────

export const runs = pgTable("kernel_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  metadata: jsonb("metadata").$type<JsonObject>(),
});

export const runEvents = pgTable("kernel_run_events", {
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull().$type<JsonObject>(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.seq] }),
]);

export const runSnapshots = pgTable("kernel_run_snapshots", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  tick: integer("tick").notNull(),
  source: text("source").notNull().$type<"live" | "final">(),
  data: jsonb("data").notNull().$type<JsonObject>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const heuristics = pgTable("kernel_heuristics", {
  id: text("id").primaryKey(),
  heuristic: text("heuristic").notNull(),
  confidence: real("confidence").notNull(),
  context: text("context").notNull(),
  scope: text("scope").notNull().$type<"global" | "local">(),
  reinforcementCount: integer("reinforcement_count").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ─── Row types (kept for backward compatibility with pg-store) ───

export interface RunRow {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

export interface RunEventRow {
  runId: string;
  seq: number;
  type: string;
  payload: JsonObject;
  createdAt: string;
}

export interface SnapshotRow {
  id: number;
  runId: string;
  tick: number;
  source: "live" | "final";
  data: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface HeuristicRow {
  id: string;
  heuristic: string;
  confidence: number;
  context: string;
  scope: "global" | "local";
  reinforcementCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Schema migration planner (legacy) ──────────────────────────

export interface SchemaPlanStep {
  statement: string;
  version: number;
}

export interface SchemaPlan {
  fromVersion: number;
  toVersion: number;
  steps: SchemaPlanStep[];
}

export function buildSchemaPlan(fromVersion = 0): SchemaPlan {
  const normalizedFromVersion = Number.isInteger(fromVersion) && fromVersion >= 0 ? fromVersion : 0;

  if (normalizedFromVersion >= CURRENT_SCHEMA_VERSION) {
    return {
      fromVersion: normalizedFromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      steps: [],
    };
  }

  const allSteps: SchemaPlanStep[] = [
    {
      version: 1,
      statement:
        "create table if not exists kernel_runs (id text primary key, status text not null, created_at text not null)",
    },
    {
      version: 2,
      statement: [
        "create table if not exists kernel_run_snapshots (",
        "  id serial primary key,",
        "  run_id text not null,",
        "  tick integer not null,",
        "  source text not null,",
        "  data jsonb not null,",
        "  created_at text not null,",
        "  updated_at text not null",
        ")",
      ].join("\n"),
    },
    {
      version: 2,
      statement:
        "create unique index if not exists idx_snapshots_run_source on kernel_run_snapshots (run_id, source)",
    },
    {
      version: 2,
      statement:
        "create index if not exists idx_events_run_seq on kernel_run_events (run_id, seq)",
    },
  ];

  return {
    fromVersion: normalizedFromVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    steps: allSteps.filter((s) => s.version > normalizedFromVersion),
  };
}
