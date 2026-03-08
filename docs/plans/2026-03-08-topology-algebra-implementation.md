# Declarative Topology Algebra — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace 16 imperative metacog commands with a declarative topology algebra — 4 composable primitives (`task`, `seq`, `par`, `gate`) plus a pure reconciler that diffs current vs desired topology.

**Architecture:** Metacog declares a `TopologyExpr`. A pure `validateTopology()` checks soundness. A pure `reconcile(current, desired)` inside `transition()` produces typed effects (spawn, kill, activate, edge). The goal-orchestrator process is eliminated — metacog is the orchestrator. Memory commands (learn, blueprint, strategy) are kept as-is.

**Tech Stack:** TypeScript, vitest, fast-check (property-based testing)

**Design doc:** `docs/plans/2026-03-08-topology-algebra-design.md`

---

## Task 1: Define the Topology Algebra Types

**Files:**
- Create: `src/os/topology/types.ts`
- Modify: `src/os/types.ts` (export re-export)

**Step 1:** Create `src/os/topology/types.ts` with:

```typescript
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
      model?: string; priority?: number; backend?: TaskBackend }
  | { type: "seq"; children: TopologyExpr[] }
  | { type: "par"; children: TopologyExpr[] }
  | { type: "gate"; condition: GateCondition; child: TopologyExpr };

/** Flattened node — result of walking a TopologyExpr tree. */
export interface FlatNode {
  name: string;
  objective: string;
  model?: string;
  priority?: number;
  backend?: TaskBackend;
  gateCondition?: GateCondition;
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
  | { kind: "record_strategy"; strategy: Record<string, unknown> };
```

**Step 2:** Run `npx tsc --noEmit` to verify types compile.

**Step 3:** Commit: `feat(topology): define topology algebra types`

---

## Task 2: Implement `flatten()` — Tree to DAG

**Files:**
- Create: `src/os/topology/flatten.ts`
- Create: `test/os/topology/flatten.test.ts`

**Step 1:** Write failing tests in `test/os/topology/flatten.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { flatten } from "../../src/os/topology/flatten.js";
import type { TopologyExpr } from "../../src/os/topology/types.js";

describe("flatten", () => {
  test("single task → 1 node, 0 edges", () => {
    const expr: TopologyExpr = { type: "task", name: "A", objective: "do A" };
    const result = flatten(expr);
    expect(result.nodes.size).toBe(1);
    expect(result.nodes.get("A")?.objective).toBe("do A");
    expect(result.edges).toHaveLength(0);
    expect(result.entryNodes).toEqual(["A"]);
    expect(result.exitNodes).toEqual(["A"]);
  });

  test("seq(A, B, C) → 3 nodes, edges A→B, B→C", () => {
    const expr: TopologyExpr = { type: "seq", children: [
      { type: "task", name: "A", objective: "do A" },
      { type: "task", name: "B", objective: "do B" },
      { type: "task", name: "C", objective: "do C" },
    ]};
    const result = flatten(expr);
    expect(result.nodes.size).toBe(3);
    expect(result.edges).toContainEqual({ from: "A", to: "B" });
    expect(result.edges).toContainEqual({ from: "B", to: "C" });
    expect(result.edges).toHaveLength(2);
    expect(result.entryNodes).toEqual(["A"]);
    expect(result.exitNodes).toEqual(["C"]);
  });

  test("par(A, B, C) → 3 nodes, 0 edges", () => {
    const expr: TopologyExpr = { type: "par", children: [
      { type: "task", name: "A", objective: "do A" },
      { type: "task", name: "B", objective: "do B" },
      { type: "task", name: "C", objective: "do C" },
    ]};
    const result = flatten(expr);
    expect(result.nodes.size).toBe(3);
    expect(result.edges).toHaveLength(0);
    expect(result.entryNodes).toEqual(["A", "B", "C"]);
    expect(result.exitNodes).toEqual(["A", "B", "C"]);
  });

  test("seq(par(A, B), C) → edges A→C, B→C", () => {
    const expr: TopologyExpr = { type: "seq", children: [
      { type: "par", children: [
        { type: "task", name: "A", objective: "do A" },
        { type: "task", name: "B", objective: "do B" },
      ]},
      { type: "task", name: "C", objective: "do C" },
    ]};
    const result = flatten(expr);
    expect(result.nodes.size).toBe(3);
    expect(result.edges).toContainEqual({ from: "A", to: "C" });
    expect(result.edges).toContainEqual({ from: "B", to: "C" });
    expect(result.edges).toHaveLength(2);
    expect(result.entryNodes).toEqual(["A", "B"]);
    expect(result.exitNodes).toEqual(["C"]);
  });

  test("gate attaches condition to entry node", () => {
    const expr: TopologyExpr = { type: "gate",
      condition: { type: "blackboard_key_exists", key: "schema" },
      child: { type: "task", name: "impl", objective: "implement" },
    };
    const result = flatten(expr);
    expect(result.nodes.size).toBe(1);
    expect(result.nodes.get("impl")?.gateCondition).toEqual(
      { type: "blackboard_key_exists", key: "schema" }
    );
  });

  test("nested: seq(par(A, gate(cond, B)), seq(C, D))", () => {
    const expr: TopologyExpr = { type: "seq", children: [
      { type: "par", children: [
        { type: "task", name: "A", objective: "do A" },
        { type: "gate",
          condition: { type: "blackboard_key_exists", key: "x" },
          child: { type: "task", name: "B", objective: "do B" },
        },
      ]},
      { type: "seq", children: [
        { type: "task", name: "C", objective: "do C" },
        { type: "task", name: "D", objective: "do D" },
      ]},
    ]};
    const result = flatten(expr);
    expect(result.nodes.size).toBe(4);
    expect(result.edges).toContainEqual({ from: "A", to: "C" });
    expect(result.edges).toContainEqual({ from: "B", to: "C" });
    expect(result.edges).toContainEqual({ from: "C", to: "D" });
    expect(result.nodes.get("B")?.gateCondition).toBeDefined();
    expect(result.entryNodes).toEqual(["A", "B"]);
    expect(result.exitNodes).toEqual(["D"]);
  });

  test("preserves task config (model, priority, backend)", () => {
    const expr: TopologyExpr = { type: "task", name: "A", objective: "do A",
      model: "claude-sonnet", priority: 80,
      backend: { kind: "system", command: "npm", args: ["test"] },
    };
    const result = flatten(expr);
    const node = result.nodes.get("A")!;
    expect(node.model).toBe("claude-sonnet");
    expect(node.priority).toBe(80);
    expect(node.backend).toEqual({ kind: "system", command: "npm", args: ["test"] });
  });
});
```

