import { flatten } from "./flatten.js";
import { evaluateGateCondition } from "./gates.js";
import type { TopologyExpr, FlatNode, GateCondition } from "./types.js";

/** Effects produced by the reconciler. */
export type ReconcileEffect =
  | { type: "spawn_process"; name: string; objective: string; model?: string; priority?: number; backend?: FlatNode["backend"] }
  | { type: "kill_process"; pid: string; name: string }
  | { type: "drain_process"; pid: string; name: string }
  | { type: "update_process"; pid: string; priority?: number; objective?: string }
  | { type: "activate_process"; pid?: string; name: string }
  | { type: "add_edge"; from: string; to: string }
  | { type: "remove_edge"; from: string; to: string }
  | { type: "emit_protocol"; action: string; message: string };

/** Minimal process interface (avoids importing full OsProcess). */
interface ProcessInfo {
  pid: string;
  name: string;
  state: string;
  priority?: number;
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

  // 3. Build lookup: name -> existing alive process
  const existingByName = new Map<string, ProcessInfo>();
  for (const [pid, proc] of currentProcesses) {
    if (proc.state !== "dead") {
      existingByName.set(proc.name, proc);
    }
  }

  // 4. Match: desired vs existing
  const matched = new Map<string, ProcessInfo>();
  const toSpawn: FlatNode[] = [];
  const toKill: ProcessInfo[] = [];

  for (const [name, node] of activeNodes) {
    const existing = existingByName.get(name);
    if (existing) {
      matched.set(name, existing);
      // Check for config changes
      if (node.priority !== undefined && node.priority !== existing.priority) {
        effects.push({ type: "update_process", pid: existing.pid, priority: node.priority });
      }
    } else {
      toSpawn.push(node);
    }
  }

  for (const [name, proc] of existingByName) {
    if (!activeNodes.has(name)) {
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
      for (const proc of currentProcesses.values()) {
        if (proc.name === dep.from && proc.state === "dead") return true;
      }
      return false;
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
