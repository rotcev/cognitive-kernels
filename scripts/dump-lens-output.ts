/**
 * Dumps the full Lens output from golden run fixtures in a human-readable format.
 * Shows exactly what data the UI would receive from the Lens pipeline.
 */

import { loadGoldenRun } from "../test/lens/replay-harness.js";
import { buildLensSnapshot } from "../src/lens/view-models.js";
import { StreamSegmenter } from "../src/lens/stream-segmenter.js";
import { diffSnapshots } from "../src/lens/snapshot-differ.js";
import type { LensSnapshot, LensTerminalLine, LensSnapshotDelta } from "../src/lens/types.js";

const golden = loadGoldenRun();
const sep = "=".repeat(70);

// Build all snapshots
const lensSnapshots: LensSnapshot[] = [];
let prevTokens: { total: number; timestamp: number } | undefined;
for (const snap of golden.snapshots) {
  const lens = buildLensSnapshot(snap, prevTokens);
  lensSnapshots.push(lens);
  prevTokens = { total: snap.progressMetrics.totalTokensUsed, timestamp: Date.now() };
}

const final = lensSnapshots[lensSnapshots.length - 1];

console.log(sep);
console.log("  LENS OUTPUT -- What the UI receives from the golden run");
console.log(sep);
console.log();

// 1. Snapshot Overview
console.log("+---------------------------------------------------------------------+");
console.log("|  1. SNAPSHOT OVERVIEW                                               |");
console.log("+---------------------------------------------------------------------+");
console.log(`  Run ID:     ${final.runId}`);
console.log(`  Goal:       ${final.goal.slice(0, 80)}`);
console.log(`  Tick:       ${final.tick}`);
console.log(`  Elapsed:    ${final.elapsed}ms`);
console.log(`  Source:     ${golden.source} fixtures (${golden.snapshots.length} snapshots, ${golden.events.length} events)`);
console.log();

// 2. Processes
console.log("+---------------------------------------------------------------------+");
console.log("|  2. PROCESSES                                                       |");
console.log("+---------------------------------------------------------------------+");
for (const p of final.processes) {
  const badge = p.role === "kernel" ? "[KERNEL]" : p.role === "sub-kernel" ? "[SUB-KERNEL]" : "[SHELL]";
  console.log(`  ${badge}  ${p.name}`);
  console.log(`    pid:       ${p.pid}`);
  console.log(`    state:     ${p.state}`);
  console.log(`    type:      ${p.type}`);
  console.log(`    model:     ${p.model}`);
  console.log(`    tokens:    ${p.tokensUsed}${p.tokenBudget ? "/" + p.tokenBudget : ""}`);
  console.log(`    priority:  ${p.priority}`);
  console.log(`    ticks:     ${p.tickCount}`);
  console.log(`    objective: ${p.objective.slice(0, 80)}${p.objective.length > 80 ? "..." : ""}`);
  if (p.children.length) console.log(`    children:  ${p.children.join(", ")}`);
  if (p.selfReports.length) console.log(`    reports:   ${p.selfReports.map(r => r.slice(0, 60)).join("; ")}`);
  if (p.blackboardIO.length) {
    console.log(`    bb I/O:`);
    for (const io of p.blackboardIO) {
      console.log(`      ${io.direction === "write" ? "WRITE" : "READ "}  ${io.key} -> ${io.valuePreview}`);
    }
  }
  console.log();
}

// 3. DAG
console.log("+---------------------------------------------------------------------+");
console.log("|  3. DAG TOPOLOGY                                                    |");
console.log("+---------------------------------------------------------------------+");
console.log(`  Nodes: ${final.dag.nodes.length}`);
for (const n of final.dag.nodes) {
  console.log(`    [${n.role}] ${n.name} (${n.state})`);
}
console.log(`  Edges: ${final.dag.edges.length}`);
for (const e of final.dag.edges) {
  const fromName = final.dag.nodes.find(n => n.pid === e.from)?.name ?? e.from;
  const toName = final.dag.nodes.find(n => n.pid === e.to)?.name ?? e.to;
  console.log(`    ${fromName} --${e.relation}--> ${toName}`);
}
console.log();

// 4. Blackboard
console.log("+---------------------------------------------------------------------+");
console.log("|  4. BLACKBOARD                                                      |");
console.log("+---------------------------------------------------------------------+");
for (const [key, entry] of Object.entries(final.blackboard)) {
  console.log(`  [${key}]`);
  console.log(`     writer:  ${entry.writer}`);
  console.log(`     readBy:  ${entry.readBy.length ? entry.readBy.join(", ") : "(none)"}`);
  const val = typeof entry.value === "string" ? entry.value.slice(0, 120) : JSON.stringify(entry.value).slice(0, 120);
  console.log(`     value:   ${val}${val.length >= 120 ? "..." : ""}`);
  console.log();
}

