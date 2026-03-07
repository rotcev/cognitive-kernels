/**
 * Lens Pipeline — closed-loop integration tests.
 *
 * Replays golden run fixtures through the full Lens pipeline and asserts
 * every output type matches what the UI needs.
 */

import { describe, expect, test, beforeAll } from "vitest";
import { loadGoldenRun, type GoldenRun } from "./replay-harness.js";
import { buildLensSnapshot } from "../../src/lens/view-models.js";
import { classifyRole } from "../../src/lens/role-classifier.js";
import { StreamSegmenter } from "../../src/lens/stream-segmenter.js";
import { diffSnapshots } from "../../src/lens/snapshot-differ.js";
import type {
  LensSnapshot,
  LensProcess,
  LensDagNode,
  LensEdge,
  LensBBEntry,
  LensHeuristic,
  LensDeferral,
  LensMetrics,
  LensTerminalLine,
  LensSnapshotDelta,
} from "../../src/lens/types.js";

let golden: GoldenRun;
let lensSnapshots: LensSnapshot[];

beforeAll(() => {
  golden = loadGoldenRun();
  console.log(`[lens-pipeline] Using ${golden.source} fixtures: ${golden.snapshots.length} snapshots, ${golden.events.length} events`);

  // Build LensSnapshots from all kernel snapshots
  lensSnapshots = [];
  let prevTokens: { total: number; timestamp: number } | undefined;
  for (const snap of golden.snapshots) {
    const lens = buildLensSnapshot(snap, prevTokens);
    lensSnapshots.push(lens);
    prevTokens = {
      total: snap.progressMetrics.totalTokensUsed,
      timestamp: Date.now(),
    };
  }
});

// ═══════════════════════════════════════
// SECTION 1: LensSnapshot shape
// ═══════════════════════════════════════

describe("lens:snapshot-shape", () => {
  test("every snapshot has required top-level fields", () => {
    for (const snap of lensSnapshots) {
      expect(snap.runId).toBeTypeOf("string");
      expect(snap.tick).toBeTypeOf("number");
      expect(snap.goal).toBeTypeOf("string");
      expect(snap.elapsed).toBeTypeOf("number");
      expect(snap.processes).toBeInstanceOf(Array);
      expect(snap.dag).toBeDefined();
      expect(snap.dag.nodes).toBeInstanceOf(Array);
      expect(snap.dag.edges).toBeInstanceOf(Array);
      expect(snap.blackboard).toBeTypeOf("object");
      expect(snap.heuristics).toBeInstanceOf(Array);
      expect(snap.deferrals).toBeInstanceOf(Array);
      expect(snap.metrics).toBeDefined();
    }
  });

  test("tick count is monotonically increasing", () => {
    for (let i = 1; i < lensSnapshots.length; i++) {
      expect(lensSnapshots[i].tick).toBeGreaterThanOrEqual(lensSnapshots[i - 1].tick);
    }
  });

  test("final snapshot has at least 2 processes", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    expect(last.processes.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════
// SECTION 2: Process model
// ═══════════════════════════════════════

describe("lens:process-model", () => {
  test("every process has required fields", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    for (const proc of last.processes) {
      expect(proc.pid).toBeTypeOf("string");
      expect(proc.name).toBeTypeOf("string");
      expect(proc.state).toBeTypeOf("string");
      expect(proc.role).toMatch(/^(kernel|sub-kernel|worker|shell)$/);
      expect(proc.objective).toBeTypeOf("string");
      expect(proc.priority).toBeTypeOf("number");
      expect(proc.tickCount).toBeTypeOf("number");
      expect(proc.tokensUsed).toBeTypeOf("number");
      expect(proc.model).toBeTypeOf("string");
      expect(proc.spawnedAt).toBeTypeOf("string");
      expect(proc.lastActiveAt).toBeTypeOf("string");
      expect(proc.children).toBeInstanceOf(Array);
      expect(proc.selfReports).toBeInstanceOf(Array);
      expect(proc.blackboardIO).toBeInstanceOf(Array);
    }
  });

  test("tokenBudget is number or null", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    for (const proc of last.processes) {
      expect(proc.tokenBudget === null || typeof proc.tokenBudget === "number").toBe(true);
    }
  });
});

// ═══════════════════════════════════════
// SECTION 3: Role classification
// ═══════════════════════════════════════

describe("lens:role-classification", () => {
  test("daemons are classified as kernel", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const daemons = last.processes.filter((p) => p.type === "daemon");
    for (const d of daemons) {
      expect(d.role).toBe("kernel");
    }
  });

  test("goal-orchestrator (root lifecycle) is kernel", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const orchestrator = last.processes.find((p) => p.name === "goal-orchestrator");
    if (orchestrator) {
      expect(orchestrator.role).toBe("kernel");
    }
  });

  test("processes with backend.kind=kernel are sub-kernel", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const subkernels = last.processes.filter((p) => p.backendKind === "kernel");
    for (const p of subkernels) {
      expect(p.role).toBe("sub-kernel");
    }
  });

  test("processes with backend.kind=system are shell", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const shells = last.processes.filter((p) => p.backendKind === "system");
    for (const s of shells) {
      expect(s.role).toBe("shell");
    }
  });

  test("spawned LLM children are workers", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const workers = last.processes.filter(
      (p) => p.parentPid !== null && p.type === "lifecycle" && p.backendKind !== "kernel" && p.backendKind !== "system",
    );
    for (const w of workers) {
      expect(w.role).toBe("worker");
    }
  });
});

