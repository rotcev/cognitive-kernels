/**
 * transition(state, event) → [state', effects]
 *
 * The pure, deterministic core of the cognitive kernel.
 * Total function — for every valid (state, event) pair, produces exactly
 * one (state', effects) pair. No exceptions, no I/O, no randomness.
 *
 * Handles all 10 kernel event types:
 * - boot, halt_check, external_command, process_completed, ephemeral_completed
 * - timer_fired (housekeep, snapshot), metacog_evaluated, awareness_evaluated
 * - shell_output, process_submitted (observational no-op)
 */

import type { KernelState, BlackboardEntry } from "./state.js";
import type { KernelEvent, BootEvent, HaltCheckEvent, ExternalCommandEvent, ProcessCompletedEvent, EphemeralCompletedEvent, TimerFiredEvent, MetacogEvaluatedEvent, AwarenessEvaluatedEvent, ShellOutputEvent } from "./events.js";
import type { KernelEffect, KernelEffectInput } from "./effects.js";
import type { OsProcess, OsProcessCommand, DeferCondition, DeferEntry, SelfReport } from "../types.js";
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

  // Spawn memory-consolidator daemon (conditionally)
  if (event.hasNewEpisodicData && event.consolidatorObjective) {
    const consolidatorPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const consolidator: OsProcess = {
      pid: consolidatorPid,
      type: "daemon",
      state: "running",
      name: "memory-consolidator",
      parentPid: null,
      objective: event.consolidatorObjective,
      priority: 20,
      spawnedAt: now,
      lastActiveAt: now,
      tickCount: 0,
      tokensUsed: 0,
      model: state.config.kernel.processModel,
      workingDir,
      children: [],
      onParentDeath: "orphan",
      restartPolicy: "never",
    };
    processes.set(consolidatorPid, consolidator);
  } else {
    effects.push({
      type: "emit_protocol",
      action: "os_boot",
      message: "memory-consolidator skipped: no new episodic data",
    });
  }

  // Spawn goal-orchestrator
  const orchestratorPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    workingDir,
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

  // NOTE: No submit_llm effect here — boot only sets up the process topology.
  // The kernel's tick loop / scheduling pass handles actual LLM submission.

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
    workingDir,
    children: [],
    onParentDeath: "orphan",
    restartPolicy: "always",
  };
  processes.set(metacogPid, metacogDaemon);

  // Spawn awareness-daemon (conditionally)
  if (event.awarenessEnabled) {
    const awarenessPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const awarenessDaemon: OsProcess = {
      pid: awarenessPid,
      type: "daemon",
      state: "idle",
      name: "awareness-daemon",
      parentPid: null,
      objective: "Monitor metacog decision quality and inject corrective awareness notes",
      priority: 30,
      spawnedAt: now,
      lastActiveAt: now,
      tickCount: 0,
      tokensUsed: 0,
      model: event.awarenessModel ?? state.config.kernel.processModel,
      workingDir,
      children: [],
      onParentDeath: "orphan",
      restartPolicy: "on-failure",
    };
    processes.set(awarenessPid, awarenessDaemon);
    effects.push({
      type: "emit_protocol",
      action: "os_process_spawn",
      message: "boot awareness-daemon",
    });
  }

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
    }

    return [
      { ...state, processes, pendingTriggers, lastProcessCompletionTime: Date.now() },
      assignEffectSeqs(effects),
    ];
  }

  // --- Hard Spawn Enforcement ---
  // Top-level orchestrator's first tick must spawn children.
  if (
    !updatedProc.parentPid &&
    updatedProc.type === "lifecycle" &&
    updatedProc.tickCount === 1
  ) {
    const hasSpawnCommand = event.commands.some(c =>
      c.kind === "spawn_child" || c.kind === "spawn_system" || c.kind === "spawn_kernel" || c.kind === "spawn_ephemeral" || c.kind === "spawn_graph"
    );
    if (!hasSpawnCommand) {
      // Preserve bb_write commands before rejecting
      const bbWrites = event.commands.filter(c => c.kind === "bb_write");
      for (const cmd of bbWrites) {
        if (cmd.kind === "bb_write") {
          processBlackboardWrite(blackboard, updatedProc, cmd.key, cmd.value);
        }
      }
      effects.push({
        type: "emit_protocol",
        action: "os_command_rejected",
        message: `tick 0 rejected: orchestrator produced zero spawn commands — must design topology and spawn child processes (preserved ${bbWrites.length} bb_write commands)`,
      });
      processes.set(event.pid, updatedProc);
      return [
        { ...state, processes, blackboard, pendingTriggers, lastProcessCompletionTime: Date.now() },
        assignEffectSeqs(effects),
      ];
    }
  }

  // --- Architect-Phase Deadlock Enforcement ---
  if (
    !updatedProc.parentPid &&
    updatedProc.type === "lifecycle" &&
    updatedProc.tickCount >= 1
  ) {
    const hasLifecycleChildren = [...processes.values()].some(
      p => p.parentPid === updatedProc.pid && p.type === "lifecycle"
    );
    const hasScoutResults = [...blackboard.keys()].some(
      key => key.startsWith("ephemeral:") || key.startsWith("scout:")
    );
    const spawnsLifecycle = event.commands.some(c =>
      c.kind === "spawn_child" || c.kind === "spawn_graph"
    );

    if (!hasLifecycleChildren && hasScoutResults && !spawnsLifecycle) {
      // Preserve bb_write and ephemeral commands
      const preservable = event.commands.filter(c => c.kind === "bb_write" || c.kind === "spawn_ephemeral");
      for (const cmd of preservable) {
        if (cmd.kind === "bb_write") {
          processBlackboardWrite(blackboard, updatedProc, cmd.key, cmd.value);
        }
      }
      // Ephemeral spawn effects from preservable commands
      for (const cmd of preservable) {
        if (cmd.kind === "spawn_ephemeral") {
          const [ephProc, ephEffects] = processSpawnEphemeral(state, processes, updatedProc, cmd);
          if (ephProc) {
            processes.set(ephProc.pid, ephProc);
            effects.push(...ephEffects);
          }
        }
      }
      effects.push({
        type: "emit_protocol",
        action: "os_command_rejected",
        message: `architect-phase deadlock: scout data available but no lifecycle children spawned (preserved ${preservable.length} commands)`,
      });
      processes.set(event.pid, updatedProc);
      return [
        { ...state, processes, blackboard, deferrals, pendingTriggers, lastProcessCompletionTime: Date.now() },
        assignEffectSeqs(effects),
      ];
    }
  }

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

      case "spawn_child": {
        const [childProc, spawnEffects, deferEntry] = processSpawnChild(state, processes, deferrals, updatedProc, cmd);
        if (deferEntry) {
          deferrals.set(deferEntry.id, deferEntry);
          effects.push(...spawnEffects);
        } else if (childProc) {
          processes.set(childProc.pid, childProc);
          // Register as child
          updatedProc.children = [...(updatedProc.children ?? []), childProc.pid];
          effects.push(...spawnEffects);
        }
        break;
      }

      case "spawn_graph": {
        let immediateCount = 0;
        let deferredCount = 0;
        for (const node of cmd.nodes) {
          const nodeDescriptor = {
            type: node.type as "daemon" | "lifecycle" | "event",
            name: node.name,
            objective: node.objective,
            priority: node.priority ?? 50,
            completionCriteria: node.completionCriteria,
            capabilities: node.capabilities,
            parentPid: event.pid,
            model: state.config.kernel.processModel,
            workingDir: updatedProc.workingDir,
          };

          if (!node.after || node.after.length === 0) {
            // Immediate spawn
            const childPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
            const child: OsProcess = {
              pid: childPid,
              ...nodeDescriptor,
              state: "running",
              spawnedAt: now,
              lastActiveAt: now,
              tickCount: 0,
              tokensUsed: 0,
              children: [],
              onParentDeath: "orphan",
              restartPolicy: "never",
            };
            processes.set(childPid, child);
            updatedProc.children = [...(updatedProc.children ?? []), childPid];
            immediateCount++;
            effects.push({
              type: "emit_protocol",
              action: "os_process_spawn",
              message: `parent=${event.pid} (graph immediate: "${node.name}")`,
            });
            effects.push({
              type: "submit_llm",
              pid: childPid,
              name: node.name,
              model: state.config.kernel.processModel,
            });
          } else {
            // Parse after strings into DeferCondition
            const conditions: DeferCondition[] = node.after.map(dep => {
              if (dep.includes(":")) {
                return { type: "blackboard_key_exists" as const, key: dep };
              }
              return { type: "process_dead_by_name" as const, name: dep };
            });
            const condition: DeferCondition = conditions.length === 1
              ? conditions[0]!
              : { type: "all_of", conditions };

            // Dedup check
            const hasDup = [...deferrals.values()].some(
              d => d.descriptor.name === node.name && d.registeredByPid === event.pid
            );
            if (hasDup) {
              effects.push({
                type: "emit_protocol",
                action: "os_command_rejected",
                message: `defer dedup: graph node "${node.name}" already has pending deferral`,
              });
              continue;
            }

            const ds: DeferEntry = {
              id: randomUUID(),
              descriptor: nodeDescriptor,
              condition,
              registeredAt: now,
              registeredAtMs: Date.now(),
              registeredByTick: state.tickCount,
              registeredByPid: event.pid,
              reason: `graph node "${node.name}" after=[${node.after.join(", ")}]`,
            };
            deferrals.set(ds.id, ds);
            deferredCount++;
            effects.push({
              type: "emit_protocol",
              action: "os_defer",
              message: `graph deferred: "${node.name}" after=[${node.after.join(", ")}]`,
            });
          }
        }
        effects.push({
          type: "emit_protocol",
          action: "os_defer",
          message: `spawn_graph: ${immediateCount} immediate, ${deferredCount} deferred (${cmd.nodes.length} total nodes)`,
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

      case "spawn_system": {
        if (!state.config.systemProcess?.enabled) {
          effects.push({
            type: "emit_protocol",
            action: "os_command_rejected",
            message: "spawn_system rejected: systemProcess.enabled is false",
          });
          break;
        }
        const systemCount = [...processes.values()].filter(
          p => p.backend?.kind === "system" && p.state !== "dead"
        ).length;
        if (systemCount >= state.config.systemProcess.maxSystemProcesses) {
          effects.push({
            type: "emit_protocol",
            action: "os_command_rejected",
            message: `spawn_system rejected: max system processes (${state.config.systemProcess.maxSystemProcesses}) reached`,
          });
          break;
        }
        const sysPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const sysChild: OsProcess = {
          pid: sysPid,
          type: "lifecycle",
          state: "running",
          name: cmd.name,
          parentPid: event.pid,
          objective: `System process: ${cmd.command} ${(cmd.args ?? []).join(" ")}`,
          priority: 50,
          spawnedAt: now,
          lastActiveAt: now,
          tickCount: 0,
          tokensUsed: 0,
          model: state.config.kernel.processModel,
          workingDir: updatedProc.workingDir,
          children: [],
          onParentDeath: "orphan",
          restartPolicy: "never",
          backend: { kind: "system", command: cmd.command, args: cmd.args, env: cmd.env },
        };
        processes.set(sysPid, sysChild);
        updatedProc.children = [...(updatedProc.children ?? []), sysPid];
        effects.push({
          type: "start_shell",
          pid: sysPid,
          name: cmd.name,
          command: cmd.command,
          args: cmd.args ?? [],
        });
        effects.push({
          type: "emit_protocol",
          action: "os_system_spawn",
          message: `command=${cmd.command} parent=${event.pid}`,
        });
        break;
      }

      case "spawn_kernel": {
        if (!state.config.childKernel?.enabled) {
          effects.push({
            type: "emit_protocol",
            action: "os_command_rejected",
            message: "spawn_kernel rejected: childKernel.enabled is false",
          });
          break;
        }
        if (state.config.kernel.parentKernelId) {
          effects.push({
            type: "emit_protocol",
            action: "os_command_rejected",
            message: "spawn_kernel rejected: this kernel is already a child (depth limit)",
          });
          break;
        }
        const kernelCount = [...processes.values()].filter(
          p => p.backend?.kind === "kernel" && p.state !== "dead"
        ).length;
        if (kernelCount >= state.config.childKernel.maxChildKernels) {
          effects.push({
            type: "emit_protocol",
            action: "os_command_rejected",
            message: `spawn_kernel rejected: max child kernels (${state.config.childKernel.maxChildKernels}) reached`,
          });
          break;
        }
        const kPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const kernelChild: OsProcess = {
          pid: kPid,
          type: "lifecycle",
          state: "running",
          name: cmd.name,
          parentPid: event.pid,
          objective: `Sub-kernel: ${cmd.goal}`,
          priority: 50,
          spawnedAt: now,
          lastActiveAt: now,
          tickCount: 0,
          tokensUsed: 0,
          model: state.config.kernel.processModel,
          workingDir: updatedProc.workingDir,
          children: [],
          onParentDeath: "orphan",
          restartPolicy: "never",
          backend: { kind: "kernel", goal: cmd.goal, maxTicks: cmd.maxTicks },
        };
        processes.set(kPid, kernelChild);
        updatedProc.children = [...(updatedProc.children ?? []), kPid];
        effects.push({
          type: "start_subkernel",
          pid: kPid,
          name: cmd.name,
          goal: cmd.goal,
        });
        effects.push({
          type: "emit_protocol",
          action: "os_subkernel_spawn",
          message: `goal=${cmd.goal} parent=${event.pid}`,
        });
        break;
      }

      case "exit": {
        // Executive Exit Prevention — orchestrator must not exit while topology is active
        if (
          !updatedProc.parentPid &&
          updatedProc.type === "lifecycle" &&
          updatedProc.name === "goal-orchestrator"
        ) {
          const livingChildren = [...processes.values()].filter(
            p => p.parentPid === event.pid && p.state !== "dead"
          );
          if (livingChildren.length > 0 || deferrals.size > 0) {
            updatedProc.state = "idle";
            updatedProc.wakeOnSignals = livingChildren.length > 0
              ? ["child:done"]
              : ["tick:1", "child:done"];
            effects.push({
              type: "emit_protocol",
              action: "os_command_rejected",
              message: `executive exit prevented: ${livingChildren.length} living children, ${deferrals.size} pending deferrals`,
            });
            pendingTriggers.push("goal_drift");
            break;
          }
        }

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
        }
        break;
      }
    }
  }

  // --- Auto-exit daemons ---
  // Daemons that complete a turn without issuing exit/idle/sleep/checkpoint are done
  const hasLifecycleCmd = event.commands.some(
    c => c.kind === "exit" || c.kind === "idle" || c.kind === "sleep" || c.kind === "checkpoint"
  );
  if (!hasLifecycleCmd && updatedProc.type === "daemon" && updatedProc.state === "running") {
    updatedProc.state = "dead";
    updatedProc.exitReason = "auto-exit: daemon completed turn without lifecycle command";
    effects.push({
      type: "emit_protocol",
      action: "os_process_exit",
      message: "auto-exit: daemon completed turn without lifecycle command",
    });
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
    type: "submit_ephemeral",
    pid: ephPid,
    ephemeralId: `eph-${randomUUID().slice(0, 12)}`,
    name: ephName,
    model: ephModel,
  });

  return [ephProc, effects];
}

