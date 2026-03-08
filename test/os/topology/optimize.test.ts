import { describe, expect, test } from "vitest";
import { optimizeTopology } from "../../../src/os/topology/optimize.js";
import type { TopologyExpr } from "../../../src/os/topology/types.js";

describe("optimizeTopology", () => {
  test("flatten nested seq: seq(seq(A, B), C) -> seq(A, B, C)", () => {
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

  test("flatten nested par: par(par(A, B), C) -> par(A, B, C)", () => {
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

  test("eliminate single-child wrapper: par(A) -> A", () => {
    const expr: TopologyExpr = { type: "par", children: [
      { type: "task", name: "A", objective: "a" },
    ]};
    const { optimized } = optimizeTopology(expr);
    expect(optimized.type).toBe("task");
  });

  test("gate hoisting: par(gate(X, A), gate(X, B)) -> gate(X, par(A, B))", () => {
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
