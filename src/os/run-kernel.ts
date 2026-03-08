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
import type { OsConfig } from "./types.js";
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
    { type: "schedule_timer", timer: "metacog", delayMs: config.kernel.metacogIntervalMs ?? 15_000, seq: 0 },
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
