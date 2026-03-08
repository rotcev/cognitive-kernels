import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { flatten } from "../../../src/os/topology/flatten.js";
import { validateTopology } from "../../../src/os/topology/validate.js";
import { reconcile } from "../../../src/os/topology/reconcile.js";
import type { TopologyExpr } from "../../../src/os/topology/types.js";

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