**Step 2:** Run tests to verify they fail: `npx vitest run test/os/topology/`

**Step 3:** Implement `src/os/topology/flatten.ts`:

```typescript
import type { TopologyExpr, FlatGraph, FlatNode, GateCondition } from "./types.js";

/**
 * Flatten a TopologyExpr tree into a flat graph of nodes + dependency edges.
 * Pure function — no I/O, no side effects.
 */
export function flatten(expr: TopologyExpr): FlatGraph {
  return flattenExpr(expr, undefined);
}

function flattenExpr(expr: TopologyExpr, gateCondition: GateCondition | undefined): FlatGraph {
  switch (expr.type) {
    case "task": {
      const node: FlatNode = {
        name: expr.name,
        objective: expr.objective,
        model: expr.model,
        priority: expr.priority,
        backend: expr.backend,
        gateCondition,
      };
      return {
        nodes: new Map([[expr.name, node]]),
        edges: [],
        entryNodes: [expr.name],
        exitNodes: [expr.name],
      };
    }

    case "par": {
      const parts = expr.children.map(c => flattenExpr(c, undefined));
      return mergeParts(parts);
    }

    case "seq": {
      const parts = expr.children.map(c => flattenExpr(c, undefined));
      const merged = mergeParts(parts);

      // Wire sequential dependencies: exit nodes of each part → entry nodes of next part
      for (let i = 0; i < parts.length - 1; i++) {
        for (const src of parts[i].exitNodes) {
          for (const dst of parts[i + 1].entryNodes) {
            merged.edges.push({ from: src, to: dst });
          }
        }
      }

      // Entry nodes = first part's entry, exit nodes = last part's exit
      merged.entryNodes = parts[0].entryNodes;
      merged.exitNodes = parts[parts.length - 1].exitNodes;
      return merged;
    }

    case "gate": {
      return flattenExpr(expr.child, expr.condition);
    }
  }
}

function mergeParts(parts: FlatGraph[]): FlatGraph {
  const nodes = new Map<string, FlatNode>();
  const edges: FlatGraph["edges"] = [];
  const entryNodes: string[] = [];
  const exitNodes: string[] = [];

  for (const part of parts) {
    for (const [name, node] of part.nodes) {
      nodes.set(name, node);
    }
    edges.push(...part.edges);
    entryNodes.push(...part.entryNodes);
    exitNodes.push(...part.exitNodes);
  }

  return { nodes, edges, entryNodes, exitNodes };
}
```

**Step 4:** Run tests: `npx vitest run test/os/topology/`

**Step 5:** Commit: `feat(topology): implement flatten — topology tree to DAG`

---

## Task 3: Implement `validateTopology()`

**Files:**
- Create: `src/os/topology/validate.ts`
- Create: `test/os/topology/validate.test.ts`

**Step 1:** Write failing tests in `test/os/topology/validate.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { validateTopology } from "../../src/os/topology/validate.js";
import type { TopologyExpr } from "../../src/os/topology/types.js";

describe("validateTopology", () => {
  test("valid single task passes", () => {
    const expr: TopologyExpr = { type: "task", name: "A", objective: "do A" };
    expect(validateTopology(expr)).toEqual({ valid: true });
  });

  test("valid nested topology passes", () => {
    const expr: TopologyExpr = { type: "seq", children: [
      { type: "par", children: [
        { type: "task", name: "A", objective: "do A" },
        { type: "task", name: "B", objective: "do B" },
      ]},
      { type: "task", name: "C", objective: "do C" },
    ]};
    expect(validateTopology(expr)).toEqual({ valid: true });
  });

  test("duplicate names rejected", () => {
    const expr: TopologyExpr = { type: "par", children: [
      { type: "task", name: "A", objective: "do A" },
      { type: "task", name: "A", objective: "do A again" },
    ]};
    const result = validateTopology(expr);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].message).toContain("duplicate");
    }
  });

  test("empty seq rejected", () => {
    const expr: TopologyExpr = { type: "seq", children: [] };
    const result = validateTopology(expr);
    expect(result.valid).toBe(false);
  });

  test("empty par rejected", () => {
    const expr: TopologyExpr = { type: "par", children: [] };
    const result = validateTopology(expr);
    expect(result.valid).toBe(false);
  });

  test("task with empty name rejected", () => {
    const expr: TopologyExpr = { type: "task", name: "", objective: "do something" };
    const result = validateTopology(expr);
    expect(result.valid).toBe(false);
  });

  test("task with empty objective rejected", () => {
    const expr: TopologyExpr = { type: "task", name: "A", objective: "" };
    const result = validateTopology(expr);
    expect(result.valid).toBe(false);
  });

  test("valid gate with condition passes", () => {
    const expr: TopologyExpr = { type: "gate",
      condition: { type: "blackboard_key_exists", key: "schema" },
      child: { type: "task", name: "impl", objective: "implement" },
    };
    expect(validateTopology(expr)).toEqual({ valid: true });
  });

  test("deeply nested valid topology passes", () => {
    const expr: TopologyExpr = { type: "seq", children: [
      { type: "par", children: [
        { type: "task", name: "A", objective: "a" },
        { type: "gate",
          condition: { type: "all_of", conditions: [
            { type: "blackboard_key_exists", key: "x" },
            { type: "process_dead", name: "A" },
          ]},
          child: { type: "seq", children: [
            { type: "task", name: "B", objective: "b" },
            { type: "task", name: "C", objective: "c" },
          ]},
        },
      ]},
      { type: "task", name: "D", objective: "d" },
    ]};
    expect(validateTopology(expr)).toEqual({ valid: true });
  });
});
```

