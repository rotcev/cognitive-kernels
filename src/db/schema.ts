import { pgTable, text, integer, real, jsonb, primaryKey } from "drizzle-orm/pg-core";

export const CURRENT_SCHEMA_VERSION = 1;

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

  return {
    fromVersion: normalizedFromVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    steps: [
      {
        version: 1,
        statement:
          "create table if not exists kernel_runs (id text primary key, status text not null, created_at text not null)",
      },
    ],
  };
}
