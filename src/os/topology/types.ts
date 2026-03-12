/**
 * Declarative Topology Algebra — the 4 composable primitives.
 *
 * Metacog declares work graphs using these types.
 * A pure reconciler diffs current state against the desired topology.
 */

/** Backend configuration for a task. */
export type TaskBackend =
  | { kind: "llm" }
  | { kind: "system"; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "kernel"; goal: string; maxTicks?: number };

/** Gate condition — when should a gated subtree activate? */
export type GateCondition =
  | { type: "blackboard_key_exists"; key: string }
  | { type: "blackboard_key_match"; key: string; value: unknown }
  | { type: "blackboard_value_contains"; key: string; substring: string }
  | { type: "process_dead"; name: string }
  | { type: "all_of"; conditions: GateCondition[] }
  | { type: "any_of"; conditions: GateCondition[] };

/** The 4 topology primitives. */
export type TopologyExpr =
  | { type: "task"; name: string; objective: string;
      reads?: string[]; writes?: string[];
      model?: string; priority?: number; backend?: TaskBackend;
      capabilities?: { observationTools?: string[] };
      tags?: Record<string, string> }
  | { type: "seq"; children: TopologyExpr[] }
  | { type: "par"; children: TopologyExpr[] }
  | { type: "gate"; condition: GateCondition; child: TopologyExpr };

/** Flattened node — result of walking a TopologyExpr tree. */
export interface FlatNode {
  name: string;
  objective: string;
  reads?: string[];
  writes?: string[];
  model?: string;
  priority?: number;
  backend?: TaskBackend;
  gateCondition?: GateCondition;
  capabilities?: { observationTools?: string[] };
  tags?: Record<string, string>;
}

/** Flattened graph — nodes + dependency edges. */
export interface FlatGraph {
  nodes: Map<string, FlatNode>;
  edges: Array<{ from: string; to: string }>;
  entryNodes: string[];
  exitNodes: string[];
}

/** Validation error. */
export interface TopologyValidationError {
  path: string;
  message: string;
}

/** Validation result. */
export type TopologyValidationResult =
  | { valid: true }
  | { valid: false; errors: TopologyValidationError[] };

/** Optimization warning. */
export interface OptWarning {
  type: "width_limit" | "redundancy" | "deep_seq" | "dead_gate";
  message: string;
  path: string;
}

/** Metacog output — the 3 clean concerns. */
export interface MetacogOutput {
  topology: TopologyExpr | null;
  memory: MetacogMemoryCommand[];
  halt: { status: "achieved" | "unachievable" | "stalled"; summary: string } | null;
}

/** Memory commands — unchanged from current system. */
export type MetacogMemoryCommand =
  | { kind: "learn"; heuristic: string; confidence: number; context: string; scope?: string }
  | { kind: "define_blueprint"; blueprint: Record<string, unknown> }
  | { kind: "evolve_blueprint"; sourceBlueprintId: string; mutations: Record<string, unknown>; description: string }
  | { kind: "record_strategy"; strategy: Record<string, unknown> }
  | { kind: "bb_write"; key: string; value: unknown };