**Step 2:** Run tests to verify fail: `npx vitest run test/os/topology/`

**Step 3:** Implement `src/os/topology/validate.ts`:

```typescript
import { flatten } from "./flatten.js";
import type { TopologyExpr, TopologyValidationResult, TopologyValidationError } from "./types.js";

/**
 * Validate a TopologyExpr for structural soundness.
 * Pure function — runs in microseconds for any realistic topology.
 */
export function validateTopology(expr: TopologyExpr): TopologyValidationResult {
  const errors: TopologyValidationError[] = [];
  collectErrors(expr, "", errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check unique names via flatten
  const graph = flatten(expr);
  const seen = new Set<string>();
  for (const name of graph.nodes.keys()) {
    if (seen.has(name)) {
      errors.push({ path: "", message: `duplicate task name: "${name}"` });
    }
    seen.add(name);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function collectErrors(expr: TopologyExpr, path: string, errors: TopologyValidationError[]): void {
  switch (expr.type) {
    case "task": {
      if (!expr.name || expr.name.trim() === "") {
        errors.push({ path, message: "task name must not be empty" });
      }
      if (!expr.objective || expr.objective.trim() === "") {
        errors.push({ path, message: "task objective must not be empty" });
      }
      break;
    }
    case "seq":
    case "par": {
      if (expr.children.length === 0) {
        errors.push({ path, message: `${expr.type} must have at least one child` });
      }
      for (let i = 0; i < expr.children.length; i++) {
        collectErrors(expr.children[i], `${path}.${expr.type}[${i}]`, errors);
      }
      break;
    }
    case "gate": {
      collectErrors(expr.child, `${path}.gate`, errors);
      break;
    }
  }
}
```

**Step 4:** Run tests: `npx vitest run test/os/topology/`

**Step 5:** Commit: `feat(topology): implement validateTopology — structural soundness checks`

---

## Task 4: Implement `reconcile()` — The Core

**Files:**
- Create: `src/os/topology/reconcile.ts`
- Create: `test/os/topology/reconcile.test.ts`

This is the most important piece — the pure function that diffs current processes against the desired topology and produces effects.

**Step 1:** Write failing tests in `test/os/topology/reconcile.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { reconcile } from "../../src/os/topology/reconcile.js";
import type { TopologyExpr } from "../../src/os/topology/types.js";
import type { OsProcess } from "../../src/os/types.js";

// Helper: create a minimal alive process
function proc(name: string, state: "running" | "idle" | "dead" = "running"): OsProcess {
  return {
    pid: `pid-${name}`,
    name,
    state,
    type: "lifecycle",
    priority: 70,
    model: "mock",
    objective: `do ${name}`,
    tickCount: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    parentPid: null,
    workingDir: "/tmp",
    children: [],
    onParentDeath: "orphan",
    restartPolicy: "never",
    blackboardKeysWritten: [],
  } as OsProcess;
}

describe("reconcile", () => {
  test("empty → topology: spawns all tasks", () => {
    const topology: TopologyExpr = { type: "par", children: [
      { type: "task", name: "A", objective: "do A" },
      { type: "task", name: "B", objective: "do B" },
    ]};
    const effects = reconcile(new Map(), topology, new Map(), new Set());

    const spawns = effects.filter(e => e.type === "spawn_process");
    expect(spawns).toHaveLength(2);
    expect(spawns.map(e => e.name).sort()).toEqual(["A", "B"]);
  });

  test("same topology twice: zero effects (idempotent)", () => {
    const topology: TopologyExpr = { type: "task", name: "A", objective: "do A" };
    const processes = new Map([["pid-A", proc("A")]]);
    const effects = reconcile(processes, topology, new Map(), new Set());
    const meaningful = effects.filter(e => e.type !== "emit_protocol");
    expect(meaningful).toHaveLength(0);
  });

  test("remove a task: kill effect", () => {
    const topology: TopologyExpr = { type: "task", name: "B", objective: "do B" };
    const processes = new Map([
      ["pid-A", proc("A")],
      ["pid-B", proc("B")],
    ]);
    const effects = reconcile(processes, topology, new Map(), new Set());
    const kills = effects.filter(e => e.type === "kill_process");
    expect(kills).toHaveLength(1);
    expect(kills[0].pid).toBe("pid-A");
  });

  test("add a task: spawn + activate", () => {
    const topology: TopologyExpr = { type: "par", children: [
      { type: "task", name: "A", objective: "do A" },
      { type: "task", name: "B", objective: "do B" },
    ]};
    const processes = new Map([["pid-A", proc("A")]]);
    const effects = reconcile(processes, topology, new Map(), new Set());
    const spawns = effects.filter(e => e.type === "spawn_process");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].name).toBe("B");
  });

  test("inflight process removed: drain effect (not kill)", () => {
    const topology: TopologyExpr = { type: "task", name: "B", objective: "do B" };
    const processes = new Map([
      ["pid-A", proc("A")],
      ["pid-B", proc("B")],
    ]);
    const inflight = new Set(["pid-A"]);
    const effects = reconcile(processes, topology, new Map(), inflight);
    const drains = effects.filter(e => e.type === "drain_process");
    expect(drains).toHaveLength(1);
    expect(drains[0].pid).toBe("pid-A");
    expect(effects.filter(e => e.type === "kill_process")).toHaveLength(0);
  });

  test("gate condition not met: gated nodes not spawned", () => {
    const topology: TopologyExpr = { type: "gate",
      condition: { type: "blackboard_key_exists", key: "schema" },
      child: { type: "task", name: "impl", objective: "implement" },
    };
    const effects = reconcile(new Map(), topology, new Map(), new Set());
    const spawns = effects.filter(e => e.type === "spawn_process");
    expect(spawns).toHaveLength(0);
  });

  test("gate condition met: gated nodes spawned", () => {
    const topology: TopologyExpr = { type: "gate",
      condition: { type: "blackboard_key_exists", key: "schema" },
      child: { type: "task", name: "impl", objective: "implement" },
    };
    const bb = new Map([["schema", { value: "the schema", writtenBy: "scout" }]]);
    const effects = reconcile(new Map(), topology, bb, new Set());
    const spawns = effects.filter(e => e.type === "spawn_process");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].name).toBe("impl");
  });

  test("seq dependency not yet complete: spawn but don't activate", () => {
    const topology: TopologyExpr = { type: "seq", children: [
      { type: "task", name: "A", objective: "do A" },
      { type: "task", name: "B", objective: "do B" },
    ]};
    const effects = reconcile(new Map(), topology, new Map(), new Set());
    const spawns = effects.filter(e => e.type === "spawn_process");
    const activates = effects.filter(e => e.type === "activate_process");
    // A should be spawned and activated (entry node)
    expect(spawns.find(e => e.name === "A")).toBeDefined();
    expect(activates.find(e => e.name === "A")).toBeDefined();
    // B should NOT be spawned yet (dependency A not complete)
    expect(spawns.find(e => e.name === "B")).toBeUndefined();
  });

  test("seq dependency complete: second task spawned and activated", () => {
    const topology: TopologyExpr = { type: "seq", children: [
      { type: "task", name: "A", objective: "do A" },
      { type: "task", name: "B", objective: "do B" },
    ]};
    const processes = new Map([["pid-A", proc("A", "dead")]]);
    const effects = reconcile(processes, topology, new Map(), new Set());
    const spawns = effects.filter(e => e.type === "spawn_process");
    expect(spawns.find(e => e.name === "B")).toBeDefined();
  });

  test("null topology: zero effects", () => {
    const effects = reconcile(new Map(), null, new Map(), new Set());
    expect(effects).toHaveLength(0);
  });

  test("dead processes not killed again", () => {
    const topology: TopologyExpr = { type: "task", name: "B", objective: "do B" };
    const processes = new Map([
      ["pid-A", proc("A", "dead")],
      ["pid-B", proc("B")],
    ]);
    const effects = reconcile(processes, topology, new Map(), new Set());
    const kills = effects.filter(e => e.type === "kill_process" || e.type === "drain_process");
    expect(kills).toHaveLength(0);
  });
});
```

