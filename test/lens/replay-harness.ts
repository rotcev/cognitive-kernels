/**
 * Replay Harness — loads golden run fixtures and replays them through
 * the Lens pipeline in deterministic order.
 *
 * If golden run fixtures don't exist yet, provides synthetic fixtures
 * that exercise every code path the Lens needs.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeProtocolEvent } from "../../src/types.js";
import type { OsSystemSnapshot, OsProcess, OsDagTopology, OsDagMetrics, OsProgressMetrics, OsIpcSummary, OsHeuristic } from "../../src/os/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname ?? ".", "../fixtures/golden-run");

export interface GoldenRun {
  events: RuntimeProtocolEvent[];
  snapshots: OsSystemSnapshot[];
  manifest: GoldenRunManifest | null;
  source: "real" | "synthetic";
}

export interface GoldenRunManifest {
  capturedAt: string;
  goal: string;
  runId: string;
  totalTicks: number;
  processCount: number;
  eventCount: number;
  snapshotCount: number;
}

/**
 * Load the golden run fixtures. Falls back to synthetic data if
 * the real capture hasn't been run yet.
 */
export function loadGoldenRun(): GoldenRun {
  const manifestPath = path.join(FIXTURES_DIR, "manifest.json");

  if (existsSync(manifestPath)) {
    return loadRealFixtures();
  }

  return buildSyntheticFixtures();
}