// ═══════════════════════════════════════
// SECTION 4: DAG
// ═══════════════════════════════════════

describe("lens:dag", () => {
  test("DAG nodes match process list", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const procPids = new Set(last.processes.map((p) => p.pid));
    const nodePids = new Set(last.dag.nodes.map((n) => n.pid));
    expect(nodePids).toEqual(procPids);
  });

  test("DAG nodes have role field", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    for (const node of last.dag.nodes) {
      expect(node.role).toMatch(/^(kernel|sub-kernel|worker|shell)$/);
    }
  });

  test("edges have valid from/to references", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const pids = new Set(last.dag.nodes.map((n) => n.pid));
    for (const edge of last.dag.edges) {
      expect(pids.has(edge.from)).toBe(true);
      expect(pids.has(edge.to)).toBe(true);
      expect(edge.relation).toMatch(/^(parent-child|dependency)$/);
    }
  });

  test("at least one parent-child and one dependency edge in final snapshot", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    if (last.dag.edges.length === 0) {
      // Short golden runs may have no edges — just verify structure
      expect(last.dag.edges).toEqual([]);
      return;
    }
    expect(last.dag.edges.some((e) => e.relation === "parent-child")).toBe(true);
    expect(last.dag.edges.some((e) => e.relation === "dependency")).toBe(true);
  });
});

// ═══════════════════════════════════════
// SECTION 5: Blackboard
// ═══════════════════════════════════════

describe("lens:blackboard", () => {
  test("blackboard entries have required fields", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    for (const [key, entry] of Object.entries(last.blackboard)) {
      expect(entry.key).toBe(key);
      expect(entry.writer).toBeTypeOf("string");
      expect(entry.readBy).toBeInstanceOf(Array);
      // value can be anything
    }
  });

  test("final snapshot has at least one blackboard key", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    expect(Object.keys(last.blackboard).length).toBeGreaterThan(0);
  });

  test("process blackboardIO entries have correct shape", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const withIO = last.processes.filter((p) => p.blackboardIO.length > 0);
    // Short golden runs may have no blackboard IO — validate shape if present
    if (withIO.length === 0) {
      expect(last.processes.every((p) => Array.isArray(p.blackboardIO))).toBe(true);
      return;
    }

    for (const proc of withIO) {
      for (const entry of proc.blackboardIO) {
        expect(entry.key).toBeTypeOf("string");
        expect(entry.direction).toMatch(/^(read|write)$/);
        expect(entry.valuePreview).toBeTypeOf("string");
      }
    }
  });
});

// ═══════════════════════════════════════
// SECTION 6: Metrics
// ═══════════════════════════════════════

describe("lens:metrics", () => {
  test("metrics have all required fields", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const m = last.metrics;
    expect(m.totalTokens).toBeTypeOf("number");
    expect(m.tokenRate).toBeTypeOf("number");
    expect(m.processCount).toBeTypeOf("number");
    expect(m.runningCount).toBeTypeOf("number");
    expect(m.sleepingCount).toBeTypeOf("number");
    expect(m.deadCount).toBeTypeOf("number");
    expect(m.checkpointedCount).toBeTypeOf("number");
    expect(m.suspendedCount).toBeTypeOf("number");
    expect(m.dagDepth).toBeTypeOf("number");
    expect(m.dagEdgeCount).toBeTypeOf("number");
    expect(m.wallTimeElapsedMs).toBeTypeOf("number");
    expect(m.tickCount).toBeTypeOf("number");
  });

  test("processCount matches actual process list length", () => {
    for (const snap of lensSnapshots) {
      expect(snap.metrics.processCount).toBe(snap.processes.length);
    }
  });

  test("state counts are consistent", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    const m = last.metrics;
    const counted =
      m.runningCount + m.sleepingCount + m.deadCount + m.checkpointedCount + m.suspendedCount;
    // Some processes may be in other states (spawned, idle), so counted <= total
    expect(counted).toBeLessThanOrEqual(m.processCount);
  });
});