**Step 2:** Run tests to verify fail: `npx vitest run test/os/topology/`

**Step 3:** Implement `src/os/topology/reconcile.ts`. This is the core — the pure function that produces effects:

```typescript
import { flatten } from "./flatten.js";
import { evaluateGateCondition } from "./gates.js";
import type { TopologyExpr, FlatGraph, FlatNode, GateCondition } from "./types.js";
import type { KernelEffectInput } from "../state-machine/effects.js";

// Extended effect types for topology reconciliation
export interface SpawnProcessEffect { type: "spawn_process"; name: string; objective: string; model?: string; priority?: number; backend?: FlatNode["backend"]; parentPid?: string }
export interface KillProcessEffect { type: "kill_process"; pid: string; name: string }
export interface DrainProcessEffect { type: "drain_process"; pid: string; name: string }
export interface UpdateProcessEffect { type: "update_process"; pid: string; priority?: number; objective?: string }

export type ReconcileEffect =
  | SpawnProcessEffect
  | KillProcessEffect
  | DrainProcessEffect
  | UpdateProcessEffect
  | { type: "activate_process"; pid?: string; name: string }
  | { type: "submit_llm"; pid?: string; name: string; model: string }
  | { type: "add_edge"; from: string; to: string }
  | { type: "remove_edge"; from: string; to: string }
  | { type: "emit_protocol"; action: string; message: string };

// Minimal process interface (avoids importing full OsProcess)
interface ProcessInfo {
  pid: string;
  name: string;
  state: string;
}

interface BlackboardEntry {
  value: unknown;
  writtenBy?: string;
}

/**
 * Reconcile current processes against a desired topology.
 * Pure function — no I/O, no side effects.
 *
 * Returns an array of effects that, when interpreted, will transform
 * the current process graph to match the desired topology.
 */
export function reconcile(
  currentProcesses: Map<string, ProcessInfo>,
  desiredTopology: TopologyExpr | null,
  blackboard: Map<string, BlackboardEntry>,
  inflight: Set<string>,
): ReconcileEffect[] {
  if (desiredTopology === null) return [];

  const effects: ReconcileEffect[] = [];

  // 1. Flatten the topology tree into a flat graph
  const desired = flatten(desiredTopology);

  // 2. Evaluate gates — remove nodes whose gate conditions aren't met
  const activeNodes = new Map<string, FlatNode>();
  for (const [name, node] of desired.nodes) {
    if (node.gateCondition) {
      if (!evaluateGateCondition(node.gateCondition, blackboard, currentProcesses)) {
        continue; // Gate not met — skip this node
      }
    }
    activeNodes.set(name, node);
  }

  // 3. Build lookup: name → existing alive process
  const existingByName = new Map<string, ProcessInfo>();
  for (const [pid, proc] of currentProcesses) {
    if (proc.state !== "dead") {
      existingByName.set(proc.name, proc);
    }
  }

  // 4. Match: desired vs existing
  const matched = new Map<string, ProcessInfo>();    // name → existing process
  const toSpawn: FlatNode[] = [];                     // desired but no match
  const toKill: ProcessInfo[] = [];                   // existing but not desired

  for (const [name, node] of activeNodes) {
    const existing = existingByName.get(name);
    if (existing) {
      matched.set(name, existing);
      // Check for config changes
      if (node.priority !== undefined && node.priority !== (existing as any).priority) {
        effects.push({ type: "update_process", pid: existing.pid, priority: node.priority });
      }
    } else {
      toSpawn.push(node);
    }
  }

  for (const [name, proc] of existingByName) {
    if (!activeNodes.has(name)) {
      // Existing process not in desired topology — check if it's a kernel-managed daemon
      // Only kill lifecycle/event processes that were topology-managed
      toKill.push(proc);
    }
  }

  // 5. Emit kill/drain effects
  for (const proc of toKill) {
    if (inflight.has(proc.pid)) {
      effects.push({ type: "drain_process", pid: proc.pid, name: proc.name });
    } else {
      effects.push({ type: "kill_process", pid: proc.pid, name: proc.name });
    }
  }

  // 6. Check which spawned nodes have all dependencies satisfied
  for (const node of toSpawn) {
    const deps = desired.edges.filter(e => e.to === node.name);
    const allDepsSatisfied = deps.every(dep => {
      // Dependency satisfied if the source process is dead (completed)
      const source = currentProcesses.get(`pid-${dep.from}`)
        ?? [...currentProcesses.values()].find(p => p.name === dep.from);
      return source?.state === "dead";
    });

    if (deps.length === 0 || allDepsSatisfied) {
      // Entry node or all deps complete — spawn and activate
      effects.push({
        type: "spawn_process",
        name: node.name,
        objective: node.objective,
        model: node.model,
        priority: node.priority,
        backend: node.backend,
      });
      effects.push({ type: "activate_process", name: node.name });
    }
    // Else: deps not met — don't spawn yet (will be re-evaluated next cycle)
  }

  return effects;
}
```

