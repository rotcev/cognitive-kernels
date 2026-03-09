/**
 * transition(state, event) → [state', effects]
 *
 * The pure, deterministic core of the cognitive kernel.
 * Total function — for every valid (state, event) pair, produces exactly
 * one (state', effects) pair. No exceptions, no I/O, no randomness.
 *
 * Handles all kernel event types:
 * - boot, halt_check, external_command, process_completed, ephemeral_completed
 * - timer_fired (housekeep, snapshot), metacog_evaluated, awareness_evaluated
 * - shell_output, process_submitted (observational no-op)
 * - topology_declared, metacog_response_received, awareness_response_received
 */

import type { KernelState, BlackboardEntry } from "./state.js";
import type { KernelEvent, BootEvent, HaltCheckEvent, ExternalCommandEvent, ProcessCompletedEvent, EphemeralCompletedEvent, TimerFiredEvent, MetacogEvaluatedEvent, AwarenessEvaluatedEvent, ShellOutputEvent, TopologyDeclaredEvent, MetacogResponseReceivedEvent, AwarenessResponseReceivedEvent, LlmTurnCompletedEvent, McpCallCompletedEvent } from "./events.js";
import type { KernelEffect, KernelEffectInput } from "./effects.js";
import type { OsProcess, OsProcessCommand, DeferCondition, DeferEntry, SelfReport, OsMetacogTrigger, OsSchedulerStrategy, OsHeuristic, SchedulingStrategy, OsDagTopology, MetacogHistoryEntry, MetacogCommand } from "../types.js";
import { reconcile } from "../topology/reconcile.js";
import { validateTopology } from "../topology/validate.js";
import { optimizeTopology } from "../topology/optimize.js";
import { autoArrange } from "../topology/auto-arrange.js";
import { flatten } from "../topology/flatten.js";
import type { TopologyExpr, MetacogMemoryCommand } from "../topology/types.js";
import { randomUUID } from "node:crypto";
import { buildMetacogContextPure } from "./metacog-context.js";

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
    case "external_command":
      return handleExternalCommand(state, event);
    case "process_completed":
      return handleProcessCompleted(state, event);
    case "ephemeral_completed":
      return handleEphemeralCompleted(state, event);
    case "timer_fired":
      return handleTimerFired(state, event);
    case "metacog_evaluated":
      return handleMetacogEvaluated(state, event);
    case "awareness_evaluated":
      return handleAwarenessEvaluated(state, event);
    case "shell_output":
      return handleShellOutput(state, event);
    case "process_submitted":
      // Process submission is purely observational — no state changes.
      return [state, []];
    case "topology_declared":
      return handleTopologyDeclared(state, event);
    case "metacog_response_received":
      return handleMetacogResponseReceived(state, event);
    case "awareness_response_received":
      return handleAwarenessResponseReceived(state, event);
    case "llm_turn_completed":
      return handleLlmTurnCompleted(state, event);
    case "mcp_call_completed":
      return handleMcpCallCompleted(state, event);
    default:
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
  const workingDir = event.workingDir ?? "/tmp";

  const now = new Date().toISOString();

  // NOTE: Metacog and awareness are kernel-level modules, not processes.
  // Memory consolidation is handled by the persist_memory effect, not a daemon process.
  // The metacog timer handles when to run metacog. Boot sets pendingTriggers: ["boot"]
  // so the first metacog timer fire will trigger an evaluation.

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
    pendingTriggers: ["boot"],
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

  // 5. All processes dead — halt (but only if metacog has had a chance to evaluate)
  const livingProcesses = [...state.processes.values()].filter(p => p.state !== "dead");
  if (livingProcesses.length === 0) {
    // Don't halt if metacog still needs to evaluate (pending triggers or inflight)
    if (state.pendingTriggers.length > 0 || state.metacogInflight) {
      return [state, []];
    }
    return haltWith(state, "all_processes_dead", effects);
  }

  // 6. All living processes are accounted for — no special daemon grace period needed.
  // If metacog needs to spawn more work, it will do so on its next timer tick.

  return [state, []];
}

