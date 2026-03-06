import { randomUUID } from "node:crypto";
import type {
  OsProcess,
  OsDagNode,
  OsDagEdge,
  OsDagTopology,
  OsDagPatch,
  OsDagDelta,
  OsDagMetrics,
  OsDagSnapshot,
  OsProcessState,
} from "./types.js";

type DeltaEntry = {
  timestamp: string;
  type: "node-added" | "node-removed" | "edge-added" | "edge-removed" | "node-updated";
  id: string;
  edge?: OsDagEdge;
};

export class OsDagEngine {
  private nodes: Map<string, OsDagNode> = new Map();
  private edges: OsDagEdge[] = [];
  private history: DeltaEntry[] = [];
  private lastSnapshotAt: string = new Date().toISOString();
  /** Edges injected via applyPatch() that must survive DAG rebuilds. */
  private patchedEdges: OsDagEdge[] = [];
  /** Nodes injected via applyPatch() that must survive DAG rebuilds.
   *  Key is pid. These are virtual/planning nodes not present in the process table. */
  private patchedNodes: Map<string, OsDagNode> = new Map();

  buildFromProcesses(processes: OsProcess[]): void {
    this.nodes.clear();
    this.edges = [];
    this.history = [];

    for (const proc of processes) {
      const node: OsDagNode = {
        pid: proc.pid,
        name: proc.name,
        type: proc.type,
        state: proc.state,
        priority: proc.priority,
        parentPid: proc.parentPid,
      };
      this.nodes.set(proc.pid, node);
    }

    for (const proc of processes) {
      if (proc.parentPid && this.nodes.has(proc.parentPid)) {
        this.edges.push({
          from: proc.parentPid,
          to: proc.pid,
          relation: "parent-child",
        });
      }
    }

    // Re-apply persisted patched nodes after rebuild (virtual/planning nodes
    // added via rewrite_dag that don't correspond to live process-table entries).
    for (const [pid, node] of this.patchedNodes) {
      if (!this.nodes.has(pid)) {
        this.nodes.set(pid, node);
      }
    }

    // Re-apply persisted patched edges after rebuild.
    // Only add patched edges where both endpoints still exist to avoid dangling refs.
    for (const edge of this.patchedEdges) {
      if (this.nodes.has(edge.from) && this.nodes.has(edge.to)) {
        // Skip if an equivalent edge already exists (e.g., a parent-child that's also patched)
        const alreadyExists = this.edges.some(
          (e) => e.from === edge.from && e.to === edge.to,
        );
        if (!alreadyExists) {
          // Use raw push (no addEdge) to avoid duplicate history entries on rebuild
          this.edges.push(edge);
        }
      }
    }
  }

  addNode(node: OsDagNode): void {
    this.nodes.set(node.pid, node);
    this.recordHistory("node-added", node.pid);
  }

  removeNode(pid: string): void {
    this.nodes.delete(pid);
    this.edges = this.edges.filter((e) => {
      if (e.from === pid || e.to === pid) {
        this.recordHistory("edge-removed", `${e.from}->${e.to}`, e);
        return false;
      }
      return true;
    });
    this.recordHistory("node-removed", pid);
  }

  addEdge(edge: OsDagEdge): void {
    if (!this.nodes.has(edge.from)) {
      throw new Error(`Source node "${edge.from}" does not exist`);
    }
    if (!this.nodes.has(edge.to)) {
      throw new Error(`Target node "${edge.to}" does not exist`);
    }

    // Temporarily add the edge and check for cycles
    this.edges.push(edge);
    if (this.hasCycle()) {
      this.edges.pop();
      throw new Error(
        `Adding edge ${edge.from} -> ${edge.to} would create a cycle`,
      );
    }

    this.recordHistory("edge-added", `${edge.from}->${edge.to}`, edge);
  }

  removeEdge(from: string, to: string): void {
    const idx = this.edges.findIndex((e) => e.from === from && e.to === to);
    if (idx !== -1) {
      const edge = this.edges[idx]!;
      this.edges.splice(idx, 1);
      this.recordHistory("edge-removed", `${from}->${to}`, edge);
    }
  }

  currentTopology(): OsDagTopology {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }

  applyPatch(patch: OsDagPatch): void {
    // 1. Remove nodes — also remove from patchedNodes so they don't get
    //    re-applied on the next rebuild.
    if (patch.removeNodes) {
      for (const pid of patch.removeNodes) {
        this.removeNode(pid);
        this.patchedNodes.delete(pid);
      }
    }

    // 2. Add nodes — persist to patchedNodes so they survive every rebuild.
    if (patch.addNodes) {
      for (const node of patch.addNodes) {
        this.addNode(node);
        // Record in patchedNodes if not already there
        if (!this.patchedNodes.has(node.pid)) {
          this.patchedNodes.set(node.pid, node);
        }
      }
    }

    // 3. Remove edges — remove from both ephemeral DAG and patchedEdges so they
    //    don't get re-applied on the next rebuild.
    if (patch.removeEdges) {
      for (const { from, to } of patch.removeEdges) {
        this.removeEdge(from, to);
        this.patchedEdges = this.patchedEdges.filter(
          (e) => !(e.from === from && e.to === to),
        );
      }
    }

    // 4. Add edges — persist to patchedEdges so they survive every rebuild.
    if (patch.addEdges) {
      for (const edge of patch.addEdges) {
        this.addEdge(edge);
        // Record in patchedEdges if not already there
        const alreadyPatched = this.patchedEdges.some(
          (e) => e.from === edge.from && e.to === edge.to,
        );
        if (!alreadyPatched) {
          this.patchedEdges.push(edge);
        }
      }
    }

    // 5. Update nodes
    if (patch.updateNodes) {
      for (const { pid, changes } of patch.updateNodes) {
        const existing = this.nodes.get(pid);
        if (existing) {
          Object.assign(existing, changes);
          this.recordHistory("node-updated", pid);
        }
      }
    }
  }