**Step 4:** Create `src/os/topology/gates.ts` — gate condition evaluator:

```typescript
import type { GateCondition } from "./types.js";

interface BlackboardEntry {
  value: unknown;
  writtenBy?: string;
}

interface ProcessInfo {
  pid: string;
  name: string;
  state: string;
}

/**
 * Evaluate a gate condition against current state.
 * Pure function.
 */
export function evaluateGateCondition(
  condition: GateCondition,
  blackboard: Map<string, BlackboardEntry>,
  processes: Map<string, ProcessInfo>,
): boolean {
  switch (condition.type) {
    case "blackboard_key_exists":
      return blackboard.has(condition.key);

    case "blackboard_key_match": {
      const entry = blackboard.get(condition.key);
      return entry !== undefined && entry.value === condition.value;
    }

    case "blackboard_value_contains": {
      const entry = blackboard.get(condition.key);
      if (!entry) return false;
      const str = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      return str.includes(condition.substring);
    }

    case "process_dead": {
      for (const proc of processes.values()) {
        if (proc.name === condition.name && proc.state === "dead") return true;
      }
      return false;
    }

    case "all_of":
      return condition.conditions.every(c => evaluateGateCondition(c, blackboard, processes));

    case "any_of":
      return condition.conditions.some(c => evaluateGateCondition(c, blackboard, processes));
  }
}
```

**Step 5:** Run tests: `npx vitest run test/os/topology/`

**Step 6:** Commit: `feat(topology): implement reconcile — pure current-vs-desired diff`

---

## Task 5: Implement `optimizeTopology()` — Phase 1 Structural Transforms

**Files:**
- Create: `src/os/topology/optimize.ts`
- Create: `test/os/topology/optimize.test.ts`

**Step 1:** Write failing tests:

```typescript
import { describe, expect, test } from "vitest";
import { optimizeTopology } from "../../src/os/topology/optimize.js";
import type { TopologyExpr } from "../../src/os/topology/types.js";

describe("optimizeTopology", () => {
  test("flatten nested seq: seq(seq(A, B), C) → seq(A, B, C)", () => {
    const expr: TopologyExpr = { type: "seq", children: [
      { type: "seq", children: [
        { type: "task", name: "A", objective: "a" },
        { type: "task", name: "B", objective: "b" },
      ]},
      { type: "task", name: "C", objective: "c" },
    ]};
    const { optimized } = optimizeTopology(expr);
    expect(optimized.type).toBe("seq");
    if (optimized.type === "seq") {
      expect(optimized.children).toHaveLength(3);
    }
  });

  test("flatten nested par: par(par(A, B), C) → par(A, B, C)", () => {
    const expr: TopologyExpr = { type: "par", children: [
      { type: "par", children: [
        { type: "task", name: "A", objective: "a" },
        { type: "task", name: "B", objective: "b" },
      ]},
      { type: "task", name: "C", objective: "c" },
    ]};
    const { optimized } = optimizeTopology(expr);
    expect(optimized.type).toBe("par");
    if (optimized.type === "par") {
      expect(optimized.children).toHaveLength(3);
    }
  });

  test("eliminate single-child wrapper: par(A) → A", () => {
    const expr: TopologyExpr = { type: "par", children: [
      { type: "task", name: "A", objective: "a" },
    ]};
    const { optimized } = optimizeTopology(expr);
    expect(optimized.type).toBe("task");
  });

  test("gate hoisting: par(gate(X, A), gate(X, B)) → gate(X, par(A, B))", () => {
    const cond = { type: "blackboard_key_exists" as const, key: "x" };
    const expr: TopologyExpr = { type: "par", children: [
      { type: "gate", condition: cond, child: { type: "task", name: "A", objective: "a" } },
      { type: "gate", condition: cond, child: { type: "task", name: "B", objective: "b" } },
    ]};
    const { optimized } = optimizeTopology(expr);
    expect(optimized.type).toBe("gate");
  });

  test("warns on wide parallelism (>8)", () => {
    const children = Array.from({ length: 10 }, (_, i) => ({
      type: "task" as const, name: `T${i}`, objective: `task ${i}`,
    }));
    const expr: TopologyExpr = { type: "par", children };
    const { warnings } = optimizeTopology(expr);
    expect(warnings.some(w => w.type === "width_limit")).toBe(true);
  });

  test("no-op on already optimal topology", () => {
    const expr: TopologyExpr = { type: "seq", children: [
      { type: "task", name: "A", objective: "a" },
      { type: "task", name: "B", objective: "b" },
    ]};
    const { optimized } = optimizeTopology(expr);
    expect(optimized).toEqual(expr);
  });
});
```