function loadRealFixtures(): GoldenRun {
  const manifest: GoldenRunManifest = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8"),
  );

  const events = readFileSync(path.join(FIXTURES_DIR, "protocol.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeProtocolEvent);

  const snapshots = readFileSync(path.join(FIXTURES_DIR, "snapshots.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OsSystemSnapshot);

  return { events, snapshots, manifest, source: "real" };
}

// ── Synthetic Fixtures ────────────────────────────────────────────
//
// A hand-crafted realistic run that exercises every Lens code path:
// - 6 processes spanning all roles (daemon, sub-kernel, shells)
// - All states: running, sleeping, checkpoint, dead
// - Parent-child and dependency edges
// - Blackboard reads and writes
// - Heuristics and deferrals
// - Multiple ticks with state transitions

function buildSyntheticFixtures(): GoldenRun {
  const runId = "golden-synthetic-001";
  const baseTime = new Date("2026-03-06T10:00:00.000Z").getTime();
  const t = (offsetMs: number) => new Date(baseTime + offsetMs).toISOString();

  // ── Processes at tick 5 ──
  const processes: OsProcess[] = [
    makeProc({ pid: "p-metacog", name: "metacog", type: "daemon", state: "running", parentPid: null, children: ["p-orchestrator"], priority: 100, tickCount: 5, tokensUsed: 1200, tokenBudget: 50000, spawnedAt: t(0), lastActiveAt: t(10000), objective: "Orchestrate email validation implementation" }),
    makeProc({ pid: "p-orchestrator", name: "orchestrator", type: "lifecycle", state: "running", parentPid: "p-metacog", children: ["p-architect", "p-implementer", "p-tester"], priority: 90, tickCount: 5, tokensUsed: 3500, tokenBudget: 30000, spawnedAt: t(500), lastActiveAt: t(10000), objective: "Coordinate implementation of email validator" }),
    makeProc({ pid: "p-architect", name: "architect", type: "lifecycle", state: "dead", parentPid: "p-orchestrator", children: [], priority: 85, tickCount: 3, tokensUsed: 2100, spawnedAt: t(1000), lastActiveAt: t(6000), objective: "Design email validation architecture", exitCode: 0, exitReason: "Design committed to blackboard", blackboardKeysWritten: ["email.architecture", "email.regex_pattern"] }),
    makeProc({ pid: "p-implementer", name: "implementer", type: "lifecycle", state: "running", parentPid: "p-orchestrator", children: ["p-validator"], priority: 80, tickCount: 4, tokensUsed: 4200, tokenBudget: 15000, spawnedAt: t(2000), lastActiveAt: t(10000), objective: "Implement email validation based on architecture", blackboardKeysWritten: ["email.impl_status"] }),
    makeProc({ pid: "p-validator", name: "validator", type: "lifecycle", state: "checkpoint", parentPid: "p-implementer", children: [], priority: 75, tickCount: 2, tokensUsed: 1800, tokenBudget: 8000, spawnedAt: t(4000), lastActiveAt: t(8000), objective: "Validate regex patterns against edge cases", checkpoint: { pid: "p-validator", capturedAt: t(8000), conversationSummary: "Paused for test writer to verify", pendingObjectives: ["Run edge case tests"], artifacts: {} } }),
    makeProc({ pid: "p-tester", name: "test-writer", type: "lifecycle", state: "sleeping", parentPid: "p-orchestrator", children: [], priority: 70, tickCount: 1, tokensUsed: 800, tokenBudget: 10000, spawnedAt: t(3000), lastActiveAt: t(5000), objective: "Write unit tests for email validator", wakeOnSignals: ["email.impl_status"] }),
  ];

  const dagTopology: OsDagTopology = {
    nodes: processes.map(p => ({ pid: p.pid, name: p.name, type: p.type, state: p.state, priority: p.priority, parentPid: p.parentPid })),
    edges: [
      { from: "p-metacog", to: "p-orchestrator", relation: "parent-child" },
      { from: "p-orchestrator", to: "p-architect", relation: "parent-child" },
      { from: "p-orchestrator", to: "p-implementer", relation: "parent-child" },
      { from: "p-orchestrator", to: "p-tester", relation: "parent-child" },
      { from: "p-implementer", to: "p-validator", relation: "parent-child" },
      { from: "p-architect", to: "p-implementer", relation: "dependency", label: "architecture design" },
      { from: "p-validator", to: "p-tester", relation: "dependency", label: "validation results" },
    ],
  };

  const dagMetrics: OsDagMetrics = {
    nodeCount: 6, edgeCount: 7, maxDepth: 3, runningCount: 2, stalledCount: 1, deadCount: 1,
  };

  const ipcSummary: OsIpcSummary = { signalCount: 3, blackboardKeyCount: 3 };

  const progressMetrics: OsProgressMetrics = {
    activeProcessCount: 2, stalledProcessCount: 2, totalTokensUsed: 13600,
    tokenBudgetRemaining: 86400, wallTimeElapsedMs: 10000, tickCount: 5,
  };

  const heuristics: OsHeuristic[] = [
    { id: "h-1", heuristic: "Spawn architect before implementer to establish design constraints", confidence: 0.85, context: "implementation tasks", learnedAt: t(0), reinforcedAt: t(6000), reinforcementCount: 2, source: { runId }, scope: "global" },
  ];

  const blackboard: Record<string, unknown> = {
    "email.architecture": { strategy: "regex", layers: ["syntax", "domain", "mx"] },
    "email.regex_pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
    "email.impl_status": "in_progress",
  };

  const deferrals = [
    { id: "d-1", name: "test-writer", condition: { type: "blackboard_key_match", key: "email.impl_status", value: "complete" }, waitedTicks: 4, reason: "Waiting for implementation to complete" },
  ];

  // Build snapshots for ticks 1-5 (progressive)
  const snapshots: OsSystemSnapshot[] = [];

  // Tick 1: just metacog + orchestrator
  snapshots.push(makeSnapshot(runId, 1, "Implement email validation with unit tests", processes.slice(0, 2), t(2000)));

  // Tick 2: architect + tester spawned
  snapshots.push(makeSnapshot(runId, 2, "Implement email validation with unit tests", processes.slice(0, 4).concat(processes[5]), t(4000)));

  // Tick 3: architect dies, implementer spawns validator
  const tick3Procs = processes.map(p => {
    if (p.pid === "p-architect") return { ...p, state: "dead" as const, exitCode: 0 };
    if (p.pid === "p-validator") return undefined; // not yet spawned
    return p;
  }).filter(Boolean) as OsProcess[];
  snapshots.push(makeSnapshot(runId, 3, "Implement email validation with unit tests", tick3Procs, t(6000)));

  // Tick 4: validator spawned
  snapshots.push(makeSnapshot(runId, 4, "Implement email validation with unit tests", processes.filter(p => p.pid !== "p-tester").concat(processes[5]), t(8000)));

  // Tick 5: full state with blackboard, heuristics, deferrals
  snapshots.push({
    runId,
    tickCount: 5,
    goal: "Implement email validation with unit tests",
    processes,
    dagTopology,
    dagMetrics,
    ipcSummary,
    progressMetrics,
    recentEvents: [],
    recentHeuristics: heuristics,
    blackboard,
    deferrals,
  });

  // ── Protocol Events ──
  const events: RuntimeProtocolEvent[] = [
    { action: "os_boot", status: "completed", timestamp: t(0), message: "Kernel booted", eventSource: "os" },
    { action: "os_process_spawn", status: "completed", timestamp: t(0), agentId: "p-metacog", agentName: "metacog", message: "Spawned metacog (daemon)", eventSource: "os" },
    { action: "os_process_spawn", status: "completed", timestamp: t(500), agentId: "p-orchestrator", agentName: "orchestrator", message: "Spawned orchestrator (lifecycle)", eventSource: "os" },
    { action: "os_tick", status: "completed", timestamp: t(1000), message: "tick=1 active=2", eventSource: "os" },
    { action: "os_process_spawn", status: "completed", timestamp: t(1000), agentId: "p-architect", agentName: "architect", message: "Spawned architect (lifecycle)", eventSource: "os" },
    { action: "os_llm_stream", status: "started", timestamp: t(1500), agentId: "p-architect", agentName: "architect", message: JSON.stringify({ type: "text_delta", text: "Designing email validation..." }), eventSource: "os" },
    { action: "os_llm_stream", status: "started", timestamp: t(2000), agentId: "p-architect", agentName: "architect", message: JSON.stringify({ type: "tool_started", toolName: "write_blackboard", toolUseId: "t-1", provider: "claude" }), eventSource: "os" },
    { action: "os_command", status: "completed", timestamp: t(2500), agentId: "p-architect", agentName: "architect", message: "write_blackboard: email.architecture", eventSource: "os" },
    { action: "os_process_spawn", status: "completed", timestamp: t(3000), agentId: "p-tester", agentName: "test-writer", message: "Spawned test-writer (lifecycle)", eventSource: "os" },
    { action: "os_tick", status: "completed", timestamp: t(3000), message: "tick=2 active=3 sleeping=1", eventSource: "os" },
    { action: "os_command", status: "completed", timestamp: t(3500), agentId: "p-architect", agentName: "architect", message: "write_blackboard: email.regex_pattern", eventSource: "os" },
    { action: "os_process_spawn", status: "completed", timestamp: t(4000), agentId: "p-implementer", agentName: "implementer", message: "Spawned implementer (lifecycle)", eventSource: "os" },
    { action: "os_process_exit", status: "completed", timestamp: t(5000), agentId: "p-architect", agentName: "architect", message: "Process exited with code 0", eventSource: "os" },
    { action: "os_tick", status: "completed", timestamp: t(5000), message: "tick=3 active=2 sleeping=1 dead=1", eventSource: "os" },
    { action: "os_process_spawn", status: "completed", timestamp: t(5500), agentId: "p-validator", agentName: "validator", message: "Spawned validator (lifecycle)", eventSource: "os" },
    { action: "os_llm_stream", status: "started", timestamp: t(6000), agentId: "p-implementer", agentName: "implementer", message: JSON.stringify({ type: "text_delta", text: "Implementing email validation function..." }), eventSource: "os" },
    { action: "os_llm_stream", status: "started", timestamp: t(6500), agentId: "p-implementer", agentName: "implementer", message: JSON.stringify({ type: "tool_started", toolName: "edit_file", toolUseId: "t-2", provider: "claude" }), eventSource: "os" },
    { action: "os_llm_stream", status: "started", timestamp: t(7000), agentId: "p-implementer", agentName: "implementer", message: JSON.stringify({ type: "tool_completed", toolName: "edit_file", toolUseId: "t-2", provider: "claude", resultSummary: "Created src/validate-email.ts" }), eventSource: "os" },
    { action: "os_tick", status: "completed", timestamp: t(7000), message: "tick=4 active=3 sleeping=1 dead=1", eventSource: "os" },
    { action: "os_process_checkpoint", status: "completed", timestamp: t(8000), agentId: "p-validator", agentName: "validator", message: "Checkpoint: waiting for test-writer to verify", eventSource: "os" },
    { action: "os_command", status: "completed", timestamp: t(8500), agentId: "p-implementer", agentName: "implementer", message: "write_blackboard: email.impl_status = in_progress", eventSource: "os" },
    { action: "os_llm_stream", status: "started", timestamp: t(9000), agentId: "p-metacog", agentName: "metacog", message: JSON.stringify({ type: "text_delta", text: "Implementation progressing. Validator checkpointed." }), eventSource: "os" },
    { action: "os_llm_stream", status: "started", timestamp: t(9500), agentId: "p-implementer", agentName: "implementer", message: JSON.stringify({ type: "usage", usage: { inputTokens: 2000, outputTokens: 1500, totalCostUsd: 0.012, durationMs: 3000, numTurns: 1 } }), eventSource: "os" },
    { action: "os_tick", status: "completed", timestamp: t(10000), message: "tick=5 active=2 sleeping=1 checkpoint=1 dead=1", eventSource: "os" },
  ];

  return { events, snapshots, manifest: null, source: "synthetic" };
}

// ── Helpers ────────────────────────────────────────────────────────

function makeProc(overrides: Partial<OsProcess> & { pid: string; name: string; objective: string }): OsProcess {
  return {
    type: "lifecycle",
    state: "running",
    parentPid: null,
    priority: 50,
    spawnedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    tickCount: 0,
    tokensUsed: 0,
    model: "claude-sonnet-4-20250514",
    workingDir: "/tmp",
    children: [],
    onParentDeath: "orphan",
    restartPolicy: "never",
    ...overrides,
  } as OsProcess;
}

function makeSnapshot(
  runId: string,
  tick: number,
  goal: string,
  processes: OsProcess[],
  timestamp: string,
): OsSystemSnapshot {
  return {
    runId,
    tickCount: tick,
    goal,
    processes,
    dagTopology: {
      nodes: processes.map(p => ({ pid: p.pid, name: p.name, type: p.type, state: p.state, priority: p.priority, parentPid: p.parentPid })),
      edges: buildEdgesFromProcesses(processes),
    },
    dagMetrics: {
      nodeCount: processes.length,
      edgeCount: buildEdgesFromProcesses(processes).length,
      maxDepth: 2,
      runningCount: processes.filter(p => p.state === "running").length,
      stalledCount: processes.filter(p => p.state === "sleeping" || p.state === "idle").length,
      deadCount: processes.filter(p => p.state === "dead").length,
    },
    ipcSummary: { signalCount: 0, blackboardKeyCount: 0 },
    progressMetrics: {
      activeProcessCount: processes.filter(p => p.state === "running").length,
      stalledProcessCount: processes.filter(p => p.state === "sleeping").length,
      totalTokensUsed: processes.reduce((s, p) => s + p.tokensUsed, 0),
      wallTimeElapsedMs: new Date(timestamp).getTime() - new Date("2026-03-06T10:00:00.000Z").getTime(),
      tickCount: tick,
    },
    recentEvents: [],
    recentHeuristics: [],
  };
}

function buildEdgesFromProcesses(processes: OsProcess[]): Array<{ from: string; to: string; relation: "parent-child" | "dependency" }> {
  const edges: Array<{ from: string; to: string; relation: "parent-child" }> = [];
  for (const proc of processes) {
    if (proc.parentPid && processes.some(p => p.pid === proc.parentPid)) {
      edges.push({ from: proc.parentPid, to: proc.pid, relation: "parent-child" });
    }
  }
  return edges;
}