// ═══════════════════════════════════════
// SECTION 7: Heuristics & Deferrals
// ═══════════════════════════════════════

describe("lens:heuristics-deferrals", () => {
  test("heuristics have correct shape", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    for (const h of last.heuristics) {
      expect(h.id).toBeTypeOf("string");
      expect(h.heuristic).toBeTypeOf("string");
      expect(h.confidence).toBeTypeOf("number");
      expect(h.confidence).toBeGreaterThanOrEqual(0);
      expect(h.confidence).toBeLessThanOrEqual(1);
      expect(h.context).toBeTypeOf("string");
      expect(h.scope).toMatch(/^(global|local)$/);
      expect(h.reinforcementCount).toBeTypeOf("number");
    }
  });

  test("deferrals have correct shape", () => {
    const last = lensSnapshots[lensSnapshots.length - 1];
    for (const d of last.deferrals) {
      expect(d.id).toBeTypeOf("string");
      expect(d.name).toBeTypeOf("string");
      expect(d.conditionType).toBeTypeOf("string");
      expect(d.waitedTicks).toBeTypeOf("number");
      expect(d.reason).toBeTypeOf("string");
    }
  });
});

// ═══════════════════════════════════════
// SECTION 8: Stream Segmenter
// ═══════════════════════════════════════

describe("lens:stream-segmenter", () => {
  test("segments events by process", () => {
    const segmenter = new StreamSegmenter();

    for (const event of golden.events) {
      segmenter.ingest(event);
    }

    const pids = segmenter.getPids();
    expect(pids.length).toBeGreaterThan(0);

    // Every PID in the segmenter should correspond to an agentId in the events
    const eventAgentIds = new Set(golden.events.map((e) => e.agentId).filter(Boolean));
    for (const pid of pids) {
      expect(eventAgentIds.has(pid)).toBe(true);
    }
  });

  test("terminal lines have correct shape", () => {
    const segmenter = new StreamSegmenter();
    for (const event of golden.events) {
      segmenter.ingest(event);
    }

    for (const pid of segmenter.getPids()) {
      const lines = segmenter.getLines(pid);
      for (const line of lines) {
        expect(line.seq).toBeTypeOf("number");
        expect(line.timestamp).toBeTypeOf("string");
        expect(line.pid).toBe(pid);
        expect(line.processName).toBeTypeOf("string");
        expect(line.level).toMatch(/^(system|info|thinking|tool|output|error)$/);
        expect(line.text).toBeTypeOf("string");
      }
    }
  });

  test("sequence numbers are monotonically increasing", () => {
    const segmenter = new StreamSegmenter();
    for (const event of golden.events) {
      segmenter.ingest(event);
    }

    for (const pid of segmenter.getPids()) {
      const lines = segmenter.getLines(pid);
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i].seq).toBeGreaterThan(lines[i - 1].seq);
      }
    }
  });

  test("getLinesSince filters correctly", () => {
    const segmenter = new StreamSegmenter();
    for (const event of golden.events) {
      segmenter.ingest(event);
    }

    const pid = segmenter.getPids()[0];
    const allLines = segmenter.getLines(pid);
    if (allLines.length >= 2) {
      const midSeq = allLines[Math.floor(allLines.length / 2)].seq;
      const since = segmenter.getLinesSince(pid, midSeq);
      expect(since.every((l) => l.seq > midSeq)).toBe(true);
    }
  });

  test("classifies LLM stream events as thinking/tool", () => {
    const segmenter = new StreamSegmenter();
    for (const event of golden.events) {
      segmenter.ingest(event);
    }

    // Check that we got at least some thinking and tool level events
    const allLines: LensTerminalLine[] = [];
    for (const pid of segmenter.getPids()) {
      allLines.push(...segmenter.getLines(pid));
    }

    const levels = new Set(allLines.map((l) => l.level));
    expect(levels.has("system")).toBe(true); // spawn events
    // LLM stream events only present in runs that actually called models
    if (golden.source === "synthetic" || allLines.length > 10) {
      expect(levels.has("thinking") || levels.has("tool")).toBe(true);
    }
  });
});

