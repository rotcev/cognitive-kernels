import { describe, expect, test } from "vitest";
import { flatten } from "../../../src/os/topology/flatten.js";
import type { TopologyExpr } from "../../../src/os/topology/types.js";

describe("flatten", () => {
  test("single task -> 1 node, 0 edges", () => {
    const expr: TopologyExpr = { type: "task", name: "A", objective: "do A" };
    const result = flatten(expr);
    expect(result.nodes.size).toBe(1);
    expect(result.nodes.get("A")?.objective).toBe("do A");
    expect(result.edges).toHaveLength(0);
    expect(result.entryNodes).toEqual(["A"]);
    expect(result.exitNodes).toEqual(["A"]);
  });

  test("seq(A, B, C) -> 3 nodes, edges A->B, B->C", () => {
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

  test("par(A, B, C) -> 3 nodes, 0 edges", () => {
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

  test("seq(par(A, B), C) -> edges A->C, B->C", () => {
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

  test("gate wrapping seq: gate(cond, seq(A, B)) → condition on entry node A", () => {
    const expr: TopologyExpr = { type: "gate",
      condition: { type: "blackboard_key_exists", key: "ready" },
      child: { type: "seq", children: [
        { type: "task", name: "A", objective: "do A" },
        { type: "task", name: "B", objective: "do B" },
      ]},
    };
    const result = flatten(expr);
    expect(result.nodes.get("A")?.gateCondition).toEqual({ type: "blackboard_key_exists", key: "ready" });
    expect(result.nodes.get("B")?.gateCondition).toBeUndefined();
  });

  test("gate wrapping par: gate(cond, par(A, B)) → condition on all entry nodes", () => {
    const expr: TopologyExpr = { type: "gate",
      condition: { type: "blackboard_key_exists", key: "ready" },
      child: { type: "par", children: [
        { type: "task", name: "A", objective: "do A" },
        { type: "task", name: "B", objective: "do B" },
      ]},
    };
    const result = flatten(expr);
    expect(result.nodes.get("A")?.gateCondition).toEqual({ type: "blackboard_key_exists", key: "ready" });
    expect(result.nodes.get("B")?.gateCondition).toEqual({ type: "blackboard_key_exists", key: "ready" });
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
