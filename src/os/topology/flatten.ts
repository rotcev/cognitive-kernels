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
        reads: expr.reads,
        writes: expr.writes,
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
      const merged = mergeParts(parts);

      // Apply gate condition to entry nodes
      if (gateCondition) {
        for (const entryName of merged.entryNodes) {
          const node = merged.nodes.get(entryName);
          if (node) {
            node.gateCondition = gateCondition;
          }
        }
      }

      return merged;
    }

    case "seq": {
      const parts = expr.children.map(c => flattenExpr(c, undefined));
      const merged = mergeParts(parts);

      // Wire sequential dependencies: exit nodes of each part -> entry nodes of next part
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

      // Apply gate condition to entry nodes
      if (gateCondition) {
        for (const entryName of merged.entryNodes) {
          const node = merged.nodes.get(entryName);
          if (node) {
            node.gateCondition = gateCondition;
          }
        }
      }

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
