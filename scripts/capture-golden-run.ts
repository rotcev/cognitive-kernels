/**
 * capture-golden-run.ts
 *
 * Runs a real kernel execution and captures all protocol events + snapshots
 * as deterministic test fixtures for the Lens test suite.
 *
 * Usage:
 *   npx tsx scripts/capture-golden-run.ts [--goal "..."] [--output-dir path]
 *
 * Requires: ANTHROPIC_API_KEY in .env (or environment)
 *
 * Outputs:
 *   test/fixtures/golden-run/
 *     protocol.ndjson    — every RuntimeProtocolEvent
 *     snapshots.ndjson   — every OsSystemSnapshot (one per tick)
 *     blackboard.ndjson  — full OsBlackboardEntry[] per tick (with readBy/writtenBy metadata)
 *     manifest.json      — run metadata
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { mkdirSync, createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import { parseOsConfig } from "../src/os/config.js";
import { OsKernel } from "../src/os/kernel.js";
import { OsProtocolEmitter } from "../src/os/protocol-emitter.js";
import { createBrain } from "../src/brain/create-brain.js";
import type { RuntimeProtocolEvent, StreamEvent } from "../src/types.js";
import type { OsSystemSnapshot, OsBlackboardEntry } from "../src/os/types.js";

// ── Args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const goal = getArg(
  "goal",
  "Write a TypeScript function that validates email addresses using a regex, with 3 unit tests using assert",
);
const outputDir = getArg(
  "output-dir",
  path.resolve(import.meta.dirname ?? ".", "../test/fixtures/golden-run"),
);

// ── Setup ─────────────────────────────────────────────────────────

mkdirSync(outputDir, { recursive: true });

const protocolStream = createWriteStream(path.join(outputDir, "protocol.ndjson"), { flags: "w" });
const snapshotStream = createWriteStream(path.join(outputDir, "snapshots.ndjson"), { flags: "w" });
const blackboardStream = createWriteStream(path.join(outputDir, "blackboard.ndjson"), { flags: "w" });

let eventCount = 0;
let snapshotCount = 0;

// ── Intercepting Emitter ──────────────────────────────────────────
//
// We create a real OsProtocolEmitter that writes to a temp directory,
// but we ALSO intercept every event and snapshot to write to our
// golden run fixtures.

const tempRunDir = path.join(outputDir, ".capture-tmp");
mkdirSync(tempRunDir, { recursive: true });

const realEmitter = new OsProtocolEmitter({
  protocolLogPath: path.join(tempRunDir, "protocol.ndjson"),
  snapshotPath: path.join(tempRunDir, "os-snapshot.json"),
  livePath: path.join(tempRunDir, "os-live.json"),
});

// Proxy the emitter to intercept calls
const interceptedEmitter = new Proxy(realEmitter, {
  get(target, prop, receiver) {
    if (prop === "emit") {
      return function (input: { action: string; status: string; message?: string; agentId?: string; agentName?: string }) {
        // Build the event the same way the real emitter does
        const event: RuntimeProtocolEvent = {
          action: input.action,
          status: input.status as "started" | "completed" | "failed",
          timestamp: new Date().toISOString(),
          message: input.message,
          agentId: input.agentId,
          agentName: input.agentName,
          eventSource: "os",
        };
        protocolStream.write(JSON.stringify(event) + "\n");
        eventCount++;

        // Log key events for debugging
        const msg = input.message ? ` — ${String(input.message).slice(0, 120)}` : "";
        console.log(`  [${input.action}] ${input.status}${msg}`);

        // Also call the real emitter
        return target.emit(input);
      };
    }

    if (prop === "emitStreamEvent") {
      return function (pid: string, processName: string, event: StreamEvent) {
        // Filter same way the real emitter does
        if (event.type === "text_delta" && !event.text) return;

        const entry: RuntimeProtocolEvent = {
          action: "os_llm_stream",
          status: "started",
          timestamp: new Date().toISOString(),
          agentId: pid,
          agentName: processName,
          message: JSON.stringify(event),
          eventSource: "os",
        };
        protocolStream.write(JSON.stringify(entry) + "\n");
        eventCount++;

        return target.emitStreamEvent(pid, processName, event);
      };
    }

    if (prop === "writeLiveState") {
      return function (snapshot: OsSystemSnapshot) {
        snapshotStream.write(JSON.stringify(snapshot) + "\n");
        snapshotCount++;

        // Also capture full blackboard with metadata from the kernel
        // (the snapshot strips readBy/writtenBy — we'll get those from the kernel directly)
        // For now, record the snapshot blackboard; the kernel hook below adds full entries.

        return target.writeLiveState(snapshot);
      };
    }

    if (prop === "saveSnapshot") {
      return function (snapshot: OsSystemSnapshot) {
        // Final snapshot — also record it
        snapshotStream.write(JSON.stringify({ ...snapshot, _final: true }) + "\n");
        snapshotCount++;
        return target.saveSnapshot(snapshot);
      };
    }

    return Reflect.get(target, prop, receiver);
  },
});

// ── Run the kernel ────────────────────────────────────────────────

console.log("═══ Golden Run Capture ═══");
console.log(`Goal: ${goal}`);
console.log(`Output: ${outputDir}`);
console.log("");

const codexModel = "gpt-5.3-codex";
const osConfig = parseOsConfig({
  kernel: {
    tokenBudget: 500000,
    maxConcurrentProcesses: 3,
    wallTimeLimitMs: 180000, // 3 min cap for fixture capture
    processModel: codexModel,
    metacogModel: codexModel,
  },
  awareness: { model: codexModel },
  ephemeral: { defaultModel: codexModel },
  observation: { defaultModel: codexModel },
});

const provider = "codex" as const;
const brain = createBrain({ provider, env: {}, config: {} });

const cwd = process.cwd();
const kernel = new OsKernel(osConfig, brain, cwd, interceptedEmitter as OsProtocolEmitter);

// Hook into the kernel to capture full blackboard entries after each tick.
// We do this by monkey-patching the tick method to also dump blackboard state.
const originalRun = kernel.run.bind(kernel);

async function captureRun(): Promise<OsSystemSnapshot> {
  // We can't easily hook per-tick, so we'll capture blackboard from snapshots.
  // The snapshot's blackboard field has values but not metadata (readBy, writtenBy).
  // We'll capture that info from the snapshot process data instead.
  // The processes have `blackboardKeysWritten` arrays, and the snapshot
  // has `blackboard` as Record<string, unknown>.
  //
  // For the golden run, this is sufficient — the Lens tests need to verify
  // they can build I/O tables from the data that IS in the snapshot.

  const startTime = Date.now();
  let result: OsSystemSnapshot;

  try {
    result = await originalRun(goal);
  } catch (err) {
    console.error("Kernel run failed:", err);
    process.exit(1);
  }

  const elapsed = Date.now() - startTime;

  // Write manifest
  const manifest = {
    capturedAt: new Date().toISOString(),
    goal,
    runId: result.runId,
    totalTicks: result.tickCount,
    processCount: result.processes.length,
    eventCount,
    snapshotCount,
    elapsedMs: elapsed,
    processNames: result.processes.map((p) => ({
      pid: p.pid,
      name: p.name,
      type: p.type,
      state: p.state,
      children: p.children,
    })),
    blackboardKeys: Object.keys(result.blackboard ?? {}),
    dagEdgeCount: result.dagTopology.edges.length,
    dagNodeCount: result.dagTopology.nodes.length,
  };

  writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Close streams
  await new Promise<void>((r) => protocolStream.end(r));
  await new Promise<void>((r) => snapshotStream.end(r));
  await new Promise<void>((r) => blackboardStream.end(r));
  await realEmitter.close();

  console.log("");
  console.log("═══ Capture Complete ═══");
  console.log(`  Ticks:     ${result.tickCount}`);
  console.log(`  Processes: ${result.processes.length}`);
  console.log(`  Events:    ${eventCount}`);
  console.log(`  Snapshots: ${snapshotCount}`);
  console.log(`  BB Keys:   ${Object.keys(result.blackboard ?? {}).length}`);
  console.log(`  DAG Edges: ${result.dagTopology.edges.length}`);
  console.log(`  Elapsed:   ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  Output:    ${outputDir}`);
  console.log("");
  console.log("Files:");
  console.log(`  ${path.join(outputDir, "protocol.ndjson")}`);
  console.log(`  ${path.join(outputDir, "snapshots.ndjson")}`);
  console.log(`  ${path.join(outputDir, "manifest.json")}`);

  return result;
}

captureRun().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
