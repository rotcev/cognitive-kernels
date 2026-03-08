import { describe, expect, test } from "vitest";
import { validateTopology } from "../../../src/os/topology/validate.js";
import type { TopologyExpr } from "../../../src/os/topology/types.js";

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