function handleExternalCommand(state: KernelState, event: ExternalCommandEvent): TransitionResult {
  switch (event.command) {
    case "halt":
      return haltWith(state, "external_halt", [
        { type: "emit_protocol", action: "os_external_command", message: "halt requested" },
      ]);
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
    case "watchdog":
      // Metacog and watchdog are I/O-heavy (LLM calls).
      // Transition passes through — kernel handles via existing code paths.
      return [state, []];
    default:
      return [state, []];
  }
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
    }
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
      }
    }
  }

  // 2b. Restore checkpointed processes (pure: set state from checkpoint to running)
  for (const [pid, proc] of processes) {
    if (proc.state === "checkpoint") {
      const updated = { ...proc, state: "running" as const, lastActiveAt: now };
      processes.set(pid, updated);
    }
  }

  // 3. Stall detection
  const liveEphemeralCount = [...processes.values()].filter(
    p => p.type === "event" && p.state !== "dead"
  ).length;
  const pendingEphemeralCount = event.pendingEphemeralCount ?? 0;

  let consecutiveIdleTicks = state.consecutiveIdleTicks;
  if (state.inflight.size === 0 && liveEphemeralCount === 0) {
    consecutiveIdleTicks += 1;

    // Wall-clock stall: 5s with no inflight work
    const wallStall = state.lastProcessCompletionTime > 0 &&
      (nowMs - state.lastProcessCompletionTime) > 5_000;

    if (consecutiveIdleTicks >= 3 || wallStall) {
      const idleProcs = [...processes.values()].filter(p => p.state === "idle");
      if (idleProcs.length > 0) {
        // Force-wake all idle processes
        for (const proc of idleProcs) {
          const updated = { ...proc, state: "running" as const, lastActiveAt: now };
          processes.set(proc.pid, updated);
        }
        effects.push({
          type: "emit_protocol",
          action: "os_process_event",
          message: `stall_detected: force-woke ${idleProcs.length} idle processes after ${consecutiveIdleTicks} housekeep cycles (${state.lastProcessCompletionTime ? Math.round((nowMs - state.lastProcessCompletionTime) / 1000) + 's' : '?'} since last completion)`,
        });
        consecutiveIdleTicks = 0;
      }
    }
  } else {
    consecutiveIdleTicks = 0;
  }

  // 4. Phase-transition deadlock detection
  const orchestrator = [...processes.values()].find(p => !p.parentPid && p.type === "lifecycle");
  if (orchestrator && orchestrator.state === "idle" && orchestrator.tickCount >= 1) {
    const allLivingWork = [...processes.values()].filter(
      p => p.pid !== orchestrator.pid && p.state !== "dead" && p.type !== "daemon"
    );
    const totalPendingEphemerals = pendingEphemeralCount + liveEphemeralCount;
    if (allLivingWork.length === 0 && totalPendingEphemerals === 0) {
      const pendingDeferrals = deferrals.size;
      const bbKeyCount = event.bbKeyCount ?? 0;
      const bbKeysAtLastForceWake = event.bbKeysAtLastForceWake ?? 0;
      const lastForceWakeTime = event.lastForceWakeTime ?? 0;
      const bbChanged = bbKeyCount !== bbKeysAtLastForceWake;
      const wallCooldownExpired = (nowMs - lastForceWakeTime) > 10_000;
      const nothingLeft = pendingDeferrals === 0 && allLivingWork.length === 0;

      if (nothingLeft || bbChanged || wallCooldownExpired) {
        const updated = { ...orchestrator, state: "running" as const, lastActiveAt: now };
        processes.set(orchestrator.pid, updated);
        effects.push({
          type: "emit_protocol",
          action: "os_process_event",
          message: `deadlock_detected: orchestrator idle with 0 living work, 0 pending ephemerals, ${pendingDeferrals} deferrals — force-waking (nothingLeft=${nothingLeft}, bbChanged=${bbChanged}, wallCooldown=${wallCooldownExpired})`,
        });
      }
    }
  }

  // 5. Dead executive recovery
  const deadOrchestrator = [...processes.values()].find(
    p => !p.parentPid && p.type === "lifecycle" && p.state === "dead" && p.name === "goal-orchestrator"
  );
  if (deadOrchestrator) {
    const livingGoalProcesses = [...processes.values()].filter(
      p => p.pid !== deadOrchestrator.pid && p.state !== "dead" && p.type === "lifecycle"
    );
    const hasPendingDeferrals = deferrals.size > 0;

    if (livingGoalProcesses.length > 0 || hasPendingDeferrals) {
      // Respawn orchestrator
      const newOrchPid = `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const newOrch: OsProcess = {
        pid: newOrchPid,
        type: "lifecycle",
        state: "running",
        name: "goal-orchestrator",
        parentPid: null,
        objective: state.goal,
        priority: deadOrchestrator.priority,
        spawnedAt: now,
        lastActiveAt: now,
        tickCount: 0,
        tokensUsed: 0,
        model: deadOrchestrator.model,
        workingDir: deadOrchestrator.workingDir,
        children: [],
        onParentDeath: "orphan",
        restartPolicy: "never",
      };

      // Reparent orphaned lifecycle children
      for (const proc of livingGoalProcesses) {
        if (!proc.parentPid && proc.type === "lifecycle") {
          const updated = { ...proc, parentPid: newOrchPid };
          processes.set(proc.pid, updated);
          newOrch.children.push(proc.pid);
        }
      }

      processes.set(newOrchPid, newOrch);
      pendingTriggers.push("process_failed");

      effects.push({
        type: "submit_llm",
        pid: newOrchPid,
        name: "goal-orchestrator",
        model: newOrch.model,
      });

      effects.push({
        type: "emit_protocol",
        action: "os_process_event",
        message: `dead_executive_recovery: restarted orchestrator as ${newOrchPid}, reparented ${livingGoalProcesses.filter(p => p.type === "lifecycle").length} orphans, ${deferrals.size} deferrals pending`,
      });
    }
  }

  return [
    {
      ...state,
      processes,
      pendingTriggers,
      deferrals,
      housekeepCount,
      consecutiveIdleTicks,
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
  const pendingTriggers: string[] = [];

  effects.push({
    type: "emit_protocol",
    action: "os_metacog_eval",
    message: `metacog evaluated: ${event.commandCount} commands, ${event.triggerCount} triggers consumed`,
  });

  return [
    {
      ...state,
      pendingTriggers,
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
  const now = new Date().toISOString();

  const proc = processes.get(event.pid);
  if (!proc) return [state, []];

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

    // Notify parent via bb write
    const blackboard = new Map(state.blackboard);
    blackboard.set(`shell:exit:${event.pid}`, {
      value: { exitCode: event.exitCode, pid: event.pid },
      writtenBy: "kernel",
      version: 1,
    });

    effects.push({
      type: "emit_protocol",
      action: "os_system_exit",
      message: `shell pid=${event.pid} name=${proc.name} exitCode=${event.exitCode}`,
    });

    // Signal parent process
    if (proc.parentPid) {
      effects.push({
        type: "wake_process",
        pid: proc.parentPid,
      });
    }

    return [
      { ...state, processes, blackboard },
      assignEffectSeqs(effects),
    ];
  }

  // Output received but process still running — update lastActiveAt
  const updated = { ...proc, lastActiveAt: now };
  processes.set(event.pid, updated);

  return [
    { ...state, processes },
    assignEffectSeqs(effects),
  ];
}

/** Assign monotonic seq numbers to effect inputs. */
function assignEffectSeqs(inputs: KernelEffectInput[]): KernelEffect[] {
  return inputs.map((input, i) => ({ ...input, seq: i }) as KernelEffect);
}