  hasCycle(): boolean {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    const color = new Map<string, number>();
    for (const pid of this.nodes.keys()) {
      color.set(pid, WHITE);
    }

    const dfs = (pid: string): boolean => {
      color.set(pid, GRAY);
      for (const edge of this.edges) {
        if (edge.from !== pid) continue;
        const neighborColor = color.get(edge.to);
        if (neighborColor === GRAY) return true;
        if (neighborColor === WHITE && dfs(edge.to)) return true;
      }
      color.set(pid, BLACK);
      return false;
    };

    for (const pid of this.nodes.keys()) {
      if (color.get(pid) === WHITE) {
        if (dfs(pid)) return true;
      }
    }

    return false;
  }

  delta(since: string): OsDagDelta {
    const sinceTime = new Date(since).getTime();
    const relevant = this.history.filter(
      (entry) => new Date(entry.timestamp).getTime() > sinceTime,
    );

    const nodesAdded: string[] = [];
    const nodesRemoved: string[] = [];
    const edgesAdded: OsDagEdge[] = [];
    const edgesRemoved: OsDagEdge[] = [];
    const nodesUpdated: string[] = [];

    for (const entry of relevant) {
      switch (entry.type) {
        case "node-added":
          nodesAdded.push(entry.id);
          break;
        case "node-removed":
          nodesRemoved.push(entry.id);
          break;
        case "edge-added":
          if (entry.edge) edgesAdded.push(entry.edge);
          break;
        case "edge-removed":
          if (entry.edge) edgesRemoved.push(entry.edge);
          break;
        case "node-updated":
          if (!nodesUpdated.includes(entry.id)) {
            nodesUpdated.push(entry.id);
          }
          break;
      }
    }

    return { since, nodesAdded, nodesRemoved, edgesAdded, edgesRemoved, nodesUpdated };
  }

  snapshot(
    runId: string,
    trigger: string,
    processStates: Record<string, OsProcessState>,
  ): OsDagSnapshot {
    const now = new Date().toISOString();
    this.lastSnapshotAt = now;

    return {
      id: randomUUID(),
      runId,
      capturedAt: now,
      trigger,
      topology: this.currentTopology(),
      processStates,
      metrics: this.metrics(),
    };
  }

  metrics(): OsDagMetrics {
    const nodeCount = this.nodes.size;
    const edgeCount = this.edges.length;

    let runningCount = 0;
    let stalledCount = 0;
    let deadCount = 0;

    for (const node of this.nodes.values()) {
      if (node.state === "running") runningCount++;
      if (node.state === "sleeping" || node.state === "idle") stalledCount++;
      if (node.state === "dead") deadCount++;
    }

    const maxDepth = this.computeMaxDepth();

    return { nodeCount, edgeCount, maxDepth, runningCount, stalledCount, deadCount };
  }

  getNode(pid: string): OsDagNode | undefined {
    return this.nodes.get(pid);
  }

  getEdgesFrom(pid: string): OsDagEdge[] {
    return this.edges.filter((e) => e.from === pid);
  }

  getEdgesTo(pid: string): OsDagEdge[] {
    return this.edges.filter((e) => e.to === pid);
  }

  getRoots(): OsDagNode[] {
    const targets = new Set(this.edges.map((e) => e.to));
    return Array.from(this.nodes.values()).filter((n) => !targets.has(n.pid));
  }

  clear(): void {
    this.nodes.clear();
    this.edges = [];
    this.history = [];
    this.patchedEdges = [];
    this.patchedNodes.clear();
  }

  private recordHistory(type: DeltaEntry["type"], id: string, edge?: OsDagEdge): void {
    this.history.push({
      timestamp: new Date().toISOString(),
      type,
      id,
      edge,
    });
  }

  private computeMaxDepth(): number {
    if (this.nodes.size === 0) return 0;

    const roots = this.getRoots();
    if (roots.length === 0) return 0;

    let maxDepth = 0;

    const dfs = (pid: string, depth: number): void => {
      if (depth > maxDepth) maxDepth = depth;
      for (const edge of this.edges) {
        if (edge.from === pid) {
          dfs(edge.to, depth + 1);
        }
      }
    };

    for (const root of roots) {
      dfs(root.pid, 0);
    }

    return maxDepth;
  }
}