// 5. Metrics
console.log("+---------------------------------------------------------------------+");
console.log("|  5. METRICS                                                         |");
console.log("+---------------------------------------------------------------------+");
const m = final.metrics;
console.log(`  Total tokens:     ${m.totalTokens}`);
console.log(`  Token rate:       ${m.tokenRate.toFixed(1)} tok/s`);
console.log(`  Process count:    ${m.processCount}`);
console.log(`  Running:          ${m.runningCount}`);
console.log(`  Sleeping:         ${m.sleepingCount}`);
console.log(`  Dead:             ${m.deadCount}`);
console.log(`  Checkpointed:     ${m.checkpointedCount}`);
console.log(`  Suspended:        ${m.suspendedCount}`);
console.log(`  DAG depth:        ${m.dagDepth}`);
console.log(`  DAG edges:        ${m.dagEdgeCount}`);
console.log(`  Wall time:        ${(m.wallTimeElapsedMs / 1000).toFixed(1)}s`);
console.log(`  Tick count:       ${m.tickCount}`);
console.log();

// 6. Heuristics
console.log("+---------------------------------------------------------------------+");
console.log("|  6. HEURISTICS (learned knowledge)                                  |");
console.log("+---------------------------------------------------------------------+");
if (final.heuristics.length === 0) {
  console.log("  (none)");
} else {
  for (const h of final.heuristics.slice(0, 5)) {
    console.log(`  [${h.scope}] conf=${h.confidence.toFixed(2)} reinforced=${h.reinforcementCount}x`);
    console.log(`     ${h.heuristic.slice(0, 90)}${h.heuristic.length > 90 ? "..." : ""}`);
    console.log();
  }
  if (final.heuristics.length > 5) {
    console.log(`  ... and ${final.heuristics.length - 5} more heuristics`);
  }
}
console.log();

// 7. Deferrals
console.log("+---------------------------------------------------------------------+");
console.log("|  7. DEFERRALS (pending work)                                        |");
console.log("+---------------------------------------------------------------------+");
if (final.deferrals.length === 0) {
  console.log("  (none)");
} else {
  for (const d of final.deferrals) {
    console.log(`  ${d.name} -- ${d.conditionType}, waited ${d.waitedTicks} ticks`);
    console.log(`     ${d.reason}`);
  }
}
console.log();

// 8. Terminal Lines
console.log("+---------------------------------------------------------------------+");
console.log("|  8. TERMINAL LINES (per-process stream)                             |");
console.log("+---------------------------------------------------------------------+");
const seg = new StreamSegmenter();
for (const ev of golden.events) seg.ingest(ev);

for (const pid of seg.getPids()) {
  const lines = seg.getLines(pid);
  const procName = lines[0]?.processName ?? pid;
  console.log(`  -- ${procName} (${lines.length} lines) --`);
  for (const line of lines.slice(0, 8)) {
    const levelIcon: Record<string, string> = { system: "SYS", info: "INF", thinking: "THK", tool: "TUL", output: "OUT", error: "ERR" };
    console.log(`    [${(levelIcon[line.level] ?? line.level).padEnd(3)}] ${line.text.slice(0, 80)}${line.text.length > 80 ? "..." : ""}`);
  }
  if (lines.length > 8) console.log(`    ... ${lines.length - 8} more lines`);
  console.log();
}

// 9. Snapshot Diffs
console.log("+---------------------------------------------------------------------+");
console.log("|  9. SNAPSHOT DIFFS (what changes between ticks)                      |");
console.log("+---------------------------------------------------------------------+");
for (let i = 1; i < lensSnapshots.length; i++) {
  const delta = diffSnapshots(lensSnapshots[i - 1], lensSnapshots[i]);
  if (!delta) {
    console.log(`  tick ${lensSnapshots[i - 1].tick} -> ${lensSnapshots[i].tick}: (no changes)`);
    continue;
  }
  console.log(`  tick ${lensSnapshots[i - 1].tick} -> ${delta.tick}:`);
  if (delta.processes) {
    if (delta.processes.added.length) console.log(`    + ${delta.processes.added.length} processes added: ${delta.processes.added.map(p => p.name).join(", ")}`);
    if (delta.processes.removed.length) console.log(`    - ${delta.processes.removed.length} processes removed`);
    if (delta.processes.changed.length) {
      for (const c of delta.processes.changed) {
        const name = final.processes.find(p => p.pid === c.pid)?.name ?? c.pid;
        const fields = Object.keys(c.changed);
        console.log(`    ~ ${name}: ${fields.join(", ")} changed`);
      }
    }
  }
  if (delta.blackboard) {
    if (delta.blackboard.updated.length) console.log(`    BB updated: ${delta.blackboard.updated.map(e => e.key).join(", ")}`);
    if (delta.blackboard.removed.length) console.log(`    BB removed: ${delta.blackboard.removed.join(", ")}`);
  }
  if (delta.metrics) {
    const mkeys = Object.keys(delta.metrics);
    console.log(`    Metrics changed: ${mkeys.join(", ")}`);
  }
  console.log();
}

console.log(sep);
console.log(`  Total: ${lensSnapshots.length} snapshots, ${final.processes.length} processes, ${Object.keys(final.blackboard).length} bb keys, ${final.heuristics.length} heuristics, ${seg.getPids().length} terminal streams`);
console.log(sep);