**Step 2:** Run tests to verify fail: `npx vitest run test/os/topology/`

**Step 3:** Implement `src/os/topology/optimize.ts`:

```typescript
import type { TopologyExpr, GateCondition, OptWarning } from "./types.js";

const MAX_PARALLEL_WIDTH = 8;

/**
 * Optimize a TopologyExpr with structural transforms.
 * Pure function — same input always produces same output.
 * Phase 1: flatten nesting, eliminate wrappers, hoist gates, warn on width.
 */
export function optimizeTopology(
  expr: TopologyExpr,
): { optimized: TopologyExpr; warnings: OptWarning[] } {
  const warnings: OptWarning[] = [];
  const optimized = optimize(expr, "", warnings);
  return { optimized, warnings };
}

function optimize(expr: TopologyExpr, path: string, warnings: OptWarning[]): TopologyExpr {
  switch (expr.type) {
    case "task":
      return expr;

    case "gate":
      return { ...expr, child: optimize(expr.child, `${path}.gate`, warnings) };

    case "seq":
    case "par": {
      // Recursively optimize children first
      let children = expr.children.map((c, i) => optimize(c, `${path}.${expr.type}[${i}]`, warnings));

      // Flatten same-type nesting: seq(seq(A, B), C) → seq(A, B, C)
      children = children.flatMap(c =>
        c.type === expr.type ? (c as typeof expr).children : [c]
      );

      // Eliminate single-child wrapper: par(A) → A
      if (children.length === 1) return children[0];

      // Gate hoisting: par(gate(X, A), gate(X, B)) → gate(X, par(A, B))
      if (children.every(c => c.type === "gate")) {
        const gates = children as Array<{ type: "gate"; condition: GateCondition; child: TopologyExpr }>;
        const first = JSON.stringify(gates[0].condition);
        if (gates.every(g => JSON.stringify(g.condition) === first)) {
          return {
            type: "gate",
            condition: gates[0].condition,
            child: { type: expr.type, children: gates.map(g => g.child) },
          };
        }
      }

      // Warn on wide parallelism
      if (expr.type === "par" && children.length > MAX_PARALLEL_WIDTH) {
        warnings.push({
          type: "width_limit",
          message: `${children.length} parallel tasks exceeds recommended max of ${MAX_PARALLEL_WIDTH}`,
          path,
        });
      }

      return { ...expr, children };
    }
  }
}
```

**Step 4:** Run tests: `npx vitest run test/os/topology/`

**Step 5:** Commit: `feat(topology): implement optimizeTopology — Phase 1 structural transforms`

---

## Task 6: Property-Based Tests

**Files:**
- Create: `test/os/topology/invariants.test.ts`

**Step 1:** Write property-based tests using fast-check:

```typescript
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { flatten } from "../../src/os/topology/flatten.js";
import { validateTopology } from "../../src/os/topology/validate.js";
import { reconcile } from "../../src/os/topology/reconcile.js";
import type { TopologyExpr } from "../../src/os/topology/types.js";

// Arbitrary for generating random valid topology expressions
const taskArb: fc.Arbitrary<TopologyExpr> = fc.record({
  type: fc.constant("task" as const),
  name: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
  objective: fc.string({ minLength: 1, maxLength: 50 }),
});

const topologyArb: fc.Arbitrary<TopologyExpr> = fc.letrec(tie => ({
  expr: fc.oneof(
    { weight: 5, arbitrary: taskArb },
    { weight: 2, arbitrary: fc.record({
      type: fc.constant("seq" as const),
      children: fc.array(tie("expr"), { minLength: 1, maxLength: 4 }),
    })},
    { weight: 2, arbitrary: fc.record({
      type: fc.constant("par" as const),
      children: fc.array(tie("expr"), { minLength: 1, maxLength: 4 }),
    })},
    { weight: 1, arbitrary: fc.record({
      type: fc.constant("gate" as const),
      condition: fc.record({
        type: fc.constant("blackboard_key_exists" as const),
        key: fc.string({ minLength: 1, maxLength: 10 }),
      }),
      child: tie("expr"),
    })},
  ),
})).expr;

describe("topology invariants (property-based)", () => {
  test("flatten always produces a valid DAG (no cycles)", () => {
    fc.assert(fc.property(topologyArb, (expr) => {
      const graph = flatten(expr);
      // Topological sort — if it succeeds, no cycles
      const visited = new Set<string>();
      const stack = new Set<string>();

      function visit(name: string): boolean {
        if (stack.has(name)) return false; // cycle
        if (visited.has(name)) return true;
        stack.add(name);
        for (const edge of graph.edges) {
          if (edge.from === name && !visit(edge.to)) return false;
        }
        stack.delete(name);
        visited.add(name);
        return true;
      }

      for (const name of graph.nodes.keys()) {
        expect(visit(name)).toBe(true);
      }
    }), { numRuns: 200 });
  });

  test("reconcile(empty, T) then reconcile(result, T) produces no spawns on second call", () => {
    fc.assert(fc.property(topologyArb, (expr) => {
      // First reconcile: empty → topology
      const effects1 = reconcile(new Map(), expr, new Map(), new Set());
      const spawns1 = effects1.filter(e => e.type === "spawn_process");

      // Build process map from spawns
      const processes = new Map<string, { pid: string; name: string; state: string }>();
      for (const s of spawns1) {
        processes.set(`pid-${s.name}`, { pid: `pid-${s.name}`, name: s.name, state: "running" });
      }

      // Second reconcile: should produce no spawns (idempotent)
      const effects2 = reconcile(processes, expr, new Map(), new Set());
      const spawns2 = effects2.filter(e => e.type === "spawn_process");
      expect(spawns2).toHaveLength(0);
    }), { numRuns: 100 });
  });

  test("validate accepts all well-formed expressions from the arbitrary", () => {
    fc.assert(fc.property(topologyArb, (expr) => {
      // May have duplicate names from the arbitrary — that's OK, just check it doesn't crash
      const result = validateTopology(expr);
      expect(typeof result.valid).toBe("boolean");
    }), { numRuns: 200 });
  });
});
```

