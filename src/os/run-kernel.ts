/**
 * runKernel() — the pure kernel entry point.
 *
 * A ~30-line event loop that ties together:
 *   - EventQueue (async event delivery)
 *   - transition() (pure state machine)
 *   - KernelInterpreter (I/O execution)
 *
 * The loop: dequeue event → transition(state, event) → interpret effects → repeat.
 * Halts when state.halted is true.
 */

import { randomUUID } from "node:crypto";
import type { Brain } from "../types.js";
import type { OsConfig, OsSystemSnapshot } from "./types.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";
import type { ScopedMemoryStore } from "./scoped-memory-store.js";
import type { KernelState } from "./state-machine/state.js";
import type { KernelEvent } from "./state-machine/events.js";
import { initialState } from "./state-machine/state.js";
import { transition } from "./state-machine/transition.js";
import { EventQueue } from "./event-queue.js";
import { KernelInterpreter } from "./kernel-interpreter.js";

export async function runKernel(
  goal: string,
  config: OsConfig,
  brain: Brain,
  emitter: OsProtocolEmitter | null,
  options: {
    workingDir?: string;
    memoryStore?: ScopedMemoryStore | null;
    hasNewEpisodicData?: boolean;
    consolidatorObjective?: string;
    awarenessModel?: string;
  } = {},
): Promise<KernelState> {
  const workingDir = options.workingDir ?? process.cwd();
  const queue = new EventQueue();
  const interpreter = new KernelInterpreter(
    brain,
    emitter,
    queue,
    options.memoryStore ?? null,
    workingDir,
  );

  let state = initialState(config, randomUUID());
  let seq = 0;

  // Seed the boot event
  queue.enqueue({
    type: "boot",
    goal,
    workingDir,
    hasNewEpisodicData: options.hasNewEpisodicData ?? false,
    consolidatorObjective: options.consolidatorObjective,
    awarenessEnabled: config.awareness?.enabled ?? false,
    awarenessModel: options.awarenessModel ?? config.awareness?.model,
    timestamp: Date.now(),
    seq: seq++,
  } as KernelEvent);

  // Schedule initial wall-clock timers
  await interpreter.interpret(
    { type: "schedule_timer", timer: "metacog", delayMs: 5_000, seq: 0 },
    state,
  );
  await interpreter.interpret(
    { type: "schedule_timer", timer: "housekeep", delayMs: config.kernel.housekeepIntervalMs ?? 500, seq: 0 },
    state,
  );
  await interpreter.interpret(
    { type: "schedule_timer", timer: "snapshot", delayMs: config.kernel.snapshotIntervalMs ?? 10_000, seq: 0 },
    state,
  );

  // Emit boot protocol event
  emitter?.emit({ action: "os_boot", status: "started", message: `goal=${goal}` } as any);

  // ── The event loop ──────────────────────────────────────────────
  while (!state.halted) {
    const event = await queue.dequeue();

    // Stamp monotonic seq and timestamp
    (event as any).seq = seq++;
    if (!(event as any).timestamp) {
      (event as any).timestamp = Date.now();
    }

    const [newState, effects] = transition(state, event);
    state = newState;

    for (const effect of effects) {
      await interpreter.interpret(effect, state);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────
  interpreter.cleanup();

  // Emit halt protocol event
  emitter?.emit({
    action: "os_halt",
    status: "completed",
    message: `reason=${state.haltReason}`,
  } as any);

  return state;
}

/**
 * Convert KernelState to OsSystemSnapshot.
 *
 * This is the bridge between the pure state machine (which returns KernelState)
 * and the existing API surface (which expects OsSystemSnapshot). The conversion
 * is a pure data mapping — no I/O.
 */
export function stateToSnapshot(state: KernelState): OsSystemSnapshot {
  const allProcesses = Array.from(state.processes.values());
  const totalTokensUsed = allProcesses.reduce((sum, p) => sum + p.tokensUsed, 0);
  const activeProcessCount = allProcesses.filter((p) => p.state === "running").length;
  const stalledProcessCount = allProcesses.filter(
    (p) => p.state === "sleeping" || p.state === "idle",
  ).length;

  const blackboard: Record<string, unknown> = {};
  for (const [key, entry] of state.blackboard) {
    if (!key.startsWith("_inbox:")) {
      blackboard[key] = entry.value;
    }
  }

  return {
    runId: state.runId,
    tickCount: state.tickCount,
    goal: state.goal,
    processes: allProcesses,
    dagTopology: state.dagTopology,
    dagMetrics: {
      nodeCount: state.dagTopology.nodes.length,
      edgeCount: state.dagTopology.edges.length,
      maxDepth: 0,
      runningCount: activeProcessCount,
      stalledCount: stalledProcessCount,
      deadCount: 0,
    },
    ipcSummary: {
      signalCount: 0,
      blackboardKeyCount: state.blackboard.size,
    },
    progressMetrics: {
      activeProcessCount,
      stalledProcessCount,
      totalTokensUsed,
      tokenBudgetRemaining: state.config.kernel.tokenBudget - totalTokensUsed,
      wallTimeElapsedMs: Date.now() - state.startTime,
      tickCount: state.tickCount,
    },
    recentEvents: [],
    recentHeuristics: state.schedulerHeuristics.slice(0, 10),
    blackboard,
  };
}