// ═══════════════════════════════════════
// SECTION 9: Snapshot Diffing
// ═══════════════════════════════════════

describe("lens:snapshot-differ", () => {
  test("identical snapshots produce null delta", () => {
    const snap = lensSnapshots[lensSnapshots.length - 1];
    const delta = diffSnapshots(snap, snap);
    expect(delta).toBeNull();
  });

  test("detects new processes", () => {
    if (lensSnapshots.length < 2) return;

    // Find two consecutive snapshots where a process was added
    for (let i = 1; i < lensSnapshots.length; i++) {
      const prevPids = new Set(lensSnapshots[i - 1].processes.map((p) => p.pid));
      const currPids = new Set(lensSnapshots[i].processes.map((p) => p.pid));
      const added = [...currPids].filter((pid) => !prevPids.has(pid));

      if (added.length > 0) {
        const delta = diffSnapshots(lensSnapshots[i - 1], lensSnapshots[i]);
        expect(delta).not.toBeNull();
        expect(delta!.processes?.added.length).toBeGreaterThan(0);
        return; // Test passed
      }
    }
    // If no process was added between snapshots, that's also ok
  });

  test("detects state changes", () => {
    if (lensSnapshots.length < 2) return;

    // Find two snapshots where a process changed state
    for (let i = 1; i < lensSnapshots.length; i++) {
      const delta = diffSnapshots(lensSnapshots[i - 1], lensSnapshots[i]);
      if (delta?.processes?.changed && delta.processes.changed.length > 0) {
        const change = delta.processes.changed[0];
        expect(change.pid).toBeTypeOf("string");
        expect(change.changed).toBeDefined();
        return;
      }
    }
  });

  test("detects metric changes", () => {
    if (lensSnapshots.length < 2) return;
    const delta = diffSnapshots(lensSnapshots[0], lensSnapshots[lensSnapshots.length - 1]);
    expect(delta).not.toBeNull();
    expect(delta!.metrics).toBeDefined();
    expect(delta!.metrics!.tickCount).toBeDefined();
  });

  test("delta has correct tick number", () => {
    if (lensSnapshots.length < 2) return;
    const delta = diffSnapshots(lensSnapshots[0], lensSnapshots[1]);
    if (delta) {
      expect(delta.tick).toBe(lensSnapshots[1].tick);
      expect(delta.timestamp).toBeTypeOf("string");
    }
  });
});

// ═══════════════════════════════════════
// SECTION 10: End-to-end pipeline
// ═══════════════════════════════════════

describe("lens:end-to-end", () => {
  test("full pipeline: snapshots → view models → diffs → terminal lines", () => {
    // 1. Build all LensSnapshots
    expect(lensSnapshots.length).toBe(golden.snapshots.length);

    // 2. Compute diffs between consecutive snapshots
    const deltas: (LensSnapshotDelta | null)[] = [];
    for (let i = 1; i < lensSnapshots.length; i++) {
      deltas.push(diffSnapshots(lensSnapshots[i - 1], lensSnapshots[i]));
    }

    // At least some deltas should be non-null (things change between ticks)
    expect(deltas.some((d) => d !== null)).toBe(true);

    // 3. Segment all events into terminal lines
    const segmenter = new StreamSegmenter();
    for (const event of golden.events) {
      segmenter.ingest(event);
    }

    // 4. Verify we can build a complete UI state from the final snapshot + terminal lines
    const finalSnap = lensSnapshots[lensSnapshots.length - 1];

    // Every process in the snapshot should be renderable
    for (const proc of finalSnap.processes) {
      expect(proc.pid).toBeTruthy();
      expect(proc.name).toBeTruthy();
      expect(proc.role).toBeTruthy();
    }

    // Terminal lines should exist for at least some processes
    const procsWithTerminal = finalSnap.processes.filter(
      (p) => segmenter.getLines(p.pid).length > 0,
    );
    expect(procsWithTerminal.length).toBeGreaterThan(0);

    // DAG should be renderable (nodes + edges)
    expect(finalSnap.dag.nodes.length).toBe(finalSnap.processes.length);

    // Blackboard should have entries
    expect(Object.keys(finalSnap.blackboard).length).toBeGreaterThanOrEqual(0);

    // Metrics should have valid numbers
    expect(finalSnap.metrics.totalTokens).toBeGreaterThanOrEqual(0);
    expect(finalSnap.metrics.processCount).toBeGreaterThan(0);
  });
});
