/**
 * transition(state, event) → [state', effects]
 *
 * The pure, deterministic core of the cognitive kernel.
 * Total function — for every valid (state, event) pair, produces exactly
 * one (state', effects) pair. No exceptions, no I/O, no randomness.
 *
 * Phase 3: Handles boot and halt_check events.
 * Other events pass through as no-ops (strangler pattern — the kernel
 * class still handles them via its existing code paths).
 */

import type { KernelState } from "./state.js";
import type { KernelEvent, BootEvent, HaltCheckEvent } from "./events.js";
import type { KernelEffect, KernelEffectInput } from "./effects.js";
import type { OsProcess } from "../types.js";
import { randomUUID } from "node:crypto";

export type TransitionResult = readonly [KernelState, KernelEffect[]];

/**
 * Pure transition function.
 * Given current state and an event, returns new state and effects to execute.
 */
export function transition(state: KernelState, event: KernelEvent): TransitionResult {
  switch (event.type) {
    case "boot":
      return handleBoot(state, event);
    case "halt_check":
      return handleHaltCheck(state, event);
    default:
      // Unhandled events are no-ops — the kernel class still handles them
      // via its existing code paths (strangler pattern).
      return [state, []];
  }
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

function handleBoot(state: KernelState, event: BootEvent): TransitionResult {
  const effects: KernelEffectInput[] = [];
  const processes = new Map(state.processes);
  const blackboard = new Map(state.blackboard);

  // Spawn goal-orchestrator
  const orchestratorPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const orchestrator: OsProcess = {
    pid: orchestratorPid,
    type: "lifecycle",
    state: "running",
    name: "goal-orchestrator",
    parentPid: null,
    objective: event.goal,
    priority: 90,
    spawnedAt: now,
    lastActiveAt: now,
    tickCount: 0,
    tokensUsed: 0,
    model: state.config.kernel.processModel,
    workingDir: "/tmp",
    children: [],
    onParentDeath: "orphan",
    restartPolicy: "never",
  };
  processes.set(orchestratorPid, orchestrator);

  effects.push({
    type: "emit_protocol",
    action: "os_process_spawn",
    message: "boot goal-orchestrator",
  });

  effects.push({
    type: "submit_llm",
    pid: orchestratorPid,
    name: "goal-orchestrator",
    model: state.config.kernel.processModel,
  });

  // Spawn metacog-daemon
  const metacogPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const metacogDaemon: OsProcess = {
    pid: metacogPid,
    type: "daemon",
    state: "idle",
    name: "metacog-daemon",
    parentPid: null,
    objective: "Periodically evaluate system state and issue metacognitive commands",
    priority: 50,
    spawnedAt: now,
    lastActiveAt: now,
    tickCount: 0,
    tokensUsed: 0,
    model: state.config.kernel.metacogModel,
    workingDir: "/tmp",
    children: [],
    onParentDeath: "orphan",
    restartPolicy: "always",
  };
  processes.set(metacogPid, metacogDaemon);

  // Pre-seed design guidelines on blackboard
  blackboard.set("system:design-guidelines", {
    value: [
      "This system solves problems by spawning cognitive sub-processes.",
      "The topology (which processes exist, how they coordinate) IS the algorithm.",
      "Design the shape of the computation, then let processes execute it.",
      "Key primitives: spawn, kill, fork, join, checkpoint, restore.",
      "Blackboard is shared memory — write results there for other processes to read.",
      "Observation is mandatory: produce → observe → proceed. Never assume success.",
    ].join("\n"),
    writtenBy: "kernel",
    version: 1,
  });

  const newState: KernelState = {
    ...state,
    goal: event.goal,
    startTime: Date.now(),
    processes,
    blackboard,
  };

  return [newState, assignEffectSeqs(effects)];
}

function handleHaltCheck(state: KernelState, _event: HaltCheckEvent): TransitionResult {
  const effects: KernelEffectInput[] = [];

  // Already halted — no-op
  if (state.halted) {
    return [state, []];
  }

  const config = state.config.kernel;
  const now = Date.now();

  // 1. Wall-clock time exceeded (hard limit — ignores inflight)
  if (config.wallTimeLimitMs && state.startTime > 0) {
    const elapsed = now - state.startTime;
    if (elapsed >= config.wallTimeLimitMs) {
      return haltWith(state, "wall_time_exceeded", effects);
    }
  }

  // 2. Token budget exceeded (hard limit — ignores inflight)
  if (config.tokenBudget) {
    let totalTokens = 0;
    for (const proc of state.processes.values()) {
      totalTokens += proc.tokensUsed;
    }
    if (totalTokens >= config.tokenBudget) {
      return haltWith(state, "token_budget_exceeded", effects);
    }
  }

  // 3. Never halt while LLM calls or ephemerals are still in-flight
  //    (their results may spawn new processes — blocks soft conditions below)
  if (state.inflight.size > 0 || state.activeEphemeralCount > 0) {
    return [state, []];
  }

  // 4. Deferrals exist — don't halt (more work expected)
  if (state.deferrals.size > 0) {
    return [state, []];
  }

  // 5. All processes dead — halt
  const livingProcesses = [...state.processes.values()].filter(p => p.state !== "dead");
  if (livingProcesses.length === 0) {
    return haltWith(state, "all_processes_dead", effects);
  }

  // 6. Grace period: only daemons remain
  const goalProcesses = livingProcesses.filter(p => p.type !== "daemon");
  if (goalProcesses.length === 0) {
    const gracePeriodMs = config.goalCompleteGracePeriodMs ?? 30_000;

    if (state.goalWorkDoneAt === 0) {
      // Start grace period
      effects.push({
        type: "emit_protocol",
        action: "os_halt_grace_period",
        message: `only daemons remain — starting ${gracePeriodMs}ms grace period`,
      });
      return [{ ...state, goalWorkDoneAt: now }, assignEffectSeqs(effects)];
    }

    if (now - state.goalWorkDoneAt >= gracePeriodMs) {
      return haltWith(state, "goal_work_complete", effects);
    }

    // Still within grace period
    return [state, []];
  } else {
    // Lifecycle processes exist — reset grace period if it was active
    if (state.goalWorkDoneAt > 0) {
      effects.push({
        type: "emit_protocol",
        action: "os_halt_grace_period",
        message: "grace period canceled — lifecycle processes respawned",
      });
      return [{ ...state, goalWorkDoneAt: 0 }, assignEffectSeqs(effects)];
    }
  }

  return [state, []];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a halt state + halt effect. */
function haltWith(
  state: KernelState,
  reason: string,
  existingEffects: KernelEffectInput[],
): TransitionResult {
  const effects: KernelEffectInput[] = [
    ...existingEffects,
    { type: "halt", reason },
    { type: "emit_protocol", action: "os_halt", message: reason },
  ];
  return [
    { ...state, halted: true, haltReason: reason },
    assignEffectSeqs(effects),
  ];
}

/** Assign monotonic seq numbers to effect inputs. */
function assignEffectSeqs(inputs: KernelEffectInput[]): KernelEffect[] {
  return inputs.map((input, i) => ({ ...input, seq: i }) as KernelEffect);
}