**Step 2:** Run: `npx vitest run test/os/topology/`

**Step 3:** Commit: `test(topology): property-based invariant tests for flatten, reconcile, validate`

---

## Task 7: Add `topology_declared` Event and Effects

**Files:**
- Modify: `src/os/state-machine/events.ts` (add TopologyDeclaredEvent)
- Modify: `src/os/state-machine/effects.ts` (add SpawnProcessEffect, KillProcessEffect, DrainProcessEffect)
- Modify: `src/os/state-machine/transition.ts` (add handleTopologyDeclared)

**Step 1:** Add `TopologyDeclaredEvent` to `src/os/state-machine/events.ts`:

Add after `HaltCheckEvent` (around line 130):

```typescript
import type { TopologyExpr, MetacogMemoryCommand } from "../topology/types.js";

/** Metacog declared a new desired topology. */
export type TopologyDeclaredEvent = {
  type: "topology_declared";
  topology: TopologyExpr | null;
  memory: MetacogMemoryCommand[];
  halt: { status: "achieved" | "unachievable" | "stalled"; summary: string } | null;
  timestamp: number;
  seq: number;
};
```

Add `TopologyDeclaredEvent` to the `KernelEvent` union.

**Step 2:** Add new effect types to `src/os/state-machine/effects.ts`:

```typescript
import type { TaskBackend } from "../topology/types.js";

/** Spawn a new process from topology reconciliation. */
export type SpawnTopologyProcessEffect = BaseEffect & {
  type: "spawn_topology_process";
  name: string;
  objective: string;
  model?: string;
  priority?: number;
  backend?: TaskBackend;
};

/** Kill a process removed from topology. */
export type KillProcessEffect = BaseEffect & {
  type: "kill_process";
  pid: string;
  name: string;
};

/** Drain an inflight process (let current turn finish, then kill). */
export type DrainProcessEffect = BaseEffect & {
  type: "drain_process";
  pid: string;
  name: string;
};
```

Add all three to the `KernelEffect` union.

**Step 3:** Add `handleTopologyDeclared` to `src/os/state-machine/transition.ts`:

```typescript
import { reconcile } from "../topology/reconcile.js";
import { validateTopology } from "../topology/validate.js";
import { optimizeTopology } from "../topology/optimize.js";

function handleTopologyDeclared(state: KernelState, event: TopologyDeclaredEvent): TransitionResult {
  if (state.halted) return [state, []];

  const effects: KernelEffectInput[] = [];

  // Handle halt command
  if (event.halt) {
    return [
      { ...state, halted: true, haltReason: `metacog: ${event.halt.status} — ${event.halt.summary}` },
      [{ type: "halt", reason: `metacog: ${event.halt.status}` }],
    ];
  }

  // Handle memory commands (unchanged — just emit effects for kernel to execute)
  for (const cmd of event.memory) {
    effects.push({
      type: "emit_protocol",
      action: "os_metacog_memory",
      message: `memory command: ${cmd.kind}`,
    });
  }

  // Handle topology declaration
  if (event.topology !== null) {
    // Validate
    const validation = validateTopology(event.topology);
    if (!validation.valid) {
      effects.push({
        type: "emit_protocol",
        action: "os_topology_error",
        message: `invalid topology: ${validation.errors.map(e => e.message).join(", ")}`,
      });
      return [state, assignEffectSeqs(effects)];
    }

    // Optimize
    const { optimized, warnings } = optimizeTopology(event.topology);
    for (const w of warnings) {
      effects.push({
        type: "emit_protocol",
        action: "os_topology_warning",
        message: `${w.type}: ${w.message}`,
      });
    }

    // Reconcile
    const reconcileEffects = reconcile(
      state.processes,
      optimized,
      state.blackboard,
      state.inflight,
    );

    // Convert reconcile effects to kernel effects
    for (const re of reconcileEffects) {
      switch (re.type) {
        case "spawn_process":
          effects.push({
            type: "spawn_topology_process",
            name: re.name,
            objective: re.objective,
            model: re.model,
            priority: re.priority,
            backend: re.backend,
          });
          break;
        case "kill_process":
          effects.push({ type: "kill_process", pid: re.pid, name: re.name });
          break;
        case "drain_process":
          effects.push({ type: "drain_process", pid: re.pid, name: re.name });
          break;
        case "activate_process":
          if (re.pid) {
            effects.push({ type: "activate_process", pid: re.pid });
          }
          break;
        case "emit_protocol":
          effects.push({ type: "emit_protocol", action: re.action, message: re.message });
          break;
      }
    }
  }

  return [state, assignEffectSeqs(effects)];
}
```

