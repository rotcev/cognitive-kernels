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

      // Flatten same-type nesting: seq(seq(A, B), C) -> seq(A, B, C)
      children = children.flatMap(c =>
        c.type === expr.type ? (c as typeof expr).children : [c]
      );

      // Eliminate single-child wrapper: par(A) -> A
      if (children.length === 1) return children[0];

      // Gate hoisting: par(gate(X, A), gate(X, B)) -> gate(X, par(A, B))
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
