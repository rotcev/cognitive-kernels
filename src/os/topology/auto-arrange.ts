import type { TopologyExpr } from "./types.js";

type TaskNode = Extract<TopologyExpr, { type: "task" }>;

/**
 * Auto-arrange tasks into an optimal par/seq topology based on data dependencies.
 *
 * Tasks declare `reads` (blackboard keys they consume) and `writes` (keys they produce).
 * The algorithm:
 *   1. Build a dependency graph: task A depends on B if A.reads intersects B.writes
 *   2. Topological sort into tiers (tasks whose deps are all in earlier tiers)
 *   3. Tasks within a tier run in parallel; tiers run sequentially
 *
 * If a task has no reads/writes, it's treated as independent (tier 0).
 * Cyclic dependencies are detected and reported by placing offending tasks in the last tier.
 */
export function autoArrange(expr: TopologyExpr): TopologyExpr {
  // Only process topology trees that contain tasks with reads/writes annotations.
  // If no task has annotations, return as-is (backwards compatible).
  const tasks = extractAnnotatedTasks(expr);
  if (tasks.length === 0) return expr;

  // If the topology is already manually structured (seq/par with no annotated tasks
  // at the top level), respect that — only auto-arrange flat task lists or par() of tasks.
  if (expr.type !== "par" && expr.type !== "task") return expr;

  // Collect all tasks (annotated + unannotated from a par)
  const allTasks = collectTasks(expr);
  if (allTasks.length <= 1) return expr;

  // Build dependency graph
  const writeMap = new Map<string, string[]>(); // key → task names that write it
  for (const task of allTasks) {
    for (const key of task.writes ?? []) {
      const writers = writeMap.get(key) ?? [];
      writers.push(task.name);
      writeMap.set(key, writers);
    }
  }

  // task name → set of task names it depends on
  const deps = new Map<string, Set<string>>();
  for (const task of allTasks) {
    const taskDeps = new Set<string>();
    for (const key of task.reads ?? []) {
      for (const writer of writeMap.get(key) ?? []) {
        if (writer !== task.name) taskDeps.add(writer);
      }
    }
    deps.set(task.name, taskDeps);
  }

  // Topological sort into tiers (Kahn's algorithm)
  const tiers: TaskNode[][] = [];
  const placed = new Set<string>();
  const taskMap = new Map(allTasks.map(t => [t.name, t]));
  let remaining = new Set(allTasks.map(t => t.name));

  while (remaining.size > 0) {
    // Find tasks whose deps are all placed
    const tier: TaskNode[] = [];
    for (const name of remaining) {
      const taskDeps = deps.get(name)!;
      if ([...taskDeps].every(d => placed.has(d))) {
        tier.push(taskMap.get(name)!);
      }
    }

    if (tier.length === 0) {
      // Cycle detected — place remaining tasks in final tier
      for (const name of remaining) {
        tier.push(taskMap.get(name)!);
      }
      tiers.push(tier);
      break;
    }

    tiers.push(tier);
    for (const task of tier) {
      placed.add(task.name);
      remaining.delete(task.name);
    }
  }

  // Convert tiers to topology
  return tiersToExpr(tiers);
}

function tiersToExpr(tiers: TaskNode[][]): TopologyExpr {
  const tierExprs: TopologyExpr[] = tiers.map(tier =>
    tier.length === 1 ? tier[0] : { type: "par" as const, children: tier },
  );
  return tierExprs.length === 1 ? tierExprs[0] : { type: "seq", children: tierExprs };
}

function collectTasks(expr: TopologyExpr): TaskNode[] {
  if (expr.type === "task") return [expr];
  if (expr.type === "par" || expr.type === "seq") {
    return expr.children.flatMap(collectTasks);
  }
  if (expr.type === "gate") return collectTasks(expr.child);
  return [];
}

function extractAnnotatedTasks(expr: TopologyExpr): TaskNode[] {
  return collectTasks(expr).filter(
    t => (t.reads && t.reads.length > 0) || (t.writes && t.writes.length > 0),
  );
}