function handleProcessCompleted(state: KernelState, event: ProcessCompletedEvent): TransitionResult {
  const effects: KernelEffectInput[] = [];
  const processes = new Map(state.processes);
  const blackboard = new Map(state.blackboard);
  const deferrals = new Map(state.deferrals);
  const pendingTriggers = [...state.pendingTriggers];

  const proc = processes.get(event.pid);
  if (!proc) {
    // Process not found — nothing to do
    return [state, []];
  }

  // Clone process for mutation
  const updatedProc = { ...proc };
  const now = new Date().toISOString();

  // --- Pre-command processing ---

  // Update process stats
  updatedProc.tickCount += 1;
  updatedProc.tokensUsed += event.tokensUsed;
  updatedProc.lastActiveAt = now;

  // Per-process token budget check
  if (state.config.kernel.processTokenBudgetEnabled &&
      updatedProc.tokenBudget !== undefined && updatedProc.tokensUsed > updatedProc.tokenBudget) {
    pendingTriggers.push("resource_exhaustion");
    effects.push({
      type: "emit_protocol",
      action: "os_metacog",
      message: `token_budget_exceeded pid=${updatedProc.pid} name=${updatedProc.name} used=${updatedProc.tokensUsed} budget=${updatedProc.tokenBudget}`,
    });
  }

  // --- Failure handling ---
  if (!event.success) {
    // Kill the failed process
    updatedProc.state = "dead";
    updatedProc.exitReason = `execution_failed: ${event.response}`;
    processes.set(event.pid, updatedProc);
    pendingTriggers.push("process_failed");

    effects.push({
      type: "emit_protocol",
      action: "os_process_kill",
      message: "execution_failed",
    });

    // Auto-signal parent
    if (updatedProc.parentPid) {
      effects.push({
        type: "emit_protocol",
        action: "os_signal_emit",
        message: `child:done pid=${event.pid} name=${updatedProc.name} parent=${updatedProc.parentPid} code=1`,
      });
      effects.push({
        type: "child_done_signal",
        childPid: event.pid,
        childName: updatedProc.name,
        parentPid: updatedProc.parentPid,
        exitCode: 1,
      });
      effects.push({ type: "flush_ipc" });
      // Wake parent directly so it can process child:done
      const parentProc = processes.get(updatedProc.parentPid);
      if (parentProc && (parentProc.state === "idle" || parentProc.state === "sleeping")) {
        const wokenParent = { ...parentProc, state: "running" as const, lastActiveAt: new Date().toISOString() };
        processes.set(updatedProc.parentPid, wokenParent);
        effects.push({
          type: "activate_process",
          pid: updatedProc.parentPid,
        });
      }
    }

    // Rebuild DAG after process death
    effects.push({ type: "rebuild_dag" });

    return [
      { ...state, processes, pendingTriggers, lastProcessCompletionTime: Date.now() },
      assignEffectSeqs(effects),
    ];
  }

  // NOTE: Hard spawn enforcement removed — in the pure kernel, the metacog
  // handles topology (spawning workers). Worker processes spawned via topology
  // are lifecycle processes that do work directly, not orchestrators.

  // --- Execute commands ---
  // Reorder: exit LAST so bb_write/signals run before death
  const reordered = [
    ...event.commands.filter(c => c.kind !== "exit"),
    ...event.commands.filter(c => c.kind === "exit"),
  ];

  for (const cmd of reordered) {
    switch (cmd.kind) {
      case "idle":
        updatedProc.state = "idle";
        if (cmd.wakeOnSignals) {
          updatedProc.wakeOnSignals = cmd.wakeOnSignals;
        }
        effects.push({
          type: "idle_process",
          pid: event.pid,
          wakeOnSignals: cmd.wakeOnSignals,
        });
        break;

      case "sleep":
        updatedProc.state = "sleeping";
        updatedProc.sleepUntil = new Date(Date.now() + cmd.durationMs).toISOString();
        break;

      case "bb_write":
        processBlackboardWrite(blackboard, updatedProc, cmd.key, cmd.value);
        break;

      case "bb_read": {
        const readResults: Record<string, unknown> = {};
        for (const key of cmd.keys) {
          const entry = blackboard.get(key);
          if (entry) {
            readResults[key] = entry.value;
          }
        }
        blackboard.set(`_inbox:${event.pid}`, {
          value: readResults,
          writtenBy: "kernel",
          version: 1,
        });
        break;
      }

      case "signal_emit":
        effects.push({
          type: "emit_protocol",
          action: "os_signal_emit",
          message: `signal=${cmd.signal} from=${event.pid}`,
        });
        effects.push({
          type: "signal_emit",
          signal: cmd.signal,
          sender: event.pid,
        });
        effects.push({ type: "flush_ipc" });
        break;

      case "request_kernel":
        blackboard.set(`kernel_request:${event.pid}`, {
          value: cmd.question,
          writtenBy: event.pid,
          version: 1,
        });
        pendingTriggers.push("novel_situation");
        break;

      case "self_report": {
        if (!updatedProc.selfReports) updatedProc.selfReports = [];
        const report: SelfReport = {
          tick: updatedProc.tickCount,
          efficiency: cmd.efficiency,
          blockers: cmd.blockers,
          resourcePressure: cmd.resourcePressure,
          suggestedAction: cmd.suggestedAction,
          reason: cmd.reason,
          timestamp: now,
        };
        updatedProc.selfReports = [...(updatedProc.selfReports ?? []), report];
        effects.push({
          type: "emit_protocol",
          action: "os_process_event",
          message: `self_report efficiency=${cmd.efficiency} pressure=${cmd.resourcePressure} action=${cmd.suggestedAction}`,
        });
        break;
      }

      case "cancel_defer": {
        const matches = [...deferrals.entries()].filter(
          ([, d]) => d.descriptor.name === cmd.name && d.registeredByPid === event.pid
        );
        if (matches.length === 0) {
          effects.push({
            type: "emit_protocol",
            action: "os_command_rejected",
            message: `cancel_defer: no pending deferral with name "${cmd.name}" from this process`,
          });
        } else {
          for (const [id] of matches) {
            deferrals.delete(id);
          }
          effects.push({
            type: "emit_protocol",
            action: "os_defer",
            message: `cancel_defer: removed ${matches.length} deferral(s) for "${cmd.name}" reason="${cmd.reason}"`,
          });
        }
        break;
      }

      case "checkpoint": {
        // State: mark process as checkpoint state
        updatedProc.state = "checkpoint";
        updatedProc.checkpoint = {
          pid: event.pid,
          capturedAt: now,
          conversationSummary: cmd.summary ?? `auto-checkpoint at tick ${state.tickCount}`,
          pendingObjectives: cmd.pendingObjectives ?? [],
          artifacts: cmd.artifacts ?? {},
          runId: state.runId,
          tickCount: updatedProc.tickCount,
          tokensUsed: updatedProc.tokensUsed,
          processName: updatedProc.name,
          processType: updatedProc.type,
          processObjective: updatedProc.objective,
          processPriority: updatedProc.priority,
          processModel: updatedProc.model,
          processWorkingDir: updatedProc.workingDir,
          parentPid: updatedProc.parentPid,
          backend: updatedProc.backend,
        };
        effects.push({
          type: "persist_memory",
          operation: `checkpoint:${event.pid}`,
        });
        effects.push({
          type: "emit_protocol",
          action: "os_checkpoint",
          message: `checkpoint saved: ${cmd.summary ?? "auto-checkpoint"}`,
        });
        break;
      }

      case "spawn_ephemeral": {
        const [ephProc, ephEffects] = processSpawnEphemeral(state, processes, updatedProc, cmd);
        if (ephProc) {
          processes.set(ephProc.pid, ephProc);
          updatedProc.ephemeralSpawnCount = (updatedProc.ephemeralSpawnCount ?? 0) + 1;
          effects.push(...ephEffects);
        } else {
          effects.push(...ephEffects); // rejection effects
        }
        break;
      }

      case "exit": {
        // Kill the process
        updatedProc.state = "dead";
        updatedProc.exitCode = cmd.code;
        updatedProc.exitReason = cmd.reason;
        effects.push({
          type: "emit_protocol",
          action: "os_process_kill",
          message: `exit: ${cmd.reason}`,
        });

        // Auto-signal parent
        if (updatedProc.parentPid) {
          effects.push({
            type: "emit_protocol",
            action: "os_signal_emit",
            message: `child:done pid=${event.pid} name=${updatedProc.name} parent=${updatedProc.parentPid} code=${cmd.code}`,
          });
          effects.push({
            type: "child_done_signal",
            childPid: event.pid,
            childName: updatedProc.name,
            parentPid: updatedProc.parentPid,
            exitCode: cmd.code,
            exitReason: cmd.reason,
          });
          effects.push({ type: "flush_ipc" });
          // Wake parent directly so it can process child:done
          const parentProc = processes.get(updatedProc.parentPid);
          if (parentProc && (parentProc.state === "idle" || parentProc.state === "sleeping")) {
            const wokenParent = { ...parentProc, state: "running" as const, lastActiveAt: new Date().toISOString() };
            processes.set(updatedProc.parentPid, wokenParent);
            effects.push({
              type: "activate_process",
              pid: updatedProc.parentPid,
            });
          }
        }
        // Rebuild DAG after process death
        effects.push({ type: "rebuild_dag" });
        break;
      }

      case "spawn_system": {
        if (!state.config.systemProcess?.enabled) {
          effects.push({
            type: "emit_protocol",
            action: "os_command_rejected",
            message: `spawn_system rejected: systemProcess.enabled is false`,
          });
          break;
        }

        const shellNow = new Date().toISOString();
        const shellPid = `os-shell-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const shellProc: OsProcess = {
          pid: shellPid,
          type: "lifecycle",
          state: "running",
          name: cmd.name,
          parentPid: event.pid,
          objective: `shell: ${cmd.command} ${(cmd.args ?? []).join(" ")}`,
          priority: state.config.processes.defaultPriority,
          spawnedAt: shellNow,
          lastActiveAt: shellNow,
          tickCount: 0,
          tokensUsed: 0,
          model: state.config.kernel.processModel,
          workingDir: state.processes.values().next().value?.workingDir ?? "/tmp",
          children: [],
          onParentDeath: "orphan",
          restartPolicy: "never",
          backend: { kind: "system", command: cmd.command, args: cmd.args, env: cmd.env },
        };
        processes.set(shellPid, shellProc);
        updatedProc.children = [...(updatedProc.children ?? []), shellPid];

        effects.push({
          type: "run_shell",
          pid: shellPid,
          command: cmd.command,
          args: cmd.args ?? [],
        });
        effects.push({
          type: "emit_protocol",
          action: "os_system_spawn",
          message: `spawn_system name=${cmd.name} command=${cmd.command} pid=${shellPid}`,
        });
        break;
      }

      case "mcp_call": {
        effects.push({
          type: "execute_mcp_call",
          pid: event.pid,
          tool: cmd.tool,
          args: cmd.args,
        });
        updatedProc.state = "idle";
        effects.push({ type: "idle_process", pid: event.pid });
        effects.push({
          type: "emit_protocol",
          action: "os_mcp_call",
          message: `mcp_call tool=${cmd.tool} pid=${event.pid}`,
        });
        break;
      }
    }
  }

  // Emit turn summary
  if (event.commands.length > 0) {
    const kindCounts: Record<string, number> = {};
    for (const cmd of event.commands) {
      kindCounts[cmd.kind] = (kindCounts[cmd.kind] ?? 0) + 1;
    }
    const summary = Object.entries(kindCounts).map(([k, v]) => v > 1 ? `${k}×${v}` : k).join(", ");
    effects.push({
      type: "emit_protocol",
      action: "os_turn_summary",
      message: `Turn ${updatedProc.tickCount} complete → ${summary}`,
    });
  }

  processes.set(event.pid, updatedProc);

  // Process deferrals — a process dying or bb writes may trigger conditions
  processPureDeferrals(state, processes, deferrals, effects);

  return [
    {
      ...state,
      processes,
      blackboard,
      deferrals,
      pendingTriggers,
      lastProcessCompletionTime: Date.now(),
    },
    assignEffectSeqs(effects),
  ];
}

// ---------------------------------------------------------------------------
// process_completed helpers
// ---------------------------------------------------------------------------

/** Update blackboard with a write and track which keys the process has written. */
function processBlackboardWrite(
  blackboard: Map<string, BlackboardEntry>,
  proc: OsProcess,
  key: string,
  value: unknown,
): void {
  const existing = blackboard.get(key);
  blackboard.set(key, {
    value,
    writtenBy: proc.pid,
    version: (existing?.version ?? 0) + 1,
  });
  if (!proc.blackboardKeysWritten) proc.blackboardKeysWritten = [];
  if (!proc.blackboardKeysWritten.includes(key)) {
    proc.blackboardKeysWritten.push(key);
  }
}

/** Spawn a child process (immediate or deferred). Returns [process | null, effects, deferEntry | null]. */
function processSpawnChild(
  state: KernelState,
  processes: Map<string, OsProcess>,
  deferrals: Map<string, DeferEntry>,
  parent: OsProcess,
  cmd: Extract<OsProcessCommand, { kind: "spawn_child" }>,
): [OsProcess | null, KernelEffectInput[], DeferEntry | null] {
  const effects: KernelEffectInput[] = [];
  const now = new Date().toISOString();

  const resolvedDescriptor = {
    ...cmd.descriptor,
    parentPid: parent.pid,
    model: state.config.kernel.processModel,
    workingDir: cmd.descriptor.workingDir ?? parent.workingDir,
  };

  if (cmd.condition) {
    // Dedup check
    const hasDup = [...deferrals.values()].some(
      d => d.descriptor.name === cmd.descriptor.name && d.registeredByPid === parent.pid
    );
    if (hasDup) {
      effects.push({
        type: "emit_protocol",
        action: "os_command_rejected",
        message: `defer dedup: "${cmd.descriptor.name}" already has pending deferral from same parent`,
      });
      return [null, effects, null];
    }
    const ds: DeferEntry = {
      id: randomUUID(),
      descriptor: resolvedDescriptor,
      condition: cmd.condition,
      registeredAt: now,
      registeredAtMs: Date.now(),
      registeredByTick: state.tickCount,
      registeredByPid: parent.pid,
      reason: `conditional spawn_child from ${parent.pid}: ${cmd.descriptor.name}`,
      maxWaitTicks: cmd.maxWaitTicks,
      maxWaitMs: cmd.maxWaitTicks ? cmd.maxWaitTicks * 30_000 : undefined,
    };
    effects.push({
      type: "emit_protocol",
      action: "os_defer",
      message: `deferred spawn of "${cmd.descriptor.name}" condition=${JSON.stringify(cmd.condition)}`,
    });
    return [null, effects, ds];
  }

  // Immediate spawn
  const childPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const child: OsProcess = {
    pid: childPid,
    type: resolvedDescriptor.type ?? "lifecycle",
    state: "running",
    name: resolvedDescriptor.name,
    parentPid: parent.pid,
    objective: resolvedDescriptor.objective,
    priority: resolvedDescriptor.priority ?? 50,
    spawnedAt: now,
    lastActiveAt: now,
    tickCount: 0,
    tokensUsed: 0,
    model: resolvedDescriptor.model,
    workingDir: resolvedDescriptor.workingDir ?? parent.workingDir,
    children: [],
    onParentDeath: resolvedDescriptor.onParentDeath ?? "orphan",
    restartPolicy: resolvedDescriptor.restartPolicy ?? "never",
    tokenBudget: resolvedDescriptor.tokenBudget,
    completionCriteria: resolvedDescriptor.completionCriteria,
    capabilities: resolvedDescriptor.capabilities,
    backend: resolvedDescriptor.backend,
  };

  effects.push({
    type: "emit_protocol",
    action: "os_process_spawn",
    message: `parent=${parent.pid}`,
  });
  effects.push({
    type: "submit_llm",
    pid: childPid,
    name: resolvedDescriptor.name,
    model: resolvedDescriptor.model,
  });

  return [child, effects, null];
}

/** Spawn an ephemeral process. Returns [process | null, effects]. */
function processSpawnEphemeral(
  state: KernelState,
  processes: Map<string, OsProcess>,
  parent: OsProcess,
  cmd: Extract<OsProcessCommand, { kind: "spawn_ephemeral" }>,
): [OsProcess | null, KernelEffectInput[]] {
  const effects: KernelEffectInput[] = [];
  const now = new Date().toISOString();

  if (!state.config.ephemeral.enabled) {
    return [null, []];
  }

  const spawnCount = parent.ephemeralSpawnCount ?? 0;
  if (spawnCount >= state.config.ephemeral.maxPerProcess) {
    effects.push({
      type: "emit_protocol",
      action: "os_command_rejected",
      message: `Per-process ephemeral limit reached (${state.config.ephemeral.maxPerProcess})`,
    });
    return [null, effects];
  }

  const ephPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const ephName = cmd.name ?? "ephemeral";
  const ephModel = state.config.ephemeral.defaultModel;

  const ephProc: OsProcess = {
    pid: ephPid,
    type: "event",
    state: "running",
    name: ephName,
    parentPid: parent.pid,
    objective: cmd.objective,
    priority: 30,
    spawnedAt: now,
    lastActiveAt: now,
    tickCount: 0,
    tokensUsed: 0,
    model: ephModel,
    workingDir: parent.workingDir,
    children: [],
    onParentDeath: "orphan",
    restartPolicy: "never",
  };

  effects.push({
    type: "emit_protocol",
    action: "os_process_spawn",
    message: `parent=${parent.name} type=ephemeral model=${ephModel}`,
  });
  effects.push({
    type: "run_ephemeral",
    pid: ephPid,
    parentPid: parent.pid,
    objective: cmd.objective,
    model: ephModel,
  });

  return [ephProc, effects];
}

function handleExternalCommand(state: KernelState, event: ExternalCommandEvent): TransitionResult {
  switch (event.command) {
    case "halt":
      return haltWith(state, event.reason ?? "external_halt", []);
    case "pause":
      // Pause doesn't halt — it's a runtime concern (timers paused, no new submissions)
      // but it's visible as an effect
      return [state, assignEffectSeqs([
        { type: "emit_protocol", action: "os_external_command", message: "pause requested" },
      ])];
    case "resume":
      return [state, assignEffectSeqs([
        { type: "emit_protocol", action: "os_external_command", message: "resume requested" },
      ])];
  }
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

// ---------------------------------------------------------------------------
// Ephemeral Completed Handler
// ---------------------------------------------------------------------------

function handleEphemeralCompleted(state: KernelState, event: EphemeralCompletedEvent): TransitionResult {
  const effects: KernelEffectInput[] = [];
  const processes = new Map(state.processes);
  const blackboard = new Map(state.blackboard);

  // Write ephemeral result to blackboard
  if (event.tablePid) {
    const tokensEstimate = event.success
      ? Math.ceil((event.response?.length ?? 0) / 4)
      : 0;

    const ephResult = {
      ephemeralId: event.id,
      name: event.name,
      success: event.success,
      response: event.response ?? "",
      ...(event.error ? { error: event.error } : {}),
      durationMs: event.durationMs ?? 0,
      model: event.model ?? "",
      tokensEstimate,
    };

    blackboard.set(`ephemeral:${event.name}:${event.id}`, {
      value: ephResult,
      writtenBy: "kernel",
      version: (blackboard.get(`ephemeral:${event.name}:${event.id}`)?.version ?? 0) + 1,
    });

    // Kill the process table entry
    const proc = processes.get(event.tablePid);
    if (proc) {
      const updatedProc = { ...proc };
      updatedProc.state = "dead" as const;
      updatedProc.exitReason = event.success
        ? "ephemeral completed"
        : `ephemeral failed: ${event.error ?? "unknown"}`;
      processes.set(event.tablePid, updatedProc);
    }

    // Protocol effects
    effects.push({
      type: "emit_protocol",
      action: "os_process_exit",
      message: event.success
        ? `completed duration=${event.durationMs ?? 0}ms`
        : `failed: ${event.error ?? "unknown"}`,
    });

    effects.push({
      type: "emit_protocol",
      action: "os_ephemeral_spawn",
      message: event.success
        ? `parent=${event.parentPid ?? "unknown"} model=${event.model ?? ""} duration=${event.durationMs ?? 0}ms`
        : `parent=${event.parentPid ?? "unknown"} error=${event.error ?? "unknown"}`,
    });

    // Signal for waking parent
    effects.push({
      type: "emit_protocol",
      action: "os_signal_emit",
      message: `ephemeral:ready pid=kernel name=${event.name} parent=${event.parentPid ?? "unknown"} id=${event.id}${!event.success ? " error=true" : ""}`,
    });
    effects.push({
      type: "signal_emit",
      signal: `ephemeral:ready`,
      sender: "kernel",
      payload: {
        name: event.name,
        parentPid: event.parentPid ?? "unknown",
        id: event.id,
        error: !event.success,
      },
    });
    effects.push({ type: "flush_ipc" });

    // Wake parent directly so it can process ephemeral results
    if (event.parentPid) {
      const parentProc = processes.get(event.parentPid);
      if (parentProc && (parentProc.state === "idle" || parentProc.state === "sleeping")) {
        const wokenParent = { ...parentProc, state: "running" as const, lastActiveAt: new Date().toISOString() };
        processes.set(event.parentPid, wokenParent);
        effects.push({
          type: "activate_process",
          pid: event.parentPid,
        });
      }
    }
  }

  return [
    { ...state, processes, blackboard },
    assignEffectSeqs(effects),
  ];
}

// ---------------------------------------------------------------------------
// Timer Fired Handler
// ---------------------------------------------------------------------------

function handleTimerFired(state: KernelState, event: TimerFiredEvent): TransitionResult {
  if (state.halted) return [state, []];

  switch (event.timer) {
    case "housekeep":
      return handleHousekeep(state, event);
    case "snapshot":
      // Snapshot is pure I/O — transition has no state to change
      return [state, assignEffectSeqs([{
        type: "persist_snapshot",
        runId: state.runId,
      }])];
    case "metacog":
      return handleMetacogTimer(state);
    case "watchdog":
      // Watchdog is I/O-heavy (LLM calls, process inspection).
      // Transition passes through — kernel handles via existing code paths.
      return [state, []];
    default:
      return [state, []];
  }
}

/**
 * Metacog timer handler — decides WHEN to run metacog/awareness evaluations.
 * Builds the full metacog context from state and emits a run_metacog effect
 * carrying the context payload. Guards against concurrent metacog evals via
 * state.metacogInflight.
 */
function handleMetacogTimer(state: KernelState): TransitionResult {
  if (state.halted) return [state, []];
  if (state.metacogInflight) return [state, []];

  const effects: KernelEffectInput[] = [];
  const pendingTriggers = [...state.pendingTriggers];

  // Goal drift safety net — if metacog hasn't evaluated in too long with living processes
  const ticksSinceMetacog = state.tickCount - state.lastMetacogTick;
  if (ticksSinceMetacog > 5 && state.tickCount > 0) {
    const hasLivingWork = [...state.processes.values()].some(p => p.state !== "dead");
    if (hasLivingWork && !pendingTriggers.includes("goal_drift")) {
      pendingTriggers.push("goal_drift");
    }
  }

  // Cadence check: metacog should run if there are triggers OR tick-based cadence fires
  const cadenceFires = state.tickCount > 0 &&
    state.tickCount % state.config.scheduler.metacogCadence === 0;
  const shouldRunMetacog = pendingTriggers.length > 0 || cadenceFires;

  let metacogInflight: boolean = state.metacogInflight;

  if (shouldRunMetacog) {
    // Build context from state — pure function, no I/O
    const stateForContext = { ...state, pendingTriggers };
    const context = buildMetacogContextPure(stateForContext);
    effects.push({
      type: "run_metacog",
      context,
    });
    metacogInflight = true;
  }

  // Awareness cadence check: runs every N metacog evaluations
  // Note: awareness will actually run after metacog completes — kernel coordinates this.
  // We emit the effect here so the kernel knows transition decided awareness should run.
  if (shouldRunMetacog && state.config.awareness.enabled) {
    const nextMetacogEvalCount = state.metacogEvalCount + 1;
    if (nextMetacogEvalCount > 0 && nextMetacogEvalCount % state.config.awareness.cadence === 0) {
      effects.push({
        type: "run_awareness",
        context: {},
      });
    }
  }

  return [
    { ...state, pendingTriggers, metacogInflight },
    assignEffectSeqs(effects),
  ];
}

function handleHousekeep(state: KernelState, event: TimerFiredEvent): TransitionResult {
  const effects: KernelEffectInput[] = [];
  const processes = new Map(state.processes);
  const pendingTriggers = [...state.pendingTriggers];
  const deferrals = new Map(state.deferrals);

  // 1. Increment housekeep counter
  const housekeepCount = state.housekeepCount + 1;

  // 1b. Emit periodic cadence signals
  const cadences = state.config.kernel.tickSignalCadences ?? [1, 5, 10];
  for (const cadence of cadences) {
    if (housekeepCount % cadence === 0) {
      effects.push({
        type: "emit_protocol",
        action: "os_signal_emit",
        message: `tick:${cadence} pid=kernel cadence=${cadence} tick=${housekeepCount}`,
      });
      effects.push({
        type: "signal_emit",
        signal: `tick:${cadence}`,
        sender: "kernel",
        payload: { cadence, tick: housekeepCount },
      });
    }
  }
  // Flush IPC after all cadence signals
  if (cadences.some(c => housekeepCount % c === 0)) {
    effects.push({ type: "flush_ipc" });
  }

  // 2. Wake expired sleepers (pure: set state from sleeping to running)
  const now = new Date().toISOString();
  const nowMs = Date.now();
  for (const [pid, proc] of processes) {
    if (proc.state === "sleeping" && proc.sleepUntil) {
      const sleepUntilMs = new Date(proc.sleepUntil).getTime();
      if (nowMs >= sleepUntilMs) {
        const updated = { ...proc, state: "running" as const, sleepUntil: undefined, lastActiveAt: now };
        processes.set(pid, updated);
        effects.push({
          type: "activate_process",
          pid,
        });
      }
    }
  }

  // 2b. Restore checkpointed processes (pure: set state from checkpoint to running)
  for (const [pid, proc] of processes) {
    if (proc.state === "checkpoint") {
      const updated = { ...proc, state: "running" as const, lastActiveAt: now };
      processes.set(pid, updated);
      effects.push({
        type: "activate_process",
        pid,
      });
    }
  }

  // 3. Zombie reaping — reparent orphaned children of dead processes to root
  const rootPid = [...processes.values()].find(p => !p.parentPid && p.type === "lifecycle")?.pid;
  for (const [pid, proc] of processes) {
    if (proc.state === "dead" && proc.children.length > 0) {
      const updatedChildren: string[] = [];
      for (const childPid of proc.children) {
        const child = processes.get(childPid);
        if (!child || child.state === "dead") {
          // Keep dead children in the list (no reparenting needed)
          updatedChildren.push(childPid);
          continue;
        }
        // Reparent living orphan to root (or null if no root)
        const newParent = rootPid && rootPid !== pid ? rootPid : null;
        const updatedChild = { ...child, parentPid: newParent };
        processes.set(childPid, updatedChild);
        // Add to root's children if we have a root
        if (newParent) {
          const root = processes.get(newParent);
          if (root && !root.children.includes(childPid)) {
            const updatedRoot = { ...root, children: [...root.children, childPid] };
            processes.set(newParent, updatedRoot);
          }
        }
        // Don't keep this child in the dead parent's children list
      }
      // Update the dead parent: remove reparented children
      const remainingChildren = proc.children.filter(cid => {
        const c = processes.get(cid);
        return !c || c.state === "dead" || c.parentPid === pid;
      });
      if (remainingChildren.length !== proc.children.length) {
        const reparentedCount = proc.children.length - remainingChildren.length;
        processes.set(pid, { ...proc, children: remainingChildren });
        effects.push({
          type: "emit_protocol",
          action: "os_process_event",
          message: `zombie_reap: reparented ${reparentedCount} orphans from dead pid=${pid}`,
        });
      }
    }
  }

  // 4. Goal drift trigger — if metacog hasn't evaluated in too long with living processes,
  //     add goal_drift trigger so the kernel's metacog check will fire.
  const ticksSinceMetacog = state.tickCount - state.lastMetacogTick;
  if (ticksSinceMetacog > 5 && state.tickCount > 0) {
    const hasLivingWork = [...processes.values()].some(p => p.state !== "dead");
    if (hasLivingWork && !pendingTriggers.includes("goal_drift")) {
      pendingTriggers.push("goal_drift");
    }
  }

  // 4b. Reactive metacog — if pending triggers exist and metacog isn't inflight,
  //     fire metacog immediately instead of waiting for the 60s timer.
  //     This makes metacog event-driven (responds within 500ms of a trigger).
  let metacogInflight = state.metacogInflight;
  if (pendingTriggers.length > 0 && !metacogInflight) {
    const stateForContext = { ...state, processes, pendingTriggers };
    const context = buildMetacogContextPure(stateForContext);
    effects.push({
      type: "run_metacog",
      context,
    });
    metacogInflight = true;
  }

  // 5. Process deferrals
  processPureDeferrals(state, processes, deferrals, effects);

  // 6. Scheduling pass — select runnable processes and emit submit_llm effects
  const allProcs = [...processes.values()];
  const schedulerInput = {
    strategy: state.schedulerStrategy,
    maxConcurrent: state.schedulerMaxConcurrent,
    roundRobinIndex: state.schedulerRoundRobinIndex,
    heuristics: state.schedulerHeuristics,
    currentStrategies: state.currentStrategies,
    topology: state.dagTopology,
  };
  const { selected, roundRobinIndex: newRoundRobinIndex } = selectRunnable(allProcs, allProcs, schedulerInput);

  // Collect PIDs that already have a submit_llm effect from earlier steps
  // (e.g., topology reconciliation) to avoid duplicates
  const alreadySubmitted = new Set<string>();
  for (const eff of effects) {
    if (eff.type === "submit_llm") {
      alreadySubmitted.add(eff.pid);
    }
  }

  // Emit submit_llm for each selected process not already inflight or submitted
  for (const proc of selected) {
    if (state.inflight.has(proc.pid)) continue;
    if (alreadySubmitted.has(proc.pid)) continue;
    effects.push({
      type: "submit_llm",
      pid: proc.pid,
      name: proc.name,
      model: proc.model,
    });
  }

  // Track all submit_llm PIDs in inflight set
  const inflight = new Set(state.inflight);
  for (const eff of effects) {
    if (eff.type === "submit_llm") {
      inflight.add(eff.pid);
    }
  }

  return [
    {
      ...state,
      processes,
      pendingTriggers,
      deferrals,
      housekeepCount,
      inflight,
      metacogInflight,
      schedulerRoundRobinIndex: newRoundRobinIndex,
    },
    assignEffectSeqs(effects),
  ];
}

// ---------------------------------------------------------------------------
// Metacog Evaluated Handler
// ---------------------------------------------------------------------------

function handleMetacogEvaluated(state: KernelState, event: MetacogEvaluatedEvent): TransitionResult {
  if (state.halted) return [state, []];

  const effects: KernelEffectInput[] = [];

  // Clear pending triggers — metacog has consumed them
  const pendingTriggers: OsMetacogTrigger[] = [];

  effects.push({
    type: "emit_protocol",
    action: "os_metacog_eval",
    message: `metacog evaluated: ${event.commandCount} commands, ${event.triggerCount} triggers consumed`,
  });

  return [
    {
      ...state,
      pendingTriggers,
      lastMetacogTick: state.tickCount,
      metacogEvalCount: state.metacogEvalCount + 1,
    },
    assignEffectSeqs(effects),
  ];
}

// ---------------------------------------------------------------------------
// Awareness Evaluated Handler
// ---------------------------------------------------------------------------

function handleAwarenessEvaluated(state: KernelState, _event: AwarenessEvaluatedEvent): TransitionResult {
  if (state.halted) return [state, []];

  // Awareness evaluation is I/O-heavy (LLM call, bb writes, adjustments).
  // The transition function has no pure state to update — all state changes
  // happen via kernel-side I/O operations.
  return [state, []];
}

// ---------------------------------------------------------------------------
// Shell Output Handler
// ---------------------------------------------------------------------------

function handleShellOutput(state: KernelState, event: ShellOutputEvent): TransitionResult {
  if (state.halted) return [state, []];

  const effects: KernelEffectInput[] = [];
  const processes = new Map(state.processes);
  const blackboard = new Map(state.blackboard);
  const now = new Date().toISOString();

  const proc = processes.get(event.pid);
  if (!proc) return [state, []];

  // Emit protocol events for stdout/stderr content (flows to Lens terminal view)
  if (event.stdout) {
    effects.push({
      type: "emit_protocol",
      action: "os_shell_output",
      message: event.stdout,
      detail: { stream: "stdout", pid: event.pid, name: proc.name },
    });
    blackboard.set(`shell:${proc.name}:stdout`, {
      value: event.stdout,
      writtenBy: "kernel",
      version: (blackboard.get(`shell:${proc.name}:stdout`)?.version ?? 0) + 1,
    });
  }
  if (event.stderr) {
    effects.push({
      type: "emit_protocol",
      action: "os_shell_output",
      message: event.stderr,
      detail: { stream: "stderr", pid: event.pid, name: proc.name },
    });
    blackboard.set(`shell:${proc.name}:stderr`, {
      value: event.stderr,
      writtenBy: "kernel",
      version: (blackboard.get(`shell:${proc.name}:stderr`)?.version ?? 0) + 1,
    });
  }

  // If exitCode is present, the shell process has exited
  if (event.exitCode !== undefined) {
    const updated = {
      ...proc,
      state: "dead" as const,
      exitCode: event.exitCode,
      exitReason: event.exitCode === 0 ? "completed" : `exit code ${event.exitCode}`,
      lastActiveAt: now,
    };
    processes.set(event.pid, updated);

    blackboard.set(`shell:exit:${event.pid}`, {
      value: { exitCode: event.exitCode, pid: event.pid, name: proc.name },
      writtenBy: "kernel",
      version: 1,
    });

    effects.push({
      type: "emit_protocol",
      action: "os_system_exit",
      message: `shell pid=${event.pid} name=${proc.name} exitCode=${event.exitCode}`,
    });

    // Signal parent process and re-submit to LLM if it was waiting
    let inflight = state.inflight;
    if (proc.parentPid) {
      const parent = processes.get(proc.parentPid);
      if (parent) {
        effects.push({
          type: "activate_process",
          pid: proc.parentPid,
        });

        if (parent.state === "idle" || parent.state === "sleeping") {
          const wokenParent = { ...parent, state: "running" as const, lastActiveAt: now };
          processes.set(proc.parentPid, wokenParent);

          const stdout = event.stdout ? `\n\nStdout:\n${event.stdout.slice(0, 2000)}` : "";
          const stderr = event.stderr ? `\n\nStderr:\n${event.stderr.slice(0, 2000)}` : "";
          const shellContext = `Your shell process "${proc.name}" (pid=${event.pid}) exited with code ${event.exitCode}.` +
            (event.exitCode === 0 ? ` The command completed successfully.` : ` The command failed.`) +
            stdout + stderr + `\n\nContinue with your next step.`;

          effects.push({
            type: "submit_llm",
            pid: proc.parentPid,
            name: wokenParent.name,
            model: wokenParent.model,
            context: shellContext,
          });
          inflight = new Set([...state.inflight, proc.parentPid]);
        }
      }
    }

    return [
      { ...state, processes, blackboard, inflight },
      assignEffectSeqs(effects),
    ];
  }

  // Output received but process still running — update lastActiveAt
  const updated = { ...proc, lastActiveAt: now };
  processes.set(event.pid, updated);

  return [
    { ...state, processes, blackboard },
    assignEffectSeqs(effects),
  ];
}

// ---------------------------------------------------------------------------
// Deferral Processing (Pure)
// ---------------------------------------------------------------------------

/**
 * Evaluate deferral conditions and spawn triggered processes.
 * Pure function — reads from state's blackboard and processes, mutates
 * the passed-in maps (already copies of state).
 */
function processPureDeferrals(
  state: KernelState,
  processes: Map<string, OsProcess>,
  deferrals: Map<string, DeferEntry>,
  effects: KernelEffectInput[],
): void {
  if (deferrals.size === 0) return;

  const nowMs = Date.now();
  const now = new Date().toISOString();
  const triggered: string[] = [];

  for (const [id, ds] of deferrals) {
    // TTL expiry — spawn anyway instead of silently dropping work
    const waited = state.tickCount - ds.registeredByTick;
    const wallWaitMs = ds.registeredAtMs ? nowMs - ds.registeredAtMs : 0;
    const tickExpired = ds.maxWaitTicks && waited > ds.maxWaitTicks;
    const wallExpired = ds.maxWaitMs && wallWaitMs > ds.maxWaitMs;

    if (tickExpired || wallExpired) {
      const pid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const proc: OsProcess = {
        pid,
        type: ds.descriptor.type ?? "lifecycle",
        state: "running",
        name: ds.descriptor.name,
        parentPid: ds.registeredByPid ?? null,
        objective: ds.descriptor.objective ?? "",
        priority: ds.descriptor.priority ?? 50,
        spawnedAt: now,
        lastActiveAt: now,
        tickCount: 0,
        tokensUsed: 0,
        model: state.config.kernel.processModel,
        workingDir: ds.descriptor.workingDir ?? state.processes.values().next().value?.workingDir ?? "/tmp",
        children: [],
        onParentDeath: "orphan",
        restartPolicy: "never",
      };
      processes.set(pid, proc);

      // Register as child of parent
      if (ds.registeredByPid) {
        const parent = processes.get(ds.registeredByPid);
        if (parent) {
          const updated = { ...parent, children: [...(parent.children ?? []), pid] };
          processes.set(ds.registeredByPid, updated);
        }
      }

      triggered.push(id);
      effects.push({
        type: "submit_llm",
        pid,
        name: ds.descriptor.name,
        model: state.config.kernel.processModel,
      });
      effects.push({
        type: "emit_protocol",
        action: "os_defer",
        message: `expired_but_spawned id=${id} name=${ds.descriptor.name} — condition not met after ${waited} ticks (${Math.round(wallWaitMs / 1000)}s wall), spawning anyway`,
      });
      continue;
    }

    // Evaluate condition against current state
    if (evaluateDeferConditionPure(ds.condition, state.blackboard, processes)) {
      const pid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const proc: OsProcess = {
        pid,
        type: ds.descriptor.type ?? "lifecycle",
        state: "running",
        name: ds.descriptor.name,
        parentPid: ds.registeredByPid ?? null,
        objective: ds.descriptor.objective ?? "",
        priority: ds.descriptor.priority ?? 50,
        spawnedAt: now,
        lastActiveAt: now,
        tickCount: 0,
        tokensUsed: 0,
        model: state.config.kernel.processModel,
        workingDir: ds.descriptor.workingDir ?? state.processes.values().next().value?.workingDir ?? "/tmp",
        children: [],
        onParentDeath: "orphan",
        restartPolicy: "never",
      };
      processes.set(pid, proc);

      // Register as child of parent
      if (ds.registeredByPid) {
        const parent = processes.get(ds.registeredByPid);
        if (parent) {
          const updated = { ...parent, children: [...(parent.children ?? []), pid] };
          processes.set(ds.registeredByPid, updated);
        }
      }

      triggered.push(id);
      effects.push({
        type: "submit_llm",
        pid,
        name: ds.descriptor.name,
        model: state.config.kernel.processModel,
      });
      effects.push({
        type: "emit_protocol",
        action: "os_defer",
        message: `triggered id=${id} reason="${ds.reason}" waited=${state.tickCount - ds.registeredByTick} ticks`,
      });
    }
  }

  for (const id of triggered) {
    deferrals.delete(id);
  }
}

/**
 * Pure evaluation of a deferral condition against blackboard and process state.
 * No I/O — reads only from the provided maps.
 */
function evaluateDeferConditionPure(
  cond: DeferCondition,
  blackboard: Map<string, { value: unknown; writtenBy: string | null; version: number }>,
  processes: Map<string, OsProcess>,
): boolean {
  switch (cond.type) {
    case "blackboard_key_exists":
      return blackboard.has(cond.key);
    case "blackboard_key_match": {
      const entry = blackboard.get(cond.key);
      return entry !== undefined && entry.value === cond.value;
    }
    case "blackboard_value_contains": {
      const entry = blackboard.get(cond.key);
      if (!entry) return false;
      const val = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      return val.includes(cond.substring);
    }
    case "process_dead": {
      const proc = processes.get(cond.pid);
      return !proc || proc.state === "dead";
    }
    case "process_dead_by_name": {
      const matching = [...processes.values()].filter(p => p.name === cond.name);
      return matching.length > 0 && matching.every(p => p.state === "dead");
    }
    case "all_of":
      return cond.conditions.every(c => evaluateDeferConditionPure(c, blackboard, processes));
    case "any_of":
      return cond.conditions.some(c => evaluateDeferConditionPure(c, blackboard, processes));
  }
}

// ---------------------------------------------------------------------------
// Pure Scheduling — selectRunnable (Wave 4)
// ---------------------------------------------------------------------------

/**
 * Scheduling state needed by selectRunnable. Extracted from KernelState
 * so the function signature is explicit about its inputs.
 */
type SchedulerInput = {
  strategy: OsSchedulerStrategy;
  maxConcurrent: number;
  roundRobinIndex: number;
  heuristics: OsHeuristic[];
  currentStrategies: SchedulingStrategy[];
  topology?: OsDagTopology;
};

/**
 * Pure scheduling function — mirrors OsScheduler.selectRunnable().
 * Takes data in, returns data out, no side effects.
 *
 * Returns:
 * - `selected`: processes chosen for submission
 * - `roundRobinIndex`: updated index (only changes for round-robin strategy)
 */
export function selectRunnable(
  processes: OsProcess[],
  allProcesses: OsProcess[],
  input: SchedulerInput,
): { selected: OsProcess[]; roundRobinIndex: number } {
  const runnable = processes.filter(p => p.state === "running");
  let roundRobinIndex = input.roundRobinIndex;

  if (runnable.length === 0) {
    return { selected: [], roundRobinIndex };
  }

  let selected: OsProcess[];

  switch (input.strategy) {
    case "priority": {
      const sorted = [...runnable].sort((a, b) => b.priority - a.priority);
      selected = sorted.slice(0, input.maxConcurrent);
      break;
    }

    case "learned": {
      const result = learnedSelect(runnable, allProcesses, input);
      selected = result;
      break;
    }

    case "round-robin": {
      selected = [];
      const count = Math.min(input.maxConcurrent, runnable.length);
      for (let i = 0; i < count; i++) {
        const index = (roundRobinIndex + i) % runnable.length;
        selected.push(runnable[index]!);
      }
      roundRobinIndex = (roundRobinIndex + count) % runnable.length;
      break;
    }

    case "deadline": {
      const sorted = [...runnable].sort((a, b) => {
        const aDeadline = a.sleepUntil ?? "";
        const bDeadline = b.sleepUntil ?? "";
        const aNum = typeof aDeadline === "number" ? aDeadline : (aDeadline ? new Date(aDeadline).getTime() : Number.MAX_SAFE_INTEGER);
        const bNum = typeof bDeadline === "number" ? bDeadline : (bDeadline ? new Date(bDeadline).getTime() : Number.MAX_SAFE_INTEGER);
        return aNum - bNum;
      });
      selected = sorted.slice(0, input.maxConcurrent);
      break;
    }

    default: {
      const _exhaustive: never = input.strategy;
      selected = runnable.slice(0, input.maxConcurrent);
      break;
    }
  }

  return { selected, roundRobinIndex };
}

/**
 * Learned scheduling strategy (pure).
 * Mirrors OsScheduler.learnedSelect() exactly.
 */
function learnedSelect(
  runnable: OsProcess[],
  allProcesses: OsProcess[],
  input: SchedulerInput,
): OsProcess[] {
  const effectivePriority = new Map<string, number>();
  for (const proc of runnable) {
    effectivePriority.set(proc.pid, proc.priority);
  }

  // Rule 1: Sibling contention prevention (S-001, S-002)
  const siblingGroups = new Map<string, OsProcess[]>();
  for (const proc of runnable) {
    const parent = proc.parentPid ?? "__root__";
    const group = siblingGroups.get(parent) ?? [];
    group.push(proc);
    siblingGroups.set(parent, group);
  }

  for (const [, siblings] of siblingGroups) {
    if (siblings.length < 2) continue;
    const priorities = new Set(siblings.map(s => s.priority));
    if (priorities.size === 1) {
      const sorted = [...siblings].sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
      for (let i = 0; i < sorted.length; i++) {
        const base = effectivePriority.get(sorted[i]!.pid)!;
        effectivePriority.set(sorted[i]!.pid, base - i * 2);
      }
    }
  }

  // Rule 2: Synthesis deprioritization (G-004)
  for (const proc of runnable) {
    const isSynthesis =
      proc.name.includes("synth") ||
      proc.name.includes("consolidat");

    if (isSynthesis) {
      const siblings = allProcesses.filter(
        p => p.parentPid === proc.parentPid && p.pid !== proc.pid && p.state !== "dead",
      );
      if (siblings.length > 0) {
        const minWorkerPriority = Math.min(
          ...siblings.map(s => effectivePriority.get(s.pid) ?? s.priority),
        );
        const current = effectivePriority.get(proc.pid)!;
        if (current >= minWorkerPriority) {
          effectivePriority.set(proc.pid, minWorkerPriority - 5);
        }
      }
    }
  }

  // Rule 3: Liveness boost (L-001)
  for (const proc of runnable) {
    if (proc.tickCount > 0 && proc.tokensUsed > 0) {
      const tokensPerTick = proc.tokensUsed / proc.tickCount;
      if (tokensPerTick > 50) {
        const current = effectivePriority.get(proc.pid)!;
        effectivePriority.set(proc.pid, current + 1);
      }
    }
  }

  // Phase 4: Heuristic-driven scoring
  if (input.heuristics.length > 0) {
    const scores = new Map<string, number>();
    for (const proc of runnable) {
      scores.set(proc.pid, 0);
    }

    for (const h of input.heuristics) {
      const text = h.heuristic.toLowerCase();

      // Synthesis signal
      if (text.includes("synthesis") || text.includes("aggregat") || text.includes("consolidat") || text.includes("fan-in")) {
        for (const proc of runnable) {
          const nameLower = proc.name.toLowerCase();
          const objLower = proc.objective.toLowerCase();
          const isSynthesisLike =
            nameLower.includes("synthesis") || nameLower.includes("aggregat") ||
            nameLower.includes("consolidat") || nameLower.includes("fan-in") ||
            objLower.includes("synthesis") || objLower.includes("aggregat") ||
            objLower.includes("consolidat") || objLower.includes("fan-in");
          if (isSynthesisLike) {
            scores.set(proc.pid, (scores.get(proc.pid) ?? 0) - 5);
          }
        }
      }

      // Flat-priority / contention signal
      if (text.includes("flat-priority") || text.includes("gradient") || text.includes("contention") || text.includes("sibling")) {
        const byEffPriority = new Map<number, OsProcess[]>();
        for (const proc of runnable) {
          const ep = effectivePriority.get(proc.pid) ?? proc.priority;
          const group = byEffPriority.get(ep) ?? [];
          group.push(proc);
          byEffPriority.set(ep, group);
        }
        for (const [, group] of byEffPriority) {
          if (group.length < 2) continue;
          const winner = group.reduce((best, cur) => {
            if (cur.priority > best.priority) return cur;
            if (cur.priority === best.priority && cur.name < best.name) return cur;
            return best;
          });
          for (const proc of group) {
            if (proc.pid !== winner.pid) {
              scores.set(proc.pid, (scores.get(proc.pid) ?? 0) - 3);
            }
          }
        }
      }

      // Liveness / watchdog signal
      if (text.includes("liveness") || text.includes("watchdog") || text.includes("token")) {
        for (const proc of runnable) {
          if (proc.tokensUsed > 0) {
            scores.set(proc.pid, (scores.get(proc.pid) ?? 0) + 2);
          }
        }
      }
    }

    // Apply accumulated heuristic scores
    for (const [pid, score] of scores) {
      if (score !== 0) {
        const current = effectivePriority.get(pid) ?? 0;
        effectivePriority.set(pid, current + score);
      }
    }
  }

  // Rule 5: Apply SchedulingStrategy adjustments from cross-run memory
  if (input.currentStrategies.length > 0) {
    for (const proc of runnable) {
      const nameLower = proc.name.toLowerCase();
      let strategyDelta = 0;

      for (const strategy of input.currentStrategies) {
        const { adjustments } = strategy;

        if (adjustments.priorityBias) {
          for (const [pattern, delta] of Object.entries(adjustments.priorityBias)) {
            if (nameLower.includes(pattern.toLowerCase())) {
              strategyDelta += delta;
            }
          }
        }

        if (adjustments.disfavorPatterns) {
          for (const pattern of adjustments.disfavorPatterns) {
            if (nameLower.includes(pattern.toLowerCase())) {
              strategyDelta -= 5;
            }
          }
        }

        if (adjustments.favorPatterns) {
          for (const pattern of adjustments.favorPatterns) {
            if (nameLower.includes(pattern.toLowerCase())) {
              strategyDelta += 5;
            }
          }
        }
      }

      if (strategyDelta !== 0) {
        const current = effectivePriority.get(proc.pid) ?? proc.priority;
        effectivePriority.set(proc.pid, current + strategyDelta);
      }
    }
  }

  // Sort by effective priority and select
  const sorted = [...runnable].sort((a, b) => {
    const aPri = effectivePriority.get(a.pid) ?? a.priority;
    const bPri = effectivePriority.get(b.pid) ?? b.priority;
    return bPri - aPri;
  });

  return sorted.slice(0, input.maxConcurrent);
}

// ---------------------------------------------------------------------------
// Topology Reconciliation Helper
// ---------------------------------------------------------------------------

/**
 * Shared topology reconciliation: autoArrange → validate → optimize → reconcile → emit effects.
 * Used by both handleTopologyDeclared and handleMetacogResponseReceived.
 */
function reconcileTopologyInto(
  state: KernelState,
  topology: TopologyExpr,
  effects: KernelEffectInput[],
): { state: KernelState; effects: KernelEffectInput[] } {
  // Auto-arrange: if tasks have reads/writes annotations, compute par/seq from data deps
  topology = autoArrange(topology);

  // Validate
  const validation = validateTopology(topology);
  if (!validation.valid) {
    effects.push({
      type: "emit_protocol",
      action: "os_topology_error",
      message: `invalid topology: ${validation.errors.map(e => e.message).join(", ")}`,
    });
    return { state, effects };
  }

  // Optimize
  const { optimized, warnings } = optimizeTopology(topology);
  for (const w of warnings) {
    effects.push({
      type: "emit_protocol",
      action: "os_topology_warning",
      message: `${w.type}: ${w.message}`,
    });
  }

  // Reconcile — cast blackboard to reconciler's interface (writtenBy: string|null → string|undefined)
  const reconcileEffects = reconcile(
    state.processes,
    optimized,
    state.blackboard as Map<string, { value: unknown; writtenBy?: string }>,
    state.inflight,
  );

  // Apply reconcile effects: create/kill/drain processes in state AND emit kernel effects
  const processes = new Map(state.processes);
  const drainingPids = new Set(state.drainingPids);
  const now = new Date().toISOString();

  for (const re of reconcileEffects) {
    switch (re.type) {
      case "spawn_process": {
        const pid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const newProc: OsProcess = {
          pid,
          type: "lifecycle",
          state: "running",
          name: re.name,
          parentPid: null,
          objective: re.objective,
          priority: re.priority ?? 50,
          spawnedAt: now,
          lastActiveAt: now,
          tickCount: 0,
          tokensUsed: 0,
          model: re.model ?? state.config.kernel.processModel,
          workingDir: state.processes.values().next().value?.workingDir ?? "/tmp",
          children: [],
          onParentDeath: "orphan",
          restartPolicy: "never",
        };

        // Handle non-LLM backends
        if (re.backend) {
          (newProc as any).backend = re.backend;
        }

        // Propagate capabilities from topology or default observation tools
        if (re.capabilities) {
          (newProc as any).capabilities = re.capabilities;
        } else if (state.config.observation?.enabled && (!re.backend || re.backend.kind === "llm")) {
          (newProc as any).capabilities = { observationTools: ["browser", "shell"] };
        }

        processes.set(pid, newProc);

        effects.push({
          type: "spawn_topology_process",
          name: re.name,
          objective: re.objective,
          model: re.model,
          priority: re.priority,
          backend: re.backend,
        });
        // Submit to LLM for execution
        effects.push({
          type: "submit_llm",
          pid,
          name: re.name,
          model: newProc.model,
        });
        effects.push({
          type: "emit_protocol",
          action: "os_process_spawn",
          message: `topology: spawned ${re.name} as ${pid}`,
          detail: {
            pid,
            name: re.name,
            objective: re.objective,
            model: newProc.model,
            priority: re.priority,
            backend: re.backend,
          },
        });
        break;
      }
      case "kill_process": {
        const proc = processes.get(re.pid);
        if (proc) {
          processes.set(re.pid, { ...proc, state: "dead", exitReason: "killed by topology" });
        }
        effects.push({ type: "kill_process", pid: re.pid, name: re.name });
        break;
      }
      case "drain_process": {
        drainingPids.add(re.pid);
        effects.push({ type: "drain_process", pid: re.pid, name: re.name });
        break;
      }
      case "activate_process":
        if (re.pid) {
          const proc = processes.get(re.pid);
          if (proc) {
            processes.set(re.pid, { ...proc, state: "running", lastActiveAt: now });
          }
          effects.push({ type: "activate_process", pid: re.pid });
        }
        break;
      case "emit_protocol":
        effects.push({ type: "emit_protocol", action: re.action, message: re.message });
        break;
    }
  }

  // Track all submit_llm PIDs in inflight set
  const inflight = new Set(state.inflight);
  for (const eff of effects) {
    if (eff.type === "submit_llm") {
      inflight.add(eff.pid);
    }
  }

  // Rebuild DAG topology from updated process table
  const dagNodes: OsDagTopology["nodes"] = [];
  const dagEdges: OsDagTopology["edges"] = [];
  // Build name→pid lookup for mapping topology edges to process PIDs
  const nameToPid = new Map<string, string>();
  for (const [pid, proc] of processes) {
    dagNodes.push({
      pid,
      name: proc.name,
      type: proc.type,
      state: proc.state,
      priority: proc.priority,
      parentPid: proc.parentPid,
    });
    nameToPid.set(proc.name, pid);
    if (proc.parentPid && processes.has(proc.parentPid)) {
      dagEdges.push({ from: proc.parentPid, to: pid, relation: "parent-child" });
    }
  }
  // Add topology dependency edges (from FlatGraph edges mapped to PIDs)
  const flat = flatten(topology);
  for (const edge of flat.edges) {
    const fromPid = nameToPid.get(edge.from);
    const toPid = nameToPid.get(edge.to);
    if (fromPid && toPid) {
      dagEdges.push({ from: fromPid, to: toPid, relation: "dependency", label: `${edge.from} → ${edge.to}` });
    }
  }
  const dagTopology: OsDagTopology = { nodes: dagNodes, edges: dagEdges };

  const newState: KernelState = { ...state, processes, drainingPids, inflight, dagTopology };
  return { state: newState, effects };
}

// ---------------------------------------------------------------------------
// Topology Declared Handler (delegates to reconcileTopologyInto)
// ---------------------------------------------------------------------------

function handleTopologyDeclared(state: KernelState, event: TopologyDeclaredEvent): TransitionResult {
  if (state.halted) return [state, []];

  const effects: KernelEffectInput[] = [];

  // Handle halt command
  if (event.halt) {
    return [
      { ...state, halted: true, haltReason: `metacog: ${event.halt.status} — ${event.halt.summary}` },
      assignEffectSeqs([{ type: "halt", reason: `metacog: ${event.halt.status}` }]),
    ];
  }

  // Handle memory commands (emit effects for kernel to execute)
  for (const cmd of event.memory) {
    effects.push({
      type: "emit_protocol",
      action: "os_metacog_memory",
      message: `memory command: ${cmd.kind}`,
    });
  }

  // Handle topology declaration
  if (event.topology !== null) {
    const result = reconcileTopologyInto(state, event.topology, effects);
    return [result.state, assignEffectSeqs(result.effects)];
  }

  return [state, assignEffectSeqs(effects)];
}

// ---------------------------------------------------------------------------
// Metacog Response Received Handler
// ---------------------------------------------------------------------------

/**
 * Absorbs kernel.ts parseMetacogResponse() + topology reconciliation.
 * Parses raw metacog JSON, detects format (topology vs legacy), processes
 * topology/memory/halt, records history, clears inflight flag.
 */
function handleMetacogResponseReceived(
  state: KernelState,
  event: MetacogResponseReceivedEvent,
): TransitionResult {
  // Always clear inflight
  let newState: KernelState = { ...state, metacogInflight: false };

  // Parse JSON
  let parsed: any;
  try {
    parsed = JSON.parse(event.response);
  } catch {
    // Non-JSON response — emit error, clear triggers, increment eval count
    return [
      {
        ...newState,
        pendingTriggers: [],
        metacogEvalCount: newState.metacogEvalCount + 1,
        lastMetacogTick: newState.tickCount,
      },
      assignEffectSeqs([{
        type: "emit_protocol",
        action: "os_metacog_error",
        message: "metacog response was not valid JSON",
      }]),
    ];
  }

  if (!parsed || typeof parsed !== "object") {
    return [
      {
        ...newState,
        pendingTriggers: [],
        metacogEvalCount: newState.metacogEvalCount + 1,
        lastMetacogTick: newState.tickCount,
      },
      assignEffectSeqs([{
        type: "emit_protocol",
        action: "os_metacog_error",
        message: "metacog response was not a valid object",
      }]),
    ];
  }

  // Detect format: topology-based vs legacy commands-based
  const isTopologyFormat = "topology" in parsed || "memory" in parsed;

  if (!isTopologyFormat) {
    // Legacy commands-based format — graceful passthrough
    const effects: KernelEffectInput[] = [{
      type: "emit_protocol",
      action: "os_metacog",
      message: `legacy commands format: ${Array.isArray(parsed.commands) ? parsed.commands.length : 0} commands`,
    }];
    return [
      {
        ...newState,
        pendingTriggers: [],
        metacogEvalCount: newState.metacogEvalCount + 1,
        lastMetacogTick: newState.tickCount,
      },
      assignEffectSeqs(effects),
    ];
  }

  // ── Topology format: { assessment, topology, memory, halt, citedHeuristicIds } ──
  // Topology can be an object (Claude) or a JSON string (Codex structured output)
  let topology: TopologyExpr | null = null;
  if (parsed.topology !== null && parsed.topology !== undefined) {
    if (typeof parsed.topology === "string") {
      try { topology = JSON.parse(parsed.topology); } catch { /* invalid JSON — treat as null */ }
    } else {
      topology = parsed.topology;
    }
  }
  const memory: MetacogMemoryCommand[] = Array.isArray(parsed.memory) ? parsed.memory : [];
  const halt: { status: "achieved" | "unachievable" | "stalled"; summary: string } | null = parsed.halt ?? null;
  const assessment: string = parsed.assessment ?? "";

  const effects: KernelEffectInput[] = [];

  // Record in metacogHistory
  const syntheticCommands: MetacogCommand[] = [];
  if (topology !== null) {
    syntheticCommands.push({ kind: "noop", reason: "topology declared" } as any);
  }
  for (const m of memory) {
    syntheticCommands.push(m as any);
  }
  if (halt) {
    syntheticCommands.push({ kind: "halt", status: halt.status, summary: halt.summary, reason: halt.summary } as any);
  }

  const historyEntry: MetacogHistoryEntry = {
    tick: newState.tickCount,
    assessment,
    commands: syntheticCommands,
    trigger: newState.pendingTriggers.length > 0 ? newState.pendingTriggers[0] : undefined,
  };

  const metacogHistory = [...newState.metacogHistory, historyEntry];
  const historyWindow = newState.config.awareness.historyWindow ?? 50;
  const cappedHistory = metacogHistory.length > historyWindow
    ? metacogHistory.slice(-historyWindow)
    : metacogHistory;

  // Emit observability protocol event with full structured detail
  effects.push({
    type: "emit_protocol",
    action: "os_metacog",
    message: `assessment=${assessment.slice(0, 100)} topology=${topology !== null ? "declared" : "null"} memory=${memory.length} halt=${halt?.status ?? "none"}`,
    detail: {
      assessment,
      topology,
      memory,
      halt,
    },
  });

  // Clear triggers that the metacog consumed. But preserve any triggers that
  // arrived AFTER the metacog started evaluating (e.g. a process_completed that
  // came in while the LLM call was in-flight). We detect this by checking if
  // all processes are dead — if so, the metacog needs another evaluation pass
  // before the kernel can halt, since it hasn't seen the final completions.
  const allDead = [...newState.processes.values()].every(p => p.state === "dead");
  const preservedTriggers = allDead && newState.pendingTriggers.length > 0
    ? [...newState.pendingTriggers]  // preserve — metacog hasn't seen these yet
    : [];

  // Update state with history, cleared triggers, incremented eval count
  newState = {
    ...newState,
    metacogHistory: cappedHistory,
    pendingTriggers: preservedTriggers,
    metacogEvalCount: newState.metacogEvalCount + 1,
    lastMetacogTick: newState.tickCount,
  };

  // Handle metacog self-scheduling: reschedule metacog timer if nextEvalDelayMs provided
  const nextEvalDelayMs: number | null = parsed.nextEvalDelayMs ?? null;
  if (nextEvalDelayMs !== null && nextEvalDelayMs > 0) {
    const maxInterval = newState.config.kernel.metacogIntervalMs ?? 60_000;
    const clampedDelay = Math.min(nextEvalDelayMs, maxInterval);
    effects.push({
      type: "schedule_timer",
      timer: "metacog",
      delayMs: clampedDelay,
    });
  }

  // Handle halt
  if (halt) {
    return haltWith(
      newState,
      `metacog: ${halt.status} — ${halt.summary}`,
      effects,
    );
  }

  // Handle memory commands → persist_memory effects
  for (const cmd of memory) {
    effects.push({
      type: "persist_memory",
      operation: cmd.kind,
    });
  }

  // Handle topology → reconcile
  if (topology !== null) {
    const result = reconcileTopologyInto(newState, topology, effects);
    return [result.state, assignEffectSeqs(result.effects)];
  }

  return [newState, assignEffectSeqs(effects)];
}

/**
 * Handles awareness daemon response: stores notes for next metacog context.
 */
function handleAwarenessResponseReceived(
  state: KernelState,
  event: AwarenessResponseReceivedEvent,
): TransitionResult {
  const effects: KernelEffectInput[] = [];

  // Store notes — replace semantics (consumed once by next metacog)
  const newState: KernelState = {
    ...state,
    awarenessNotes: [...event.notes],
  };

  effects.push({
    type: "emit_protocol",
    action: "os_awareness_eval",
    message: `${event.notes.length} notes, ${event.adjustments.length} adjustments`,
  });

  return [newState, assignEffectSeqs(effects)];
}

// ---------------------------------------------------------------------------
// LLM Turn Completed Handler
// ---------------------------------------------------------------------------

/**
 * Handles LLM worker process turn completion.
 * Delegates command processing to handleProcessCompleted, then adds:
 * - Tick count increment
 * - Drain check (if pid is in drainingPids, kill after processing)
 * - Remove pid from inflight
 */
function handleLlmTurnCompleted(
  state: KernelState,
  event: LlmTurnCompletedEvent,
): TransitionResult {
  // Delegate to existing command processing by converting to ProcessCompletedEvent
  const processCompletedEvent: ProcessCompletedEvent = {
    type: "process_completed",
    pid: event.pid,
    name: state.processes.get(event.pid)?.name ?? "unknown",
    success: event.success,
    commandCount: event.commands.length,
    response: event.response,
    tokensUsed: event.tokensUsed,
    commands: event.commands,
    timestamp: event.timestamp,
    seq: event.seq,
  };

  let [newState, effects] = handleProcessCompleted(state, processCompletedEvent);

  // Additional: increment tickCount
  newState = { ...newState, tickCount: newState.tickCount + 1 };

  // Additional: drain check
  if (newState.drainingPids.has(event.pid)) {
    const proc = newState.processes.get(event.pid);
    if (proc) {
      const processes = new Map(newState.processes);
      processes.set(event.pid, { ...proc, state: "dead", exitReason: "drained" });
      const drainingPids = new Set(newState.drainingPids);
      drainingPids.delete(event.pid);
      newState = { ...newState, processes, drainingPids };
    }
  }

  // Remove from inflight
  if (newState.inflight.has(event.pid)) {
    const inflight = new Set(newState.inflight);
    inflight.delete(event.pid);
    newState = { ...newState, inflight };
  }

  // If process exited (went dead), add trigger so metacog re-evaluates
  const proc = newState.processes.get(event.pid);
  if (proc && proc.state === "dead") {
    const pendingTriggers = [...newState.pendingTriggers];
    if (!pendingTriggers.includes("process_completed")) {
      pendingTriggers.push("process_completed");
    }
    newState = { ...newState, pendingTriggers };
  }

  return [newState, effects];
}

function handleMcpCallCompleted(
  state: KernelState,
  event: McpCallCompletedEvent,
): TransitionResult {
  if (state.halted) return [state, []];

  const effects: KernelEffectInput[] = [];
  const processes = new Map(state.processes);
  const blackboard = new Map(state.blackboard);

  const proc = processes.get(event.pid);
  if (!proc) return [state, []];

  // Write MCP result to blackboard so the process can read it
  const resultKey = `mcp:${proc.name}:${event.tool}`;
  blackboard.set(resultKey, {
    value: event.success ? event.result : { error: event.error },
    writtenBy: "kernel",
    version: 1,
  });

  // Wake the process
  const updatedProc = { ...proc, state: "running" as const, lastActiveAt: new Date().toISOString() };
  processes.set(event.pid, updatedProc);

  effects.push({ type: "activate_process", pid: event.pid });

  // Re-submit to LLM with the MCP result injected
  const mcpResultContext = event.success
    ? `Your mcp_call to "${event.tool}" succeeded. Result is on the blackboard at key "${resultKey}":\n\n${event.result}\n\nUse this result to proceed with your next step. Remember to read the instanceId from the result above if needed.`
    : `Your mcp_call to "${event.tool}" failed: ${event.error}\n\nYou may retry or adjust your approach.`;

  effects.push({
    type: "submit_llm",
    pid: event.pid,
    name: updatedProc.name,
    model: updatedProc.model,
    context: mcpResultContext,
  });

  effects.push({
    type: "emit_protocol",
    action: "os_mcp_result",
    message: `mcp_call_completed tool=${event.tool} pid=${event.pid} success=${event.success}`,
  });

  return [
    { ...state, processes, blackboard, inflight: new Set([...state.inflight, event.pid]) },
    assignEffectSeqs(effects),
  ];
}

function assignEffectSeqs(inputs: KernelEffectInput[]): KernelEffect[] {
  return inputs.map((input, i) => ({ ...input, seq: i }) as KernelEffect);
}