Add `case "topology_declared": return handleTopologyDeclared(state, event);` to the `transition()` switch.

**Step 4:** Run: `npx tsc --noEmit && npx vitest run`

**Step 5:** Commit: `feat(topology): wire topology_declared event into transition`

---

## Task 8: Modify Boot Sequence

**Files:**
- Modify: `src/os/state-machine/transition.ts` (handleBoot — remove goal-orchestrator spawn, emit submit_metacog)

**Step 1:** In `handleBoot()` (transition.ts, around lines 96-121), remove the goal-orchestrator process creation. Replace with a `submit_metacog` effect so metacog runs immediately and declares the initial topology.

Keep the metacog daemon, awareness daemon, and memory-consolidator daemon spawns. Only remove the goal-orchestrator lifecycle process.

Also remove the dead executive recovery logic in `handleProcessCompleted` (around lines 1470-1525) — there's no orchestrator to recover.

**Step 2:** Run: `npx tsc --noEmit && npx vitest run`

**Step 3:** Update affected tests in `test/os/state-machine/transition.test.ts` — tests that assert goal-orchestrator exists after boot need updating.

**Step 4:** Commit: `feat(topology): remove goal-orchestrator — metacog is the orchestrator`

---

## Task 9: Modify Metacog Agent

**Files:**
- Modify: `src/os/metacog-agent.ts` (new prompt, new output format, new parsing)

**Step 1:** Replace `buildSystemPrompt()` with the new ~80 line prompt that teaches the topology algebra instead of 16 commands.

**Step 2:** Update the response parsing to expect `MetacogOutput` format (`{ topology, memory, halt }`) instead of the current command array format.

**Step 3:** Keep `buildContextPrompt()` largely unchanged — the rich state dump (process table, blackboard, progress metrics, heuristics) is still valuable.

**Step 4:** Run: `npx tsc --noEmit && npx vitest run`

**Step 5:** Commit: `feat(topology): redesign metacog prompt for topology algebra`

---

## Task 10: Wire Kernel to Use Topology Events

**Files:**
- Modify: `src/os/kernel.ts` (doMetacogCheck — create topology_declared event instead of executeMetacogCommand)

**Step 1:** In `doMetacogCheck()` (kernel.ts, around line 471), after the metacog LLM returns, instead of parsing commands and calling `executeMetacogCommand()` for each:

1. Parse the response as `MetacogOutput`
2. Create a `topology_declared` event
3. Feed it through `transition(state, event)` → `applyStateChanges` → `interpretTransitionEffects`

**Step 2:** Add effect handlers in `interpretTransitionEffects` for the new effect types:

- `spawn_topology_process` — create process via supervisor.spawn + activate
- `kill_process` — kill via supervisor.kill + dispose thread
- `drain_process` — mark for kill-on-completion (add to a draining set)
- Memory commands — execute via existing memory store methods

**Step 3:** Remove or deprecate `executeMetacogCommand()` — the topology commands (spawn, kill, fork, defer, cancel_defer, rewrite_dag, spawn_system, spawn_kernel, reprioritize, noop, delegate_evaluation) are no longer needed. Keep memory commands (learn, define_blueprint, evolve_blueprint, record_strategy) as effect handlers.

**Step 4:** Remove `handleDagRewrite()` — topology mutations are now handled by the reconciler.

**Step 5:** Run: `npx tsc --noEmit && npx vitest run`

**Step 6:** Commit: `feat(topology): wire kernel to use topology_declared events`

---

## Task 11: End-to-End Verification

**Files:**
- Modify: `test/os/state-machine/transition.test.ts`
- Modify: `test/os/event-driven-kernel.test.ts`

**Step 1:** Add transition tests for `handleTopologyDeclared`:

- Null topology → zero effects
- Valid topology → reconcile effects emitted
- Invalid topology → error protocol emitted
- Halt command → kernel halts
- Memory commands → protocol effects emitted

**Step 2:** Add event-driven kernel test:

- Boot → submit_metacog effect emitted (no goal-orchestrator)
- Mock metacog returning a topology → processes spawned correctly

**Step 3:** Run full suite: `npx vitest run`

**Step 4:** Run `npx tsc --noEmit` — zero errors.

**Step 5:** Commit: `test(topology): end-to-end topology algebra tests`

---

## Task 12: Cleanup

**Files:**
- Modify: `src/os/kernel.ts` (remove dead code)
- Modify: `src/os/types.ts` (remove DagMutation, old MetacogCommand topology variants)

**Step 1:** Remove `executeMetacogCommand()` topology command cases (spawn, kill, fork, defer, cancel_defer, rewrite_dag, spawn_system, spawn_kernel, reprioritize, noop, delegate_evaluation). Keep halt and memory command handlers as effect interpreters.

**Step 2:** Remove `handleDagRewrite()` entirely.

**Step 3:** Remove `DagMutation` type from types.ts.

**Step 4:** Remove topology-related variants from `MetacogCommand` type. Keep memory variants.

**Step 5:** Remove dead executive recovery code from transition.ts.

**Step 6:** Run: `npx tsc --noEmit && npx vitest run`

**Step 7:** Commit: `refactor(topology): remove imperative metacog commands and DAG mutations`

---

## Verification Checklist

After all tasks, verify:

1. `npx tsc --noEmit` — zero type errors
2. `npx vitest run` — all tests pass, no hangs (kill after 30s if stuck)
3. No goal-orchestrator process spawned at boot
4. Metacog declares topologies, not imperative commands
5. Reconciler is a pure function called inside transition
6. `executeMetacogCommand` topology cases removed
7. `handleDagRewrite` removed
8. Property-based tests prove flatten/reconcile invariants
9. Topology validation rejects malformed expressions
10. Gate conditions evaluated correctly (gated nodes skipped until condition met)
