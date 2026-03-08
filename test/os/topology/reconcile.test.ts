import { describe, expect, test } from "vitest";
import { reconcile } from "../../../src/os/topology/reconcile.js";
import type { TopologyExpr } from "../../../src/os/topology/types.js";

// Helper: create a minimal alive process
function proc(name: string, state: "running" | "idle" | "dead" = "running") {
  return {
    pid: `pid-${name}`,
    name,
    state,
    priority: 70,
  };
}

describe("reconcile", () => {
  test("empty -> topology: spawns all tasks", () => {
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
    expect(effects).toHaveLength(0);
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

  test("seq dependency not yet complete: don't spawn dependent", () => {
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

  test("gate wrapping seq: gated nodes not spawned when condition unmet", () => {
    const topology: TopologyExpr = { type: "gate",
      condition: { type: "blackboard_key_exists", key: "schema" },
      child: { type: "seq", children: [
        { type: "task", name: "A", objective: "do A" },
        { type: "task", name: "B", objective: "do B" },
      ]},
    };
    const effects = reconcile(new Map(), topology, new Map(), new Set());
    const spawns = effects.filter(e => e.type === "spawn_process");
    expect(spawns).toHaveLength(0);
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
