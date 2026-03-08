import { describe, it, expect } from "vitest";
import { autoArrange } from "../../../src/os/topology/auto-arrange.js";
import type { TopologyExpr } from "../../../src/os/topology/types.js";

describe("autoArrange", () => {
  it("returns unannotated topology unchanged", () => {
    const topology: TopologyExpr = {
      type: "par",
      children: [
        { type: "task", name: "a", objective: "do A" },
        { type: "task", name: "b", objective: "do B" },
      ],
    };
    expect(autoArrange(topology)).toEqual(topology);
  });

  it("puts independent tasks (disjoint writes, no reads) in parallel", () => {
    const topology: TopologyExpr = {
      type: "par",
      children: [
        { type: "task", name: "a", objective: "do A", reads: [], writes: ["out:a"] },
        { type: "task", name: "b", objective: "do B", reads: [], writes: ["out:b"] },
      ],
    };
    const result = autoArrange(topology);
    // Both are tier 0 (no deps) → par
    expect(result.type).toBe("par");
    if (result.type === "par") {
      expect(result.children).toHaveLength(2);
    }
  });

  it("sequences a task that reads another's writes", () => {
    const topology: TopologyExpr = {
      type: "par",
      children: [
        { type: "task", name: "research", objective: "gather", reads: [], writes: ["data:raw"] },
        { type: "task", name: "synthesize", objective: "combine", reads: ["data:raw"], writes: ["result:final"] },
      ],
    };
    const result = autoArrange(topology);
    // research (tier 0) → synthesize (tier 1) → seq
    expect(result.type).toBe("seq");
    if (result.type === "seq") {
      expect(result.children).toHaveLength(2);
      expect(result.children[0].type).toBe("task");
      expect(result.children[1].type).toBe("task");
      if (result.children[0].type === "task" && result.children[1].type === "task") {
        expect(result.children[0].name).toBe("research");
        expect(result.children[1].name).toBe("synthesize");
      }
    }
  });

  it("computes par(a,b) → seq(c) from deps", () => {
    const topology: TopologyExpr = {
      type: "par",
      children: [
        { type: "task", name: "a", objective: "research A", reads: [], writes: ["findings:a"] },
        { type: "task", name: "b", objective: "research B", reads: [], writes: ["findings:b"] },
        { type: "task", name: "c", objective: "synthesize", reads: ["findings:a", "findings:b"], writes: ["result:final"] },
      ],
    };
    const result = autoArrange(topology);
    // a,b are tier 0 (par), c is tier 1 → seq(par(a,b), c)
    expect(result.type).toBe("seq");
    if (result.type === "seq") {
      expect(result.children).toHaveLength(2);
      expect(result.children[0].type).toBe("par");
      expect(result.children[1].type).toBe("task");
      if (result.children[0].type === "par") {
        const names = result.children[0].children.map(c => c.type === "task" ? c.name : "?");
        expect(names).toContain("a");
        expect(names).toContain("b");
      }
      if (result.children[1].type === "task") {
        expect(result.children[1].name).toBe("c");
      }
    }
  });

  it("handles 3-tier deep dependency chains", () => {
    const topology: TopologyExpr = {
      type: "par",
      children: [
        { type: "task", name: "gather", objective: "collect", reads: [], writes: ["raw:data"] },
        { type: "task", name: "process", objective: "transform", reads: ["raw:data"], writes: ["processed:data"] },
        { type: "task", name: "report", objective: "format", reads: ["processed:data"], writes: ["result:report"] },
      ],
    };
    const result = autoArrange(topology);
    // gather → process → report (3-tier seq)
    expect(result.type).toBe("seq");
    if (result.type === "seq") {
      expect(result.children).toHaveLength(3);
      const names = result.children.map(c => c.type === "task" ? c.name : "?");
      expect(names).toEqual(["gather", "process", "report"]);
    }
  });

  it("passes through manually structured seq/par topologies unchanged", () => {
    const topology: TopologyExpr = {
      type: "seq",
      children: [
        { type: "task", name: "a", objective: "first", reads: [], writes: ["out:a"] },
        { type: "task", name: "b", objective: "second", reads: ["out:a"], writes: ["out:b"] },
      ],
    };
    // seq at top level → not auto-arranged (user explicitly chose seq)
    const result = autoArrange(topology);
    expect(result).toEqual(topology);
  });

  it("handles single task passthrough", () => {
    const topology: TopologyExpr = {
      type: "task", name: "solo", objective: "do it", reads: [], writes: ["result:x"],
    };
    expect(autoArrange(topology)).toEqual(topology);
  });

  it("handles diamond dependencies", () => {
    // a → b, a → c, b+c → d
    const topology: TopologyExpr = {
      type: "par",
      children: [
        { type: "task", name: "a", objective: "start", reads: [], writes: ["stage:1"] },
        { type: "task", name: "b", objective: "path B", reads: ["stage:1"], writes: ["stage:2b"] },
        { type: "task", name: "c", objective: "path C", reads: ["stage:1"], writes: ["stage:2c"] },
        { type: "task", name: "d", objective: "merge", reads: ["stage:2b", "stage:2c"], writes: ["result:final"] },
      ],
    };
    const result = autoArrange(topology);
    // a (tier 0) → par(b,c) (tier 1) → d (tier 2)
    expect(result.type).toBe("seq");
    if (result.type === "seq") {
      expect(result.children).toHaveLength(3);
      expect(result.children[0].type).toBe("task"); // a
      expect(result.children[1].type).toBe("par");  // b,c
      expect(result.children[2].type).toBe("task"); // d
    }
  });
});
