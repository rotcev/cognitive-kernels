import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  OsConfig,
  OsProcess,
  OsProcessDescriptor,
  OsProcessCommand,
  OsMetacogTrigger,
  OsProcessEvent,
  MetacogContext,
  MetacogCommand,
  MetacogResponse,
  OsSystemSnapshot,
  OsDagDelta,
  OsIpcSummary,
  OsProgressMetrics,
  SelectedBlueprintInfo,
  TopologyBlueprint,
  BlueprintGatingStrategy,
  OsProcessType,
  SchedulingStrategy,
  InterventionRecord,
  InterventionSnapshot,
  TopologySnapshot,
  SelfReport,
  KillEvalRecord,
  DagMutation,
  MetacogHistoryEntry,
  AwarenessContext,
  ProgressSnapshot,
  HeuristicApplicationEntry,
  AwarenessAdjustment,
  OsProcessTurnResult,
  DeferEntry,
  DeferCondition,
} from "./types.js";
import type { Brain } from "../types.js";
import { OsProcessTable } from "./process-table.js";
import { OsProcessSupervisor } from "./process-supervisor.js";
import { OsScheduler } from "./scheduler.js";
import { OsIpcBus } from "./ipc-bus.js";
import { OsDagEngine } from "./dag-engine.js";
import { extractGoalTags as extractGoalTagsFromGoal } from "./memory-store.js";
import { ScopedMemoryStore } from "./scoped-memory-store.js";
import { OsMetacognitiveAgent } from "./metacog-agent.js";
import { OsProcessExecutor } from "./process-executor.js";
import { ProcessExecutorRouter } from "./executor-router.js";
import { LlmExecutorBackend } from "./llm-executor.js";
import { ShellExecutorBackend } from "./shell-executor.js";
import { SubkernelExecutorBackend } from "./subkernel-executor.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";
import { TelemetryCollector } from "./telemetry.js";
import { PerfAnalyzer } from "./perf-analyzer.js";
import type { Recommendation } from "./perf-analyzer.js";
import { SelfOptimizer } from "./self-optimizer.js";
import { CounterfactualSimulator } from "./counterfactual-simulator.js";
import type { KernelAction } from "./counterfactual-simulator.js";
import type { BlueprintTaskRecord } from "./types.js";
import { AwarenessDaemon } from "./awareness-daemon.js";
import { AsyncMutex } from "./async-mutex.js";


export class OsKernel {
  readonly runId = randomUUID();
  private readonly config: OsConfig;
  private readonly table: OsProcessTable;
  private readonly supervisor: OsProcessSupervisor;
  private readonly scheduler: OsScheduler;
  private readonly ipcBus: OsIpcBus;
  private readonly dagEngine: OsDagEngine;
  private readonly memoryStore: ScopedMemoryStore;
  private readonly executor: OsProcessExecutor;
  private readonly router: ProcessExecutorRouter;
  private metacog: OsMetacognitiveAgent;
  private goal = "";
  private halted = false;
  private haltReason = "";
  private startTime = 0;
  private lastMetacogTick = 0;
  private lastMetacogWakeAt = 0;
  private pendingTriggers: OsMetacogTrigger[] = [];
  private readonly client: Brain;
  private readonly workingDir: string;
  private readonly emitter?: OsProtocolEmitter;
  private snapshotCadence = 1;
  private tickSignals: string[] = [];
  private selectedBlueprintInfo: SelectedBlueprintInfo | null = null;
  private activeStrategyId?: string;
  private activeStrategies: SchedulingStrategy[] = [];
  private pendingInterventions: InterventionRecord[] = [];
  private blueprintDerivedTokenBudget = 0;
  private readonly telemetryCollector = new TelemetryCollector();
  private lastPerfRecommendations: Recommendation[] = [];
  /** GAP 2: Counterfactual simulator — ring buffer of process-table snapshots. */
  private readonly counterfactualSim = new CounterfactualSimulator(20);
  /** Consecutive ticks where zero processes were scheduled — stall detection. */
  private consecutiveIdleTicks = 0;
  private housekeepCount = 0;
  private lastProcessCompletionTime = 0;
  private lastForceWakeTime = 0;
  /** Timestamp when we first noticed only daemons remain (0 = not in grace period). */
  private goalWorkDoneAt = 0;
  /** Tick number of the last orchestrator force-wake — prevents runaway deadlock loops. */
  private lastOrchestratorForceWakeTick = -1;
  /** Blackboard key count at the last orchestrator force-wake — detects meaningful progress. */
  private bbKeysAtLastForceWake = 0;
  /** Pending ephemeral descriptors — fired async, drained after process turns complete. */
  private pendingEphemerals: Array<{
    pid: string;
    ephemeralId: string;
    tablePid: string;
    name: string;
    model: string;
    prompt: string;
    workingDir: string;
    startTime: number;
  }> = [];
  /** GAP 2: Human-readable counterfactual result strings for metacog context. */
  private recentCounterfactualLogs: string[] = [];
  /** GAP 1 (R6): Kill evaluation history for calibrating kill aggressiveness. */
  private killEvalHistory: KillEvalRecord[] = [];
  /** GAP 3 (R6): History of dag rewrites for observability. */
  private dagRewriteHistory: Array<{timestamp: number; mutationType: string; reason: string; pidsAffected: string[]}> = [];

  /** Kill threshold adjustment accumulated from kill eval history and awareness adjustments. */
  private killThresholdAdjustment = 0.0;
  /** Log of heuristic applications for retrospective validation. */
  private heuristicApplicationLog: HeuristicApplicationEntry[] = [];
  /** Current metacog focus area set by awareness daemon (consume-once). */
  private metacogFocus: string | null = null;
  /** Pending oscillation warnings from awareness daemon (consume-once). */
  private pendingOscillationWarnings: Array<{processType: string; killCount: number; respawnCount: number; windowTicks: number}> = [];
  /** Pending blind spots detected by awareness daemon (consume-once). */
  private pendingBlindSpots: Array<{unusedCommandKind: string; ticksSinceLastUse: number}> = [];

  /** Awareness daemon — meta-metacognitive layer. */
  private awarenessDaemon: AwarenessDaemon | null = null;
  /** Pending notes from awareness daemon to inject into next metacog context. */
  private pendingAwarenessNotes: string[] = [];
  /** Tracks cumulative line count per shell stream to emit only deltas. */
  private shellOutputCursors = new Map<string, number>();
  /** Count of metacog evaluations — used to determine awareness cadence. */
  private metacogEvalCount = 0;
  /** Rolling history of metacog decisions for awareness daemon context. */
  private metacogHistory: MetacogHistoryEntry[] = [];
  /** Timeline of system progress snapshots for awareness daemon context. */
  private progressTimeline: ProgressSnapshot[] = [];
  private lastProgressTick = -1;
  /** Tick of last awareness evaluation. */
  private lastAwarenessTick = 0;
  /** LLM-matched strategy IDs from boot-time classification (cached for the run). */
  private bootMatchedStrategyIds: Set<string> | null = null;

  /** Watchdog timer for detecting tick stalls. */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-process kill callbacks — watchdog resolves these to unblock executeProcesses. */
  private turnKillCallbacks: Map<string, () => void> = new Map();
  /** Per-process turn start times — watchdog reports durations to metacog. */
  private turnStartTimes: Map<string, number> = new Map();
  /** Per-process timestamp of the last received LLM stream event — used by watchdog to detect inference liveness. */
  private lastStreamEventAt: Map<string, number> = new Map();
  /** Per-process count of stream events this turn — used by watchdog to compute event rate. */
  private streamTokenCount: Map<string, number> = new Map();
  /** Whether a tick is currently executing (executeProcesses is in flight). */
  private tickInProgress = false;
  /** Mutex: prevents concurrent metacog evaluations (tick-based vs watchdog-based). */
  private metacogInFlight = false;
  /** Registry of deferrals — processes waiting for conditions to be met before spawning. */
  private deferrals: Map<string, DeferEntry> = new Map();
  /** Mutex for serializing state mutations in event-driven mode. */
  private mutex = new AsyncMutex();
  /** In-flight LLM execution promises keyed by PID. */
  private inflight = new Map<string, Promise<OsProcessTurnResult>>();
  /** Resolve function for the event-loop promise — called when shouldHalt() becomes true. */
  private haltResolve: (() => void) | null = null;
  /** Periodic housekeeping timer (replaces tick-based scheduling). */
  private housekeepTimer: ReturnType<typeof setInterval> | null = null;
  /** Periodic snapshot timer. */
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  /** Periodic metacog evaluation timer. */
  private metacogTimer: ReturnType<typeof setTimeout> | null = null;
  /** Count of ephemerals currently executing (fire-and-forget, not in inflight map). */
  private activeEphemeralCount = 0;
  /** Active ephemeral threads keyed by tablePid — abort these on kill to stop wasting tokens. */
  private ephemeralThreads: Map<string, import("../types.js").BrainThread> = new Map();
  private readonly browserMcpConfig?: import("../types.js").McpServerConfig;

  constructor(
    config: OsConfig,
    client: Brain,
    workingDir: string,
    emitter?: OsProtocolEmitter,
    browserMcpConfig?: import("../types.js").McpServerConfig,
  ) {
    this.config = config;
    this.client = client;
    this.workingDir = workingDir;
    this.emitter = emitter;
    this.browserMcpConfig = browserMcpConfig;

    this.table = new OsProcessTable();
    this.supervisor = new OsProcessSupervisor(this.table, config.processes);
    this.scheduler = new OsScheduler(config.scheduler);
    this.ipcBus = new OsIpcBus(config.ipc);
    this.dagEngine = new OsDagEngine();
    this.memoryStore = new ScopedMemoryStore(config.memory, workingDir);
    this.executor = new OsProcessExecutor({
      client,
      workingDir,
      browserMcpConfig,
    });

    // Build the executor router with all three backends
    const llmBackend = new LlmExecutorBackend({ client, workingDir, browserMcpConfig });
    const shellBackend = new ShellExecutorBackend({
      stdoutBufferLines: config.systemProcess?.stdoutBufferLines ?? 200,
    });
    const subkernelBackend = new SubkernelExecutorBackend({
      client,
      parentConfig: config,
      parentRunId: this.runId,
      workingDir,
      emitter,
    });
    this.router = new ProcessExecutorRouter([llmBackend, shellBackend, subkernelBackend]);

    // Wire streaming: route LLM stream events through the protocol emitter
    if (this.emitter) {
      const emitterRef = this.emitter;
      const streamHandler = (pid: string, processName: string, event: import("../types.js").StreamEvent) => {
        emitterRef.emitStreamEvent(pid, processName, event);
        // Track inference liveness for watchdog
        this.lastStreamEventAt.set(pid, Date.now());
        this.streamTokenCount.set(pid, (this.streamTokenCount.get(pid) ?? 0) + 1);
      };
      this.executor.setStreamCallback(streamHandler);
      this.router.setStreamCallback(streamHandler);
    }

    // Initialize awareness daemon (activated in boot() when config enables it)
    if (this.config.awareness.enabled) {
      this.awarenessDaemon = new AwarenessDaemon(
        this.config.awareness.model,
        client,
        workingDir,
        emitter,
      );
    }

    // Initialize metacog with a placeholder goal; boot() will reinitialize
    this.metacog = new OsMetacognitiveAgent(
      config.kernel.metacogModel,
      "",
      client,
      workingDir,
    );
  }

  boot(goal: string, options?: { restoreFromRunId?: string }): void {
    this.goal = goal;
    this.startTime = Date.now();
    // GAP 2: configure counterfactual simulator tick interval
    this.counterfactualSim.setMsPerTick(this.config.kernel.tickIntervalMs);

    this.emitter?.emit({
      action: "os_boot",
      status: "started",
      message: `goal=${goal}`,
    });

    // Initialize metacog agent with the actual goal
    this.metacog = new OsMetacognitiveAgent(
      this.config.kernel.metacogModel,
      goal,
      this.client,
      this.workingDir,
    );

    // Load heuristics and blueprints from memory store
    this.memoryStore.loadHeuristics();
    this.memoryStore.loadBlueprints();

    // Restore kill calibration from prior run
    const priorCalibration = this.memoryStore.getKillCalibration();
    if (priorCalibration) {
      this.killEvalHistory = priorCalibration.killEvalHistory;
      this.killThresholdAdjustment = priorCalibration.killThresholdAdjustment;
    }

    // Compute blueprint-derived token budget for child processes (only when per-process budgets are enabled)
    if (this.config.kernel.processTokenBudgetEnabled) {
      const allBpForBudget = this.memoryStore.queryBlueprints('');
      const budgetBp = allBpForBudget.find(bp => bp.stats.avgTokenEfficiency > 0);
      if (budgetBp) {
        this.blueprintDerivedTokenBudget = Math.round(budgetBp.stats.avgTokenEfficiency * 1.5);
      }
    }

    // Load scheduling strategies and pass to kernel for tick-level use
    const strategies = this.memoryStore.getSchedulingStrategies();
    this.activeStrategies = strategies;

    // Spawn memory-consolidation daemon only if there's new episodic data to consolidate
    if (this.memoryStore.hasNewEpisodicData()) {
      const consolidatorObjective = this.buildConsolidatorObjective();
      const daemonProc = this.supervisor.spawn({
        type: "daemon",
        name: "memory-consolidator",
        objective: consolidatorObjective,
        priority: 20,
        model: this.config.kernel.processModel,
        workingDir: this.workingDir,
        restartPolicy: "never",
      });
      this.supervisor.activate(daemonProc.pid);
    } else {
      this.emitter?.emit({
        action: "os_boot",
        status: "completed",
        message: "memory-consolidator skipped: no new episodic data",
      });
    }

    // Spawn the goal-orchestrator — this is the primary process that works on the goal.
    // It decomposes the objective into subtasks and can spawn child processes.
    const goalProc = this.supervisor.spawn({
      type: "lifecycle",
      name: "goal-orchestrator",
      objective: goal,
      priority: 90,
      model: this.config.kernel.processModel,
      workingDir: this.workingDir,
      restartPolicy: "never",
    });

    this.supervisor.activate(goalProc.pid);

    this.emitter?.emit({
      action: "os_process_spawn",
      status: "completed",
      agentId: goalProc.pid,
      agentName: goalProc.name,
      message: `boot goal-orchestrator`,
    });

    // Pre-seed design guidelines to blackboard — readable by all processes,
    // persists beyond context compression, visible to orchestrator on tick 0.
    this.ipcBus.bbWrite("system:design-guidelines", [
      "This system solves problems by spawning cognitive sub-processes.",
      "The topology (which processes exist, how they coordinate) IS the algorithm.",
      "Design the shape of the computation, then let processes execute it.",
      "Key primitives: spawn, kill, fork, join, checkpoint, restore.",
      "Blackboard is shared memory — write results there for other processes to read.",
      "Observation is mandatory: produce → observe → proceed. Never assume success.",
    ].join("\n"), "kernel");

    // Gap 5: Spawn metacog as a first-class daemon process.
    // The process executor handles this daemon specially during tick():
    // it reads from 'metacog:system-state', calls MetacogAgent.evaluate(),
    // and pushes commands to 'metacog:commands'.
    const metacogDaemonProc = this.supervisor.spawn({
      type: "daemon",
      name: "metacog-daemon",
      priority: 50,
      objective: "Periodically evaluate system state and issue metacognitive commands",
      model: this.config.kernel.metacogModel,
      workingDir: this.workingDir,
      restartPolicy: "always",
    });
    // Must transition through "running" first (spawned → running → idle is the valid path)
    this.supervisor.activate(metacogDaemonProc.pid);
    this.supervisor.idle(metacogDaemonProc.pid, {});

    // Spawn awareness-daemon — meta-metacognitive layer
    if (this.config.awareness.enabled) {
      const awarenessDaemonProc = this.supervisor.spawn({
        type: "daemon",
        name: "awareness-daemon",
        objective: "Monitor metacog decision quality and inject corrective awareness notes",
        priority: 30,
        model: this.config.awareness.model,
        workingDir: this.workingDir,
        restartPolicy: "on-failure",
      });
      this.supervisor.activate(awarenessDaemonProc.pid);
      this.supervisor.idle(awarenessDaemonProc.pid, {});

      this.emitter?.emit({
        action: "os_process_spawn",
        status: "completed",
        agentId: awarenessDaemonProc.pid,
        agentName: awarenessDaemonProc.name,
        message: `boot awareness-daemon`,
      });
    }

    // Prune old checkpoints on every boot
    this.memoryStore.pruneCheckpoints();

    // Restore processes from a prior run if requested
    if (options?.restoreFromRunId) {
      this.restoreFromPriorRun(options.restoreFromRunId);
    }
  }

  async run(goal: string, options?: { restoreFromRunId?: string }): Promise<OsSystemSnapshot> {
    this.boot(goal, options);
    this.emitter?.writeLiveState(this.snapshot());

    // One-shot LLM classification of which stored strategies are relevant to this goal.
    // Runs before the first tick so the scheduler has learned strategies from tick 1.
    await this.matchStrategiesAtBoot();

    // Event-driven loop
    await this.eventLoop();

    this.shutdown();
    const snap = this.snapshot();
    this.emitter?.saveSnapshot(snap);
    await this.emitter?.close();
    return snap;
  }

  private async eventLoop(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.haltResolve = () => {
        if (this.halted) return; // prevent duplicate halt sequences
        this.halted = true;
        this.stopEventLoop();
        // Wait for any in-flight processes to settle, then resolve
        if (this.inflight.size > 0) {
          void Promise.allSettled([...this.inflight.values()]).then(() => resolve());
        } else {
          resolve();
        }
      };

      // Start background timers
      this.housekeepTimer = setInterval(() => {
        this.safeHousekeep();
      }, this.config.kernel.housekeepIntervalMs ?? 500);
      (this.housekeepTimer as NodeJS.Timeout).unref?.();

      this.snapshotTimer = setInterval(() => {
        this.safeSnapshotWrite();
      }, this.config.kernel.snapshotIntervalMs ?? 10_000);
      (this.snapshotTimer as NodeJS.Timeout).unref?.();

      // Self-scheduling metacog: fires once at boot, then reschedules based on
      // metacog's own nextWakeMs (capped at metacogIntervalMs as fallback max).
      this.scheduleNextMetacog(120_000); // first check 2min after boot — scouts need time


      this.startWatchdog();

      // Initial housekeep + scheduling pass
      this.housekeep();
      this.doSchedulingPass();
    });
  }

  private stopEventLoop(): void {
    if (this.housekeepTimer) { clearInterval(this.housekeepTimer); this.housekeepTimer = null; }
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
    if (this.metacogTimer) { clearTimeout(this.metacogTimer); this.metacogTimer = null; }
    this.stopWatchdog();
  }

  /**
   * Safe wrapper for housekeep timer — never let an error crash the loop.
   * Uses tryAcquire so housekeep never blocks metacog or process completion.
   * If the mutex is held, this cycle is skipped — the holder already does
   * equivalent work (flush IPC, rebuild DAG, reschedule).
   */
  private safeHousekeep(): void {
    if (this.halted) return;
    const release = this.mutex.tryAcquire();
    if (!release) return; // mutex busy — skip this cycle
    try {
      this.housekeep();
      this.emitter?.writeLiveState(this.snapshot());
      if (this.shouldHalt()) { this.haltResolve?.(); return; }
      this.doSchedulingPass();
    } catch (err) {
      this.emitter?.emit({
        action: "os_process_event",
        status: "failed",
        message: `housekeep error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      release();
    }
  }

  private safeSnapshotWrite(): void {
    if (this.halted) return;
    try {
      const snap = this.snapshot();
      this.emitter?.emit({
        action: "os_snapshot", status: "completed",
        message: `wall_clock_snapshot`,
      });
      this.emitter?.saveSnapshot(snap);
    } catch {
      // Non-critical
    }
  }

  /**
   * Periodic metacog evaluation — runs on wall-clock timer.
   * Evaluates system state, applies metacog commands, runs awareness daemon.
   */
  private async doMetacogCheck(): Promise<number | undefined> {
    if (this.metacogInFlight) return undefined;

    // Metacog overdue safety net — ensure metacog evaluates during critical periods
    // even if cadence/triggers don't fire naturally.
    const ticksSinceMetacog = this.scheduler.tickCount - this.lastMetacogTick;
    if (ticksSinceMetacog > 5 && this.scheduler.tickCount > 0) {
      const hasLivingGoalWork = this.table.getAll().some(
        p => p.state !== "dead" && p.type !== "daemon"
      );
      if (hasLivingGoalWork) {
        this.addTrigger("goal_drift");
      }
    }

    if (!this.shouldConsultMetacog()) return undefined;

    const wakeNow = Date.now();
    const sinceLastWakeSec = this.lastMetacogWakeAt > 0
      ? Math.round((wakeNow - this.lastMetacogWakeAt) / 1000)
      : 0;
    this.lastMetacogWakeAt = wakeNow;

    this.metacogInFlight = true;
    let nextWakeMs: number | undefined;
    try {
      // Rebuild ranked blueprints (in tick() this came from an earlier step)
      const rankedBlueprints = this.memoryStore.queryBlueprints(this.goal);

      this.metacog.setProcessSnapshot(this.table.getAll());
      this.metacog.setBlueprintsSnapshot(rankedBlueprints);
      this.metacog.setSelectedBlueprint(this.selectedBlueprintInfo);
      this.metacog.setEphemeralStats({
        spawns: this.telemetryCollector.ephemeralSpawns,
        successes: this.telemetryCollector.ephemeralSuccesses,
        failures: this.telemetryCollector.ephemeralFailures,
        totalDurationMs: this.telemetryCollector.ephemeralTotalDurationMs,
      });
      const context = this.buildMetacogContext();

      // Temporal awareness: tell metacog how long since its last evaluation
      context.sinceLastWakeSec = sinceLastWakeSec;

      // (1) Push current system state snapshot to IPC channel 'metacog:system-state'
      this.ipcBus.bbWrite("metacog:system-state", context, "kernel");

      // The metacog-daemon process reads the state, evaluates, and writes commands back.
      const metacogDaemonProc = this.table.getAll().find(
        (p) => p.name === "metacog-daemon" && p.state !== "dead",
      );
      if (metacogDaemonProc) {
        this.supervisor.activate(metacogDaemonProc.pid);
        const stateEntry = this.ipcBus.bbRead("metacog:system-state", metacogDaemonProc.pid);
        if (stateEntry) {
          try {
            const response = await this.metacog.evaluate(stateEntry.value as MetacogContext);
            // Push commands to IPC channel 'metacog:commands'
            this.ipcBus.bbWrite("metacog:commands", response, metacogDaemonProc.pid);
          } catch {
            // Daemon evaluation failed — continue without it
          }
        }
        // Return daemon to idle after its turn
        this.supervisor.idle(metacogDaemonProc.pid, {});
      }

      this.lastMetacogTick = this.scheduler.tickCount;
      this.pendingTriggers = [];

      // (2) Read all pending items from 'metacog:commands' channel
      // (3) Apply each MetacogCommand via executeMetacogCommand()
      const cmdEntry = this.ipcBus.bbRead("metacog:commands", "kernel");
      if (cmdEntry && typeof cmdEntry.value === "string") {
        nextWakeMs = this.parseMetacogResponse(cmdEntry.value);
        this.ipcBus.bbDelete("metacog:commands");
      }
      this.ipcBus.bbDelete("metacog:system-state");

      // Track metacog evaluation count
      this.metacogEvalCount += 1;

      // Record progress snapshot for awareness context
      this.recordProgressSnapshot();

      // Run awareness daemon at configured cadence
      if (this.shouldConsultAwareness() && this.awarenessDaemon) {
        // Activate awareness process in table for observability
        const awarenessProc = this.table.getAll().find(
          (p) => p.name === "awareness-daemon" && p.state !== "dead",
        );
        if (awarenessProc) {
          this.supervisor.activate(awarenessProc.pid);
        }

        const awarenessCtx = this.buildAwarenessContext();
        try {
          const awarenessResp = await this.awarenessDaemon.evaluate(awarenessCtx);
          this.pendingAwarenessNotes = awarenessResp.notes;
          this.lastAwarenessTick = this.scheduler.tickCount;

          // Update process table entry with tick/token accounting
          if (awarenessProc) {
            awarenessProc.tickCount += 1;
            awarenessProc.lastActiveAt = new Date().toISOString();
          }

          if (awarenessResp.flaggedHeuristics.length > 0) {
            this.ipcBus.bbWrite("awareness:heuristic-flags", awarenessResp.flaggedHeuristics, "awareness-daemon");
          }
          if (awarenessResp.adjustments.length > 0) {
            this.ipcBus.bbWrite("awareness:adjustments", awarenessResp.adjustments, "awareness-daemon");
          }

          // Process adjustments — close the feedback loop
          for (const adj of awarenessResp.adjustments) {
            this.applyAwarenessAdjustment(adj);
          }

          // Emit awareness evaluation event for Lens observability
          this.emitter?.emit({
            action: "os_awareness_eval",
            status: "completed",
            agentName: "awareness-daemon",
            message: `awareness eval: ${awarenessResp.notes.length} notes, ${awarenessResp.adjustments.length} adjustments, ${awarenessResp.flaggedHeuristics.length} flagged heuristics`,
            detail: {
              notes: awarenessResp.notes,
              adjustments: awarenessResp.adjustments,
              flaggedHeuristicCount: awarenessResp.flaggedHeuristics.length,
              tick: this.scheduler.tickCount,
            },
          });
        } catch {
          // Awareness eval failed — continue without notes
        }

        // Return awareness process to idle
        if (awarenessProc) {
          this.supervisor.idle(awarenessProc.pid, {});
        }
      }

      // Evaluate pending interventions whose deadline has passed
      {
        const evalTick = this.scheduler.tickCount;
        const evalProcs = this.table.getAll();
        const currentPost: InterventionSnapshot = {
          totalTokensUsed: evalProcs.reduce((s, p) => s + p.tokensUsed, 0),
          activeProcessCount: evalProcs.filter(p => p.state === 'running').length,
          stalledProcessCount: evalProcs.filter(p => p.state === 'sleeping' || p.state === 'idle').length,
          deadCount: evalProcs.filter(p => p.state === 'dead').length,
        };
        for (const iv of this.pendingInterventions) {
          if (!iv.postSnapshot) iv.postSnapshot = currentPost;
          if (evalTick >= iv.tick + iv.ticksToEvaluate && !iv.outcome) {
            const pre = iv.preSnapshot;
            const post = iv.postSnapshot;
            if (post.activeProcessCount > pre.activeProcessCount || post.stalledProcessCount < pre.stalledProcessCount) {
              iv.outcome = 'improved';
              this.memoryStore.learn(
                `${iv.commandKind} improved system: active +${post.activeProcessCount - pre.activeProcessCount}, stalled -${pre.stalledProcessCount - post.stalledProcessCount}`,
                0.7, `intervention:${iv.commandKind}`, this.runId,
              );
            } else if (post.stalledProcessCount > pre.stalledProcessCount || post.deadCount > pre.deadCount + 1) {
              iv.outcome = 'degraded';
              this.memoryStore.learn(
                `${iv.commandKind} degraded system: stalled +${post.stalledProcessCount - pre.stalledProcessCount}`,
                0.6, `intervention:${iv.commandKind}`, this.runId,
              );
            } else {
              iv.outcome = 'neutral';
            }

            // Compute causal attributions from topology snapshot at intervention time
            if (iv.causalFactors && !iv.causalAttributions) {
              const corr = iv.outcome === 'improved' ? 'positive' as const
                : iv.outcome === 'degraded' ? 'negative' as const
                : 'neutral' as const;
              iv.causalAttributions = (Object.entries(iv.causalFactors) as Array<[string, number]>).map(([factor, value]) => ({
                factor,
                value,
                correlation: corr,
                confidence: 0.6,
              }));
              for (const attr of iv.causalAttributions) {
                try {
                  this.memoryStore.learn(
                    `${iv.commandKind} in conditions ${attr.factor}=${attr.value.toFixed(2)} correlates with ${iv.outcome}`,
                    0.6,
                    `causal:${iv.commandKind}:${attr.factor}`,
                    this.runId,
                  );
                } catch {
                  // Max heuristics reached — skip gracefully
                }
              }
            }

            // Only emit protocol events for non-neutral outcomes to avoid log spam
            if (iv.outcome !== 'neutral') {
              this.emitter?.emit({
                action: "os_intervention_outcome",
                status: "completed",
                message: `intervention ${iv.commandKind} outcome=${iv.outcome} (tick ${iv.tick} → ${evalTick})`,
                detail: {
                  commandKind: iv.commandKind,
                  outcome: iv.outcome,
                  interventionTick: iv.tick,
                  evaluationTick: evalTick,
                  preSnapshot: pre,
                  postSnapshot: post,
                  causalAttributions: iv.causalAttributions ?? [],
                },
              });
            }
          }
        }
        // Remove evaluated interventions immediately — outcome was already
        // emitted and learned. Keeping them caused 190-event spam per run
        // because each housekeep re-evaluated and re-emitted the same outcome.
        this.pendingInterventions = this.pendingInterventions.filter(
          iv => iv.outcome === undefined
        );
      }
    } finally {
      this.metacogInFlight = false;
    }
    return nextWakeMs;
  }

  /**
   * Schedule the next metacog evaluation after `delayMs`.
   * Uses setTimeout (not setInterval) so metacog controls its own cadence.
   */
  private scheduleNextMetacog(delayMs: number): void {
    if (this.metacogTimer) { clearTimeout(this.metacogTimer); this.metacogTimer = null; }
    const maxInterval = this.config.kernel.metacogIntervalMs ?? 60_000;
    const clamped = Math.max(1000, Math.min(delayMs, maxInterval));
    this.metacogTimer = setTimeout(() => {
      void this.safeMetacogCheck();
    }, clamped);
    (this.metacogTimer as NodeJS.Timeout).unref?.();
  }

  /**
   * Safe wrapper for metacog timer — acquires mutex, runs metacog, reschedules.
   */
  private async safeMetacogCheck(): Promise<void> {
    if (this.halted) return;
    const release = await this.mutex.acquire();
    let nextWakeMs: number | undefined;
    try {
      nextWakeMs = await this.doMetacogCheck();
      this.emitter?.writeLiveState(this.snapshot());
      if (this.shouldHalt()) { this.haltResolve?.(); return; }
      this.doSchedulingPass();
    } catch (err) {
      this.emitter?.emit({
        action: "os_process_event",
        status: "failed",
        message: `metacog error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      release();
      // Reschedule: use metacog's requested delay, or fallback max interval
      if (!this.halted) {
        const fallback = this.config.kernel.metacogIntervalMs ?? 60_000;
        this.scheduleNextMetacog(nextWakeMs ?? fallback);
      }
    }
  }

  /** Start the watchdog timer — fires independently of the tick loop. */
  private startWatchdog(): void {
    const intervalMs = this.config.kernel.watchdogIntervalMs ?? 60000;
    this.watchdogTimer = setInterval(() => {
      this.watchdogCheck();  // async but fire-and-forget from setInterval
    }, intervalMs);
    // Unref so the timer doesn't prevent Node.js from exiting
    if (this.watchdogTimer && 'unref' in this.watchdogTimer) {
      (this.watchdogTimer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the watchdog timer. */
  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Watchdog check — fires on a timer independent of the tick loop.
   * Only acts when a tick is in progress and no metacog is already running.
   * Invokes metacog with a "tick_stall" trigger, which can kill hung processes.
   */
  private async watchdogCheck(): Promise<void> {
    // Only relevant when a tick is stuck
    if (!this.tickInProgress) return;
    // Don't stack metacog evaluations
    if (this.metacogInFlight) return;
    // Skip watchdog until the first tick completes — the initial LLM turn is
    // naturally the longest (big planning/architecture call) and should never
    // be killed. tickCount is incremented at tick start, so tickCount <= 1
    // means we're still in (or haven't reached) tick 1.
    if (this.scheduler.tickCount <= 1) return;

    // Build stall information with inference-aware tiering
    const stallDurations: Record<string, number> = {};
    const now = Date.now();

    // LLMs can legitimately think for very long periods (up to 20 minutes)
    // before emitting their first token. The watchdog should only flag processes
    // that have exceeded generous timeouts — not treat silence as failure.
    const recentStreamThresholdMs = 60_000; // 60s grace window for stream events
    const hardCapMs = 20 * 60_000; // 20 min absolute max per turn
    // Minimum time before ANY process can be flagged as stalled.
    // This gives LLMs plenty of time to think before first token.
    const minStallThresholdMs = 10 * 60_000; // 10 min minimum before flagging

    for (const [pid, startTime] of this.turnStartTimes) {
      const elapsed = now - startTime;
      const lastEvent = this.lastStreamEventAt.get(pid);
      const timeSinceLastEvent = lastEvent ? now - lastEvent : elapsed;
      const receivingStream = timeSinceLastEvent < recentStreamThresholdMs;

      // Hard cap: always report after 20 minutes, no exceptions
      if (elapsed >= hardCapMs) {
        stallDurations[pid] = elapsed;
        continue;
      }

      // Never flag a process before the minimum stall threshold.
      // LLMs can think for a long time before their first token — this is normal.
      if (elapsed < minStallThresholdMs) {
        continue;
      }

      // Grace period: skip processes that are actively receiving stream events
      if (receivingStream) {
        continue;
      }

      // Beyond minimum threshold and not receiving events: report to metacog
      // with inference telemetry so it can make an informed decision
      stallDurations[pid] = elapsed;
    }

    // Only fire if at least one process exceeded thresholds
    if (Object.keys(stallDurations).length === 0) return;

    this.metacogInFlight = true;
    try {
      this.metacog.setProcessSnapshot(this.table.getAll());
      const context = this.buildMetacogContext();
      // Override trigger to tick_stall and add stall durations
      context.trigger = "tick_stall";
      context.stallDurations = stallDurations;

      // Build inference telemetry for ALL running processes
      const inferenceTelemetry: Record<string, { secsSinceLastEvent: number; tokenCount: number; tokenRate: number; durationSec: number }> = {};
      for (const [pid, startTime] of this.turnStartTimes) {
        const elapsed = now - startTime;
        const lastEvent = this.lastStreamEventAt.get(pid);
        const tokenCount = this.streamTokenCount.get(pid) ?? 0;
        const timeSinceLastEvent = lastEvent ? now - lastEvent : elapsed;
        inferenceTelemetry[pid] = {
          secsSinceLastEvent: Math.round(timeSinceLastEvent / 1000),
          tokenCount,
          tokenRate: elapsed > 0 ? Math.round((tokenCount / (elapsed / 1000)) * 10) / 10 : 0,
          durationSec: Math.round(elapsed / 1000),
        };
      }
      context.inferenceTelemetry = inferenceTelemetry;

      this.emitter?.emit({
        action: "os_metacog",
        status: "started",
        message: `watchdog tick_stall detected: ${Object.entries(stallDurations).map(([pid, ms]) => `${pid}=${Math.round(ms / 1000)}s`).join(", ")}`,
      });

      const responseStr = await this.metacog.evaluate(context);

      // Parse the response as JSON (same format as normal metacog responses)
      let parsed: MetacogResponse | null = null;
      try {
        parsed = JSON.parse(responseStr);
      } catch {
        // Non-JSON response — no action
      }

      // Serialize state mutations through the mutex — the LLM eval above was
      // intentionally outside the mutex for throughput, but kills/spawns/IPC
      // writes must not race with onProcessComplete or housekeep.
      const wdRelease = await this.mutex.acquire();
      try {
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.commands)) {
          for (const cmd of parsed.commands) {
            if (cmd.kind === "kill") {
              this.supervisor.kill(cmd.pid, cmd.cascade, cmd.reason);
              this.executor.disposeThread(cmd.pid);
              this.router.disposeThread(cmd.pid);
              // Abort ephemeral thread if this PID is an in-flight ephemeral
              this.ephemeralThreads.get(cmd.pid)?.abort();
              this.ephemeralThreads.delete(cmd.pid);
              const killCb = this.turnKillCallbacks.get(cmd.pid);
              if (killCb) {
                killCb();
              }
              this.emitter?.emit({
                action: "os_process_kill",
                status: "completed",
                agentId: cmd.pid,
                agentName: this.table.get(cmd.pid)?.name ?? cmd.pid,
                message: `watchdog_kill: ${cmd.reason}`,
                detail: {
                  trigger: "watchdog",
                  reason: cmd.reason,
                },
              });
            } else {
              try {
                this.executeMetacogCommand(cmd);
              } catch {
                // Individual command failure shouldn't stop others
              }
            }
          }
        }
        this.metacogEvalCount += 1;
        this.recordProgressSnapshot();

        if (this.shouldConsultAwareness() && this.awarenessDaemon) {
          const awarenessProc = this.table.getAll().find(
            (p) => p.name === "awareness-daemon" && p.state !== "dead",
          );
          if (awarenessProc) {
            this.supervisor.activate(awarenessProc.pid);
          }
          const awarenessCtx = this.buildAwarenessContext();
          try {
            const awarenessResp = await this.awarenessDaemon.evaluate(awarenessCtx);
            this.pendingAwarenessNotes = awarenessResp.notes;
            this.lastAwarenessTick = this.scheduler.tickCount;
            if (awarenessProc) {
              awarenessProc.tickCount += 1;
              awarenessProc.lastActiveAt = new Date().toISOString();
            }
            if (awarenessResp.flaggedHeuristics.length > 0) {
              this.ipcBus.bbWrite("awareness:heuristic-flags", awarenessResp.flaggedHeuristics, "awareness-daemon");
            }
            if (awarenessResp.adjustments.length > 0) {
              this.ipcBus.bbWrite("awareness:adjustments", awarenessResp.adjustments, "awareness-daemon");
              for (const adj of awarenessResp.adjustments) {
                this.applyAwarenessAdjustment(adj);
              }
            }
            this.emitter?.emit({
              action: "os_awareness_eval",
              status: "completed",
              agentName: "awareness-daemon",
              message: `watchdog awareness eval: ${awarenessResp.notes.length} notes, ${awarenessResp.adjustments.length} adjustments, ${awarenessResp.flaggedHeuristics.length} flagged heuristics`,
              detail: {
                source: "watchdog",
                notes: awarenessResp.notes,
                adjustments: awarenessResp.adjustments,
                flaggedHeuristicCount: awarenessResp.flaggedHeuristics.length,
                tick: this.scheduler.tickCount,
              },
            });
          } catch {
            // Awareness eval failed — non-critical, continue
          }
        }
      } finally {
        wdRelease();
      }
    } catch {
      // Watchdog metacog eval failed — silently continue, try again next interval
    } finally {
      this.metacogInFlight = false;
    }
  }

  /**
   * XXX TODO: Legacy tick loop — used ONLY by SubKernelExecutor to drive child kernels.
   * Should be removed once sub-kernels are converted to use eventLoop() / run().
   * The top-level kernel uses eventLoop() instead. Do not call this from run().
   */
  async tick(): Promise<void> {
    const tickNum = this.scheduler.tickCount + 1;
    const processCount = this.table.getAll().length;
    this.emitter?.emit({
      action: "os_tick",
      status: "started",
      message: `tick=${tickNum} processes=${processCount}`,
    });

    // 0. Reset per-tick state
    this.tickSignals = [];

    // 1. Scheduler tick
    this.scheduler.tick();

    // 1b. Emit periodic tick cadence signals
    const cadences = this.config.kernel.tickSignalCadences ?? [1, 5, 10];
    for (const cadence of cadences) {
      if (tickNum % cadence === 0) {
        const signalName = `tick:${cadence}`;
        this.ipcBus.emitSignal(signalName, "kernel", { tick: tickNum, cadence });
        this.tickSignals.push(signalName);
      }
    }

    // 2. Wake expired sleepers
    this.supervisor.wakeExpiredSleepers();

    // 2b. Restore checkpointed processes — checkpoint saves state but shouldn't
    //     permanently suspend; resume on next tick so the process can continue.
    for (const proc of this.table.getByState("checkpoint")) {
      this.table.transitionState(proc.pid, "running");
    }

    // 2c. Check deferral conditions
    this.processDeferrals();

    // 3. Flush IPC bus — get woken PIDs, wake idle processes
    const { wokenPids } = this.ipcBus.flush();
    for (const pid of wokenPids) {
      const proc = this.table.get(pid);
      if (proc && proc.state === "idle") {
        this.supervisor.activate(pid);
      }
    }

    // 4. Reap zombies
    this.supervisor.reapZombies();

    // 5. Handle daemon restarts
    this.supervisor.handleRestarts();

    // 6. Rebuild DAG from current process table
    this.dagEngine.buildFromProcesses(this.table.getAll());

    // 6b. Apply boot-matched strategies to scheduler and executor
    {
      const applicable = this.getApplicableStrategies();
      if (applicable.length > 0) {
        this.scheduler.applyStrategies(applicable);
        // Track the top strategy for outcome recording at shutdown
        this.activeStrategyId = applicable[0]!.id;
      }
      // Inject strategies into executor router for prompt injection
      this.router.setStrategiesSnapshot(applicable);
    }

    // 7. Select runnable processes
    const topology = this.dagEngine.currentTopology();
    const selected = this.scheduler.selectRunnable(
      this.table.getAll(),
      topology,
    );

    // 7-GAP1: Stamp active strategy ID on each selected process so per-process
    // outcomes can be attributed to the strategy that scheduled them.
    if (this.activeStrategyId) {
      for (const proc of selected) {
        proc.activeStrategyId = this.activeStrategyId;
      }
    }

    // 7b. Inject blackboard snapshot so process prompts can see shared state
    const bbEntries = this.ipcBus.bbReadAll();
    const bbSnapshot: Record<string, unknown> = {};
    for (const entry of bbEntries) {
      bbSnapshot[entry.key] = entry.value;
    }
    this.executor.setBlackboardSnapshot(bbSnapshot);
    this.router.setBlackboardSnapshot(bbSnapshot);

    // 7b-ii. Inject process table snapshot so processes can introspect siblings
    this.executor.setProcessTableSnapshot(this.table.getAll());
    this.router.setProcessTableSnapshot(this.table.getAll());

    // 7c. Inject learned heuristics into executor and scheduler
    // This closes the learning loop: heuristics learned by metacog in prior runs
    // now proactively shape goal-orchestrator spawn behavior and scheduling decisions.
    const relevantHeuristics = this.memoryStore.query(this.goal);
    this.executor.setHeuristicsSnapshot(relevantHeuristics);
    this.router.setHeuristicsSnapshot(relevantHeuristics);
    this.scheduler.setHeuristics(relevantHeuristics);

    // 7d. Process injected commands from connect CLI (os-inject.json)
    this.processInjectedCommands();

    // 7e. Inject ranked blueprints into executor so goal-orchestrator can select one.
    // GAP 3: Use recommendBlueprint() to promote the historically-best blueprint for
    // this task class to the top of the ranked list (if sufficient history exists).
    const rankedBlueprints = this.memoryStore.queryBlueprints(this.goal);
    {
      const taskClass = this.extractGoalTags();
      if (taskClass.length > 0 && rankedBlueprints.length > 1) {
        try {
          const recommended = this.memoryStore.recommendBlueprint(taskClass, rankedBlueprints);
          // Move recommended blueprint to front (preserves rest of Bayesian ranking)
          const reranked = [
            recommended,
            ...rankedBlueprints.filter((bp) => bp.id !== recommended.id),
          ];
          this.executor.setBlueprintsSnapshot(reranked);
          this.router.setBlueprintsSnapshot(reranked);
        } catch {
          this.executor.setBlueprintsSnapshot(rankedBlueprints);
          this.router.setBlueprintsSnapshot(rankedBlueprints);
        }
      } else {
        this.executor.setBlueprintsSnapshot(rankedBlueprints);
        this.router.setBlueprintsSnapshot(rankedBlueprints);
      }
    }

    // 8. Execute selected processes via LLM threads
    await this.executeProcesses(selected);

    // 8a. Detect selected blueprint from blackboard (written by goal-orchestrator)
    if (!this.selectedBlueprintInfo) {
      const bbEntry = this.ipcBus.bbRead("selected_blueprint", "kernel");
      if (bbEntry && typeof bbEntry.value === "string") {
        const bpValue = bbEntry.value;
        if (bpValue.startsWith("novel:")) {
          // Gap 1: When the orchestrator invented a novel topology, auto-register it as a
          // blueprint record so recordBlueprintOutcome() can close the learning loop.
          const novelName = bpValue.slice("novel:".length) || "novel-topology";
          const allProcs = this.table.getAll();
          const novelBp: TopologyBlueprint = {
            id: randomUUID(),
            name: novelName,
            description: `Novel topology auto-registered from run ${this.runId}`,
            source: "orchestrator",
            applicability: {
              goalPatterns: this.extractGoalTags(),
              minSubtasks: 1,
              maxSubtasks: Math.max(allProcs.length, 1),
              requiresSequencing: false,
            },
            roles: allProcs
              .filter((p) => p.type !== "daemon" && p.parentPid !== null)
              .map((p) => ({
                name: p.name,
                type: p.type,
                cardinality: "one" as const,
                priorityOffset: p.priority - 50,
                objectiveTemplate: p.objective.slice(0, 120),
                spawnTiming: "immediate" as const,
              })),
            gatingStrategy: "signal-gate" as BlueprintGatingStrategy,
            priorityStrategy: "gradient-2pt",
            stats: {
              uses: 0,
              successes: 0,
              failures: 0,
              avgTokenEfficiency: 0,
              avgWallTimeMs: 0,
              lastUsedAt: "",
              alpha: 1,
              beta: 1,
              tagStats: {},
            },
            learnedAt: new Date().toISOString(),
          };
          this.memoryStore.addBlueprint(novelBp);
          this.selectedBlueprintInfo = {
            id: novelBp.id,
            name: novelBp.name,
            source: "orchestrator",
            successRate: 0,
            instantiatedRoles: novelBp.roles.map((r) => r.name),
            adapted: true,
          };
          this.emitter?.emit({
            action: "os_blueprint_selected",
            status: "completed",
            message: `blueprint=${novelBp.name} id=${novelBp.id} source=novel`,
            detail: {
              blueprintId: novelBp.id,
              blueprintName: novelBp.name,
              source: "orchestrator",
              adapted: true,
              roles: novelBp.roles.map((r) => r.name),
              successRate: 0,
            },
          });
        } else {
          const bp = this.memoryStore.getBlueprint(bpValue);
          if (bp) {
            this.selectedBlueprintInfo = {
              id: bp.id,
              name: bp.name,
              source: bp.source,
              successRate: bp.stats?.uses ? bp.stats.successes / bp.stats.uses : 0,
              instantiatedRoles: bp.roles.map((r) => r.name),
              adapted: false,
            };
            // DC-2: Wire TelemetryCollector.onBlueprintSelected()
            this.telemetryCollector.onBlueprintSelected(bp.id, this.goal.split(" ").length);
            this.emitter?.emit({
              action: "os_blueprint_selected",
              status: "completed",
              message: `blueprint=${bp.name} id=${bp.id} source=${bp.source}`,
              detail: {
                blueprintId: bp.id,
                blueprintName: bp.name,
                source: bp.source,
                adapted: false,
                roles: bp.roles.map((r) => r.name),
                successRate: bp.stats?.uses ? bp.stats.successes / bp.stats.uses : 0,
                uses: bp.stats?.uses ?? 0,
              },
            });
          }
        }
      }
    }

    // 8b. Post-execution wake pass: signals emitted during execution
    //     need to wake idle processes waiting on them.
    const postExecFlush = this.ipcBus.flush();
    for (const pid of postExecFlush.wokenPids) {
      const proc = this.table.get(pid);
      if (proc && proc.state === "idle") {
        this.supervisor.activate(pid);
      }
    }

    // 8c. Also check wakeOnSignals/wakeOnChannels via supervisor
    //     (for processes that went idle with wakeOnSignals but aren't IPC-subscribed)
    const recentSignals = this.collectRecentSignalNames();
    if (recentSignals.length > 0) {
      this.supervisor.wakeOnCondition(recentSignals);
    }

    // 8c-ii. Stall detection: if zero processes were scheduled for 3+ consecutive ticks,
    //        force-wake all idle processes. This prevents terminal stalls where processes
    //        went idle waiting on signals/channels that were never emitted.
    if (selected.length === 0) {
      this.consecutiveIdleTicks += 1;
      if (this.consecutiveIdleTicks >= 3) {
        const idleProcs = this.table.getByState("idle");
        if (idleProcs.length > 0) {
          for (const proc of idleProcs) {
            this.supervisor.activate(proc.pid);
          }
          this.emitter?.emit({
            action: "os_process_event",
            status: "completed",
            message: `stall_detected: force-woke ${idleProcs.length} idle processes after ${this.consecutiveIdleTicks} empty ticks`,
          });
          this.consecutiveIdleTicks = 0;
        }
      }
    } else {
      this.consecutiveIdleTicks = 0;
    }

    // 8c-iii. Phase-transition deadlock detection: if the orchestrator is idle with
    //         zero living children and zero pending ephemerals, and it's past the boot
    //         phase (tickCount > 1), force-wake it. This catches the case where the
    //         orchestrator advances currentPhase but spawns zero processes for it.
    //
    //         Deferral-aware: if there are pending deferrals AND the blackboard hasn't
    //         changed since the last force-wake, the orchestrator is waiting (not stuck).
    //         Only force-wake again after a cooldown of 5 ticks or if new BB keys appear.
    const orchestrator = this.table.getAll().find(p => !p.parentPid && p.type === "lifecycle");
    if (orchestrator && orchestrator.state === "idle" && orchestrator.tickCount >= 1) {
      const livingChildren = this.table.getAll().filter(
        p => p.parentPid === orchestrator.pid && p.state !== "dead"
      );
      const pendingEphemerals = this.pendingEphemerals.length + this.activeEphemeralCount;
      if (livingChildren.length === 0 && pendingEphemerals === 0) {
        const pendingDeferrals = this.deferrals.size;
        const currentBbKeys = this.ipcBus.summary().blackboardKeyCount;
        const bbChanged = currentBbKeys !== this.bbKeysAtLastForceWake;
        const ticksSinceLastForceWake = this.scheduler.tickCount - this.lastOrchestratorForceWakeTick;
        const cooldownExpired = ticksSinceLastForceWake >= 5;

        if (pendingDeferrals === 0 || bbChanged || cooldownExpired) {
          this.supervisor.activate(orchestrator.pid);
          this.lastOrchestratorForceWakeTick = this.scheduler.tickCount;
          this.bbKeysAtLastForceWake = currentBbKeys;
          this.emitter?.emit({
            action: "os_process_event",
            status: "completed",
            message: `deadlock_detected: orchestrator idle with 0 living children, 0 pending ephemerals, ${pendingDeferrals} deferrals — force-waking (bbChanged=${bbChanged}, cooldown=${cooldownExpired})`,
          });
        }
      }
    }

    // 8c-iv. Dead executive recovery: if the orchestrator is dead but living
    //        goal-work or deferrals remain, the system is headless.
    //        Restart the executive — the process calculus equivalent of init respawning.
    const deadOrchestrator = this.table.getAll().find(
      p => !p.parentPid && p.type === "lifecycle" && p.state === "dead" && p.name === "goal-orchestrator"
    );
    if (deadOrchestrator) {
      const livingGoalProcesses = this.table.getAll().filter(
        p => p.pid !== deadOrchestrator.pid && p.state !== "dead" && p.type !== "daemon"
      );
      const hasPendingDeferrals = this.deferrals.size > 0;

      if (livingGoalProcesses.length > 0 || hasPendingDeferrals) {
        const newOrch = this.supervisor.spawn({
          type: "lifecycle",
          name: "goal-orchestrator",
          objective: this.goal,
          priority: deadOrchestrator.priority,
          model: deadOrchestrator.model,
          workingDir: this.workingDir,
        });
        this.supervisor.activate(newOrch.pid);

        // Re-parent orphaned lifecycle children so child:done signals route correctly
        for (const proc of livingGoalProcesses) {
          if (!proc.parentPid && proc.type === "lifecycle") {
            proc.parentPid = newOrch.pid;
            newOrch.children.push(proc.pid);
          }
        }

        this.addTrigger("process_failed");

        this.emitter?.emit({
          action: "os_process_event",
          status: "completed",
          message: `dead_executive_recovery: restarted orchestrator as ${newOrch.pid}, reparented ${livingGoalProcesses.filter(p => p.type === "lifecycle").length} orphans, ${this.deferrals.size} deferrals pending`,
        });
      }
    }

    // 8d. Telemetry collection + perf analysis (if enabled)
    if (this.config.kernel.telemetryEnabled) {
      this.telemetryCollector.onTick(this.snapshot());
      const telemetrySnap = this.telemetryCollector.getSnapshot();
      const analyzer = new PerfAnalyzer(telemetrySnap);
      this.lastPerfRecommendations = analyzer.recommend();

      // Gap 7: Wire SelfOptimizer — programmatically apply perf recommendations
      // rather than just surfacing them to the metacog LLM context.
      if (this.lastPerfRecommendations.length > 0) {
        const selfOpt = new SelfOptimizer(
          this.lastPerfRecommendations,
          telemetrySnap,
          this.config.kernel.tokenBudget,
        );
        const optCommands = selfOpt.optimize();
        for (const cmd of optCommands) {
          try {
            this.executeMetacogCommand(cmd);
          } catch {
            // Individual command failure shouldn't stop others
          }
        }
      }
    }

    // 8e. Metacog overdue safety net — ensure metacog evaluates during critical periods
    //      even if cadence/triggers don't fire naturally.
    const ticksSinceMetacog = this.scheduler.tickCount - this.lastMetacogTick;
    if (ticksSinceMetacog > 5 && this.scheduler.tickCount > 0) {
      const hasLivingGoalWork = this.table.getAll().some(
        p => p.state !== "dead" && p.type !== "daemon"
      );
      if (hasLivingGoalWork) {
        this.addTrigger("goal_drift");
      }
    }

    // 9. Consult metacog via daemon process IPC (Gap 5).
    // The metacog-daemon is a first-class daemon in the process table.
    // Communication uses 'metacog:system-state' and 'metacog:commands' IPC channels
    // (implemented via blackboard — no PID registration needed).
    let metacogRanThisTick = false;
    if (this.shouldConsultMetacog() && !this.metacogInFlight) {
      this.metacogInFlight = true;
      try {
        this.metacog.setProcessSnapshot(this.table.getAll());
        this.metacog.setBlueprintsSnapshot(rankedBlueprints);
        this.metacog.setSelectedBlueprint(this.selectedBlueprintInfo);
        this.metacog.setEphemeralStats({
          spawns: this.telemetryCollector.ephemeralSpawns,
          successes: this.telemetryCollector.ephemeralSuccesses,
          failures: this.telemetryCollector.ephemeralFailures,
          totalDurationMs: this.telemetryCollector.ephemeralTotalDurationMs,
        });
        const context = this.buildMetacogContext();

        // (1) Push current system state snapshot to IPC channel 'metacog:system-state'
        this.ipcBus.bbWrite("metacog:system-state", context, "kernel");

        // The metacog-daemon process reads the state, evaluates, and writes commands back.
        const metacogDaemonProc = this.table.getAll().find(
          (p) => p.name === "metacog-daemon" && p.state !== "dead",
        );
        if (metacogDaemonProc) {
          this.supervisor.activate(metacogDaemonProc.pid);
          const stateEntry = this.ipcBus.bbRead("metacog:system-state", metacogDaemonProc.pid);
          if (stateEntry) {
            try {
              const response = await this.metacog.evaluate(stateEntry.value as MetacogContext);
              // Push commands to IPC channel 'metacog:commands'
              this.ipcBus.bbWrite("metacog:commands", response, metacogDaemonProc.pid);
            } catch {
              // Daemon evaluation failed — continue without it
            }
          }
          // Return daemon to idle after its turn
          this.supervisor.idle(metacogDaemonProc.pid, {});
        }
      } finally {
        this.metacogInFlight = false;
      }

      this.lastMetacogTick = this.scheduler.tickCount;
      this.pendingTriggers = [];

      // (2) Read all pending items from 'metacog:commands' channel
      // (3) Apply each MetacogCommand via executeMetacogCommand()
      const cmdEntry = this.ipcBus.bbRead("metacog:commands", "kernel");
      if (cmdEntry && typeof cmdEntry.value === "string") {
        this.parseMetacogResponse(cmdEntry.value);
        this.ipcBus.bbDelete("metacog:commands");
      }
      this.ipcBus.bbDelete("metacog:system-state");
      metacogRanThisTick = true;
    }

    // Track metacog evaluation + run awareness daemon at configured cadence
    if (metacogRanThisTick) {
      this.metacogEvalCount += 1;

      // Record progress snapshot for awareness context (dedup: one per tick)
      this.recordProgressSnapshot();

      // Run awareness daemon at configured cadence
      if (this.shouldConsultAwareness() && this.awarenessDaemon) {
        // Activate awareness process in table for observability
        const awarenessProc = this.table.getAll().find(
          (p) => p.name === "awareness-daemon" && p.state !== "dead",
        );
        if (awarenessProc) {
          this.supervisor.activate(awarenessProc.pid);
        }

        const awarenessCtx = this.buildAwarenessContext();
        try {
          const awarenessResp = await this.awarenessDaemon.evaluate(awarenessCtx);
          this.pendingAwarenessNotes = awarenessResp.notes;
          this.lastAwarenessTick = this.scheduler.tickCount;

          // Update process table entry with tick/token accounting
          if (awarenessProc) {
            awarenessProc.tickCount += 1;
            awarenessProc.lastActiveAt = new Date().toISOString();
          }

          if (awarenessResp.flaggedHeuristics.length > 0) {
            this.ipcBus.bbWrite("awareness:heuristic-flags", awarenessResp.flaggedHeuristics, "awareness-daemon");
          }
          if (awarenessResp.adjustments.length > 0) {
            this.ipcBus.bbWrite("awareness:adjustments", awarenessResp.adjustments, "awareness-daemon");
          }

          // Process adjustments — close the feedback loop
          for (const adj of awarenessResp.adjustments) {
            this.applyAwarenessAdjustment(adj);
          }

          // Emit awareness evaluation event for Lens observability
          this.emitter?.emit({
            action: "os_awareness_eval",
            status: "completed",
            agentName: "awareness-daemon",
            message: `awareness eval: ${awarenessResp.notes.length} notes, ${awarenessResp.adjustments.length} adjustments, ${awarenessResp.flaggedHeuristics.length} flagged heuristics`,
            detail: {
              notes: awarenessResp.notes,
              adjustments: awarenessResp.adjustments,
              flaggedHeuristicCount: awarenessResp.flaggedHeuristics.length,
              tick: this.scheduler.tickCount,
            },
          });
        } catch {
          // Awareness eval failed — continue without notes
        }

        // Return awareness process to idle
        if (awarenessProc) {
          this.supervisor.idle(awarenessProc.pid, {});
        }
      }
    }

    // Evaluate pending interventions whose deadline has passed
    {
      const evalTick = this.scheduler.tickCount;
      const evalProcs = this.table.getAll();
      const currentPost: InterventionSnapshot = {
        totalTokensUsed: evalProcs.reduce((s, p) => s + p.tokensUsed, 0),
        activeProcessCount: evalProcs.filter(p => p.state === 'running').length,
        stalledProcessCount: evalProcs.filter(p => p.state === 'sleeping' || p.state === 'idle').length,
        deadCount: evalProcs.filter(p => p.state === 'dead').length,
      };
      for (const iv of this.pendingInterventions) {
        if (!iv.postSnapshot) iv.postSnapshot = currentPost;
        if (evalTick >= iv.tick + iv.ticksToEvaluate && !iv.outcome) {
          const pre = iv.preSnapshot;
          const post = iv.postSnapshot;
          if (post.activeProcessCount > pre.activeProcessCount || post.stalledProcessCount < pre.stalledProcessCount) {
            iv.outcome = 'improved';
            this.memoryStore.learn(
              `${iv.commandKind} improved system: active +${post.activeProcessCount - pre.activeProcessCount}, stalled -${pre.stalledProcessCount - post.stalledProcessCount}`,
              0.7, `intervention:${iv.commandKind}`, this.runId,
            );
          } else if (post.stalledProcessCount > pre.stalledProcessCount || post.deadCount > pre.deadCount + 1) {
            iv.outcome = 'degraded';
            this.memoryStore.learn(
              `${iv.commandKind} degraded system: stalled +${post.stalledProcessCount - pre.stalledProcessCount}`,
              0.6, `intervention:${iv.commandKind}`, this.runId,
            );
          } else {
            iv.outcome = 'neutral';
          }

          // Compute causal attributions from topology snapshot at intervention time
          if (iv.causalFactors && !iv.causalAttributions) {
            const corr = iv.outcome === 'improved' ? 'positive' as const
              : iv.outcome === 'degraded' ? 'negative' as const
              : 'neutral' as const;
            iv.causalAttributions = (Object.entries(iv.causalFactors) as Array<[string, number]>).map(([factor, value]) => ({
              factor,
              value,
              correlation: corr,
              confidence: 0.6,
            }));
            for (const attr of iv.causalAttributions) {
              try {
                this.memoryStore.learn(
                  `${iv.commandKind} in conditions ${attr.factor}=${attr.value.toFixed(2)} correlates with ${iv.outcome}`,
                  0.6,
                  `causal:${iv.commandKind}:${attr.factor}`,
                  this.runId,
                );
              } catch {
                // Max heuristics reached — skip gracefully
              }
            }
          }

          // Only emit protocol events for non-neutral outcomes to avoid log spam
          if (iv.outcome !== 'neutral') {
            this.emitter?.emit({
              action: "os_intervention_outcome",
              status: "completed",
              message: `intervention ${iv.commandKind} outcome=${iv.outcome} (tick ${iv.tick} → ${evalTick})`,
              detail: {
                commandKind: iv.commandKind,
                outcome: iv.outcome,
                interventionTick: iv.tick,
                evaluationTick: evalTick,
                preSnapshot: pre,
                postSnapshot: post,
                causalAttributions: iv.causalAttributions ?? [],
              },
            });
          }
        }
      }
      this.pendingInterventions = this.pendingInterventions.filter(
        iv => iv.outcome === undefined
      );
    }

    // 10. Emit tick completed + periodic snapshot
    this.emitter?.emit({
      action: "os_tick",
      status: "completed",
      message: `tick=${this.scheduler.tickCount} ran=${selected.length}`,
    });

    this.emitter?.writeLiveState(this.snapshot());

    if (this.emitter && this.scheduler.tickCount % this.snapshotCadence === 0) {
      this.emitter.emit({ action: "os_snapshot", status: "completed", message: `tick=${this.scheduler.tickCount}` });
      this.emitter.saveSnapshot(this.snapshot());
    }
  }

  /**
   * Periodic housekeeping — runs on a wall-clock timer.
   * Handles: sleeper wakeup, checkpoint restore, deferral evaluation,
   * IPC flush + wake, zombie reaping, daemon restarts, DAG rebuild,
   * strategy application, stall detection, deadlock recovery.
   */
  private housekeep(): void {
    // 0. Reset per-tick state
    this.tickSignals = [];

    // 1. Housekeep counter (wall-clock cadence for periodic signals).
    // NOTE: scheduler.tick() is NOT called here — it's called in onProcessComplete()
    // so tickCount reflects actual scheduling cycles, not 500ms timer fires.
    this.housekeepCount += 1;

    // 1b. Emit periodic cadence signals based on housekeepCount
    const cadences = this.config.kernel.tickSignalCadences ?? [1, 5, 10];
    for (const cadence of cadences) {
      if (this.housekeepCount % cadence === 0) {
        const signalName = `tick:${cadence}`;
        this.ipcBus.emitSignal(signalName, "kernel", { tick: this.housekeepCount, cadence });
        this.tickSignals.push(signalName);
      }
    }

    // 2. Wake expired sleepers
    this.supervisor.wakeExpiredSleepers();

    // 2b. Restore checkpointed processes
    for (const proc of this.table.getByState("checkpoint")) {
      this.table.transitionState(proc.pid, "running");
    }

    // 2c. Check deferral conditions
    this.processDeferrals();

    // 3. Flush IPC bus — get woken PIDs, wake idle processes
    const { wokenPids } = this.ipcBus.flush();
    for (const pid of wokenPids) {
      const proc = this.table.get(pid);
      if (proc && proc.state === "idle") {
        this.supervisor.activate(pid);
      }
    }

    // 4. Reap zombies
    this.supervisor.reapZombies();

    // 5. Handle daemon restarts
    this.supervisor.handleRestarts();

    // 6. Rebuild DAG
    this.dagEngine.buildFromProcesses(this.table.getAll());

    // 6b. Apply strategies
    const applicable = this.getApplicableStrategies();
    if (applicable.length > 0) {
      this.scheduler.applyStrategies(applicable);
      this.activeStrategyId = applicable[0]!.id;
    }
    this.router.setStrategiesSnapshot(applicable);

    // Stall detection — use both tick count AND wall clock for robustness.
    // In the event-driven model, ticks only increment on real process completions,
    // so wall clock is the primary signal during quiet periods.
    const liveEphemeralCount = this.table.getAll().filter(
      p => p.type === "event" && p.state !== "dead"
    ).length;
    const now = Date.now();
    if (this.inflight.size === 0 && liveEphemeralCount === 0) {
      this.consecutiveIdleTicks += 1;
      // Wall-clock stall: 5s with no inflight work and idle processes present
      const wallStall = this.lastProcessCompletionTime > 0 &&
        (now - this.lastProcessCompletionTime) > 5_000;
      if (this.consecutiveIdleTicks >= 3 || wallStall) {
        const idleProcs = this.table.getByState("idle");
        if (idleProcs.length > 0) {
          for (const proc of idleProcs) {
            this.supervisor.activate(proc.pid);
          }
          this.emitter?.emit({
            action: "os_process_event",
            status: "completed",
            message: `stall_detected: force-woke ${idleProcs.length} idle processes after ${this.consecutiveIdleTicks} housekeep cycles (${this.lastProcessCompletionTime ? Math.round((now - this.lastProcessCompletionTime) / 1000) + 's' : '?'} since last completion)`,
          });
          this.consecutiveIdleTicks = 0;
        }
      }
    } else {
      this.consecutiveIdleTicks = 0;
    }

    // Phase-transition deadlock detection
    const orchestrator = this.table.getAll().find(p => !p.parentPid && p.type === "lifecycle");
    if (orchestrator && orchestrator.state === "idle" && orchestrator.tickCount >= 1) {
      const allLivingWork = this.table.getAll().filter(
        p => p.pid !== orchestrator.pid && p.state !== "dead" && p.type !== "daemon"
      );
      const pendingEphemerals = this.pendingEphemerals.length + liveEphemeralCount;
      if (allLivingWork.length === 0 && pendingEphemerals === 0) {
        const pendingDeferrals = this.deferrals.size;
        const currentBbKeys = this.ipcBus.summary().blackboardKeyCount;
        const bbChanged = currentBbKeys !== this.bbKeysAtLastForceWake;
        // Wall-clock cooldown: 10s between force-wakes (not tick-based)
        const wallCooldownExpired = (now - this.lastForceWakeTime) > 10_000;

        // Always force-wake when nothing is left (no deferrals, no work)
        const nothingLeft = pendingDeferrals === 0 && allLivingWork.length === 0;

        if (nothingLeft || bbChanged || wallCooldownExpired) {
          this.supervisor.activate(orchestrator.pid);
          this.lastOrchestratorForceWakeTick = this.scheduler.tickCount;
          this.lastForceWakeTime = now;
          this.bbKeysAtLastForceWake = currentBbKeys;
          this.emitter?.emit({
            action: "os_process_event",
            status: "completed",
            message: `deadlock_detected: orchestrator idle with 0 living work, 0 pending ephemerals, ${pendingDeferrals} deferrals — force-waking (nothingLeft=${nothingLeft}, bbChanged=${bbChanged}, wallCooldown=${wallCooldownExpired})`,
          });
        }
      }
    }

    // Dead executive recovery
    const deadOrchestrator = this.table.getAll().find(
      p => !p.parentPid && p.type === "lifecycle" && p.state === "dead" && p.name === "goal-orchestrator"
    );
    if (deadOrchestrator) {
      // Only count lifecycle processes as "goal work" — ephemerals (type "event") are
      // fire-and-forget scouts that don't need an executive to supervise them.
      const livingGoalProcesses = this.table.getAll().filter(
        p => p.pid !== deadOrchestrator.pid && p.state !== "dead" && p.type === "lifecycle"
      );
      const hasPendingDeferrals = this.deferrals.size > 0;

      if (livingGoalProcesses.length > 0 || hasPendingDeferrals) {
        const newOrch = this.supervisor.spawn({
          type: "lifecycle",
          name: "goal-orchestrator",
          objective: this.goal,
          priority: deadOrchestrator.priority,
          model: deadOrchestrator.model,
          workingDir: this.workingDir,
        });
        this.supervisor.activate(newOrch.pid);

        // Re-parent orphaned lifecycle children so child:done signals route correctly
        for (const proc of livingGoalProcesses) {
          if (!proc.parentPid && proc.type === "lifecycle") {
            proc.parentPid = newOrch.pid;
            newOrch.children.push(proc.pid);
          }
        }

        this.addTrigger("process_failed");

        this.emitter?.emit({
          action: "os_process_event",
          status: "completed",
          message: `dead_executive_recovery: restarted orchestrator as ${newOrch.pid}, reparented ${livingGoalProcesses.filter(p => p.type === "lifecycle").length} orphans, ${this.deferrals.size} deferrals pending`,
        });
      }
    }

    // Telemetry collection + perf analysis (if enabled)
    if (this.config.kernel.telemetryEnabled) {
      this.telemetryCollector.onTick(this.snapshot());
      const telemetrySnap = this.telemetryCollector.getSnapshot();
      const analyzer = new PerfAnalyzer(telemetrySnap);
      this.lastPerfRecommendations = analyzer.recommend();

      if (this.lastPerfRecommendations.length > 0) {
        const selfOpt = new SelfOptimizer(
          this.lastPerfRecommendations,
          telemetrySnap,
          this.config.kernel.tokenBudget,
        );
        const optCommands = selfOpt.optimize();
        for (const cmd of optCommands) {
          try {
            this.executeMetacogCommand(cmd);
          } catch {
            // Individual command failure shouldn't stop others
          }
        }
      }
    }
  }

  /**
   * Submit a single process for non-blocking LLM execution.
   * Attaches a completion handler that fires when the LLM responds.
   */
  private submitProcess(proc: OsProcess): void {
    if (this.halted) return;
    if (this.inflight.has(proc.pid)) return;

    this.turnStartTimes.set(proc.pid, Date.now());

    const execPromise = (!proc.backend || proc.backend.kind === "llm")
      ? this.executor.executeOne(proc)
      : this.router.executeOne(proc);

    // Wrap with kill token for watchdog
    let killResolve!: (r: OsProcessTurnResult) => void;
    const killPromise = new Promise<OsProcessTurnResult>(r => { killResolve = r; });
    this.turnKillCallbacks.set(proc.pid, () => {
      killResolve({
        pid: proc.pid, success: false,
        response: "killed by watchdog metacog",
        tokensUsed: 0, commands: [],
      });
    });

    const racedPromise = Promise.race([execPromise, killPromise]);
    this.inflight.set(proc.pid, racedPromise);

    racedPromise.then(
      result => {
        this.inflight.delete(proc.pid);
        this.turnStartTimes.delete(proc.pid);
        this.turnKillCallbacks.delete(proc.pid);
        this.lastStreamEventAt.delete(proc.pid);
        this.streamTokenCount.delete(proc.pid);
        void this.onProcessComplete(result);
      },
      err => {
        this.inflight.delete(proc.pid);
        this.turnStartTimes.delete(proc.pid);
        this.turnKillCallbacks.delete(proc.pid);
        this.lastStreamEventAt.delete(proc.pid);
        this.streamTokenCount.delete(proc.pid);
        void this.onProcessComplete({
          pid: proc.pid, success: false,
          response: err instanceof Error ? err.message : String(err),
          tokensUsed: 0, commands: [],
        });
      }
    );
  }

  /**
   * Handle a completed process. Serialized through mutex —
   * only one result processed at a time.
   */
  private async onProcessComplete(result: OsProcessTurnResult): Promise<void> {
    if (this.halted) return;
    const release = await this.mutex.acquire();
    try {
      await this.processOneResult(result);
      this.lastProcessCompletionTime = Date.now();

      // Meaningful tick: actual work just completed. This is the only place
      // tickCount is incremented in the event-driven model, so tick-based
      // mechanisms (deferrals, interventions, metacog cadence) operate at
      // the timescale of real scheduling cycles, not 500ms timer fires.
      this.scheduler.tick();

      // Process deferrals — conditions may now be met after this result
      this.processDeferrals();

      // Fire-and-forget ephemerals spawned by this process's commands
      void this.drainPendingEphemerals();

      // Flush IPC — wake processes unblocked by bb writes / signals
      const { wokenPids } = this.ipcBus.flush();
      for (const pid of wokenPids) {
        const p = this.table.get(pid);
        if (p && p.state === "idle") {
          this.supervisor.activate(pid);
        }
      }

      // Also check signal-based wakes — drain tickSignals to prevent
      // housekeep from clearing them before they're processed
      const recentSignals = [...this.tickSignals];
      this.tickSignals = [];
      if (recentSignals.length > 0) {
        this.supervisor.wakeOnCondition(recentSignals);
      }

      // Rebuild DAG to reflect new processes / state changes
      this.dagEngine.buildFromProcesses(this.table.getAll());

      // Detect selected blueprint from blackboard
      this.detectSelectedBlueprint();

      // Emit live state for Lens
      this.emitter?.writeLiveState(this.snapshot());

      // Update tickInProgress for watchdog
      this.tickInProgress = this.inflight.size > 0;

      // Check halt
      if (this.shouldHalt()) {
        this.haltResolve?.();
        return;
      }

      // Reschedule — new processes may be runnable now
      this.doSchedulingPass();
    } finally {
      release();
    }
  }

  /**
   * Evaluate what's runnable and submit up to maxConcurrent processes.
   * Non-blocking — returns immediately after submitting.
   */
  private doSchedulingPass(): void {
    if (this.halted) return;
    // Inject context snapshots into executors
    const bbEntries = this.ipcBus.bbReadAll();
    const bbSnapshot: Record<string, unknown> = {};
    for (const entry of bbEntries) bbSnapshot[entry.key] = entry.value;
    this.executor.setBlackboardSnapshot(bbSnapshot);
    this.router.setBlackboardSnapshot(bbSnapshot);
    this.executor.setProcessTableSnapshot(this.table.getAll());
    this.router.setProcessTableSnapshot(this.table.getAll());

    const relevantHeuristics = this.memoryStore.query(this.goal);
    this.executor.setHeuristicsSnapshot(relevantHeuristics);
    this.router.setHeuristicsSnapshot(relevantHeuristics);
    this.scheduler.setHeuristics(relevantHeuristics);

    // Inject blueprints
    const rankedBlueprints = this.memoryStore.queryBlueprints(this.goal);
    const taskClass = this.extractGoalTags();
    if (taskClass.length > 0 && rankedBlueprints.length > 1) {
      try {
        const recommended = this.memoryStore.recommendBlueprint(taskClass, rankedBlueprints);
        const reranked = [recommended, ...rankedBlueprints.filter(bp => bp.id !== recommended.id)];
        this.executor.setBlueprintsSnapshot(reranked);
        this.router.setBlueprintsSnapshot(reranked);
      } catch {
        this.executor.setBlueprintsSnapshot(rankedBlueprints);
        this.router.setBlueprintsSnapshot(rankedBlueprints);
      }
    } else {
      this.executor.setBlueprintsSnapshot(rankedBlueprints);
      this.router.setBlueprintsSnapshot(rankedBlueprints);
    }

    // Process injected commands
    this.processInjectedCommands();

    // Select runnable
    const topology = this.dagEngine.currentTopology();
    const selected = this.scheduler.selectRunnable(
      this.table.getAll(), topology,
    );

    // Stamp active strategy
    if (this.activeStrategyId) {
      for (const p of selected) p.activeStrategyId = this.activeStrategyId;
    }

    // Submit (skip already in-flight)
    for (const proc of selected) {
      if (this.inflight.has(proc.pid)) continue;
      if (this.inflight.size >= this.config.kernel.maxConcurrentProcesses) break;
      this.submitProcess(proc);
    }

    // Update tickInProgress flag for watchdog
    this.tickInProgress = this.inflight.size > 0;
  }

  /**
   * Detect selected blueprint from blackboard (written by goal-orchestrator).
   * Extracted from tick step 8a for reuse in event-driven completion handler.
   */
  private detectSelectedBlueprint(): void {
    if (!this.selectedBlueprintInfo) {
      const bbEntry = this.ipcBus.bbRead("selected_blueprint", "kernel");
      if (bbEntry && typeof bbEntry.value === "string") {
        const bpValue = bbEntry.value;
        if (bpValue.startsWith("novel:")) {
          const novelName = bpValue.slice("novel:".length) || "novel-topology";
          const allProcs = this.table.getAll();
          const novelBp: TopologyBlueprint = {
            id: randomUUID(),
            name: novelName,
            description: `Novel topology auto-registered from run ${this.runId}`,
            source: "orchestrator",
            applicability: {
              goalPatterns: this.extractGoalTags(),
              minSubtasks: 1,
              maxSubtasks: Math.max(allProcs.length, 1),
              requiresSequencing: false,
            },
            roles: allProcs
              .filter((p) => p.type !== "daemon" && p.parentPid !== null)
              .map((p) => ({
                name: p.name,
                type: p.type,
                cardinality: "one" as const,
                priorityOffset: p.priority - 50,
                objectiveTemplate: p.objective.slice(0, 120),
                spawnTiming: "immediate" as const,
              })),
            gatingStrategy: "signal-gate" as BlueprintGatingStrategy,
            priorityStrategy: "gradient-2pt",
            stats: {
              uses: 0,
              successes: 0,
              failures: 0,
              avgTokenEfficiency: 0,
              avgWallTimeMs: 0,
              lastUsedAt: "",
              alpha: 1,
              beta: 1,
              tagStats: {},
            },
            learnedAt: new Date().toISOString(),
          };
          this.memoryStore.addBlueprint(novelBp);
          this.selectedBlueprintInfo = {
            id: novelBp.id,
            name: novelBp.name,
            source: "orchestrator",
            successRate: 0,
            instantiatedRoles: novelBp.roles.map((r) => r.name),
            adapted: true,
          };
          this.emitter?.emit({
            action: "os_blueprint_selected",
            status: "completed",
            message: `blueprint=${novelBp.name} id=${novelBp.id} source=novel`,
            detail: {
              blueprintId: novelBp.id,
              blueprintName: novelBp.name,
              source: "orchestrator",
              adapted: true,
              roles: novelBp.roles.map((r) => r.name),
              successRate: 0,
            },
          });
        } else {
          const bp = this.memoryStore.getBlueprint(bpValue);
          if (bp) {
            this.selectedBlueprintInfo = {
              id: bp.id,
              name: bp.name,
              source: bp.source,
              successRate: bp.stats?.uses ? bp.stats.successes / bp.stats.uses : 0,
              instantiatedRoles: bp.roles.map((r) => r.name),
              adapted: false,
            };
            this.telemetryCollector.onBlueprintSelected(bp.id, this.goal.split(" ").length);
            this.emitter?.emit({
              action: "os_blueprint_selected",
              status: "completed",
              message: `blueprint=${bp.name} id=${bp.id} source=${bp.source}`,
              detail: {
                blueprintId: bp.id,
                blueprintName: bp.name,
                source: bp.source,
                adapted: false,
                roles: bp.roles.map((r) => r.name),
                successRate: bp.stats?.uses ? bp.stats.successes / bp.stats.uses : 0,
                uses: bp.stats?.uses ?? 0,
              },
            });
          }
        }
      }
    }
  }

  /**
   * Execute processes via LLM threads through the ProcessExecutor.
   * Each process gets a persistent thread, receives a context-rich prompt,
   * and returns structured JSON with status and OS commands.
   */
  private async executeProcesses(processes: OsProcess[]): Promise<void> {
    if (processes.length === 0) return;
    this.tickInProgress = true;

    // Register turn start times for all processes (watchdog uses these)
    for (const proc of processes) {
      this.turnStartTimes.set(proc.pid, Date.now());
    }

    // Wrap an individual execution promise with a kill token so the watchdog can unblock it
    const wrapWithKillToken = (proc: OsProcess, execPromise: Promise<OsProcessTurnResult>): Promise<OsProcessTurnResult> => {
      let killResolve!: (r: OsProcessTurnResult) => void;
      const killPromise = new Promise<OsProcessTurnResult>(r => { killResolve = r; });
      this.turnKillCallbacks.set(proc.pid, () => {
        killResolve({
          pid: proc.pid, success: false,
          response: "killed by watchdog metacog",
          tokensUsed: 0, commands: [],
        });
      });
      return Promise.race([execPromise, killPromise]);
    };

    // Execute all processes with concurrency limiting + per-process kill tokens
    const maxConcurrent = this.config.kernel.maxConcurrentProcesses;
    const allProcesses = [...processes];
    const results: OsProcessTurnResult[] = [];
    let index = 0;

    const next = async (): Promise<void> => {
      while (index < allProcesses.length) {
        const proc = allProcesses[index++]!;
        const execPromise = (!proc.backend || proc.backend.kind === "llm")
          ? this.executor.executeOne(proc)
          : this.router.executeOne(proc);
        const result = await wrapWithKillToken(proc, execPromise);
        results.push(result);
      }
    };

    const workers = Array.from(
      { length: Math.min(maxConcurrent, allProcesses.length) },
      () => next(),
    );
    await Promise.all(workers);

    this.turnKillCallbacks.clear();
    this.turnStartTimes.clear();
    this.lastStreamEventAt.clear();
    this.streamTokenCount.clear();
    this.tickInProgress = false;

    for (const result of results) {
      await this.processOneResult(result);
    }

    // Fire-and-forget: drain ephemerals in background so the next tick can start immediately
    void this.drainPendingEphemerals();
  }

  /**
   * Handle a single process turn result: update bookkeeping, enforce spawn
   * invariants, and execute any returned commands.  Extracted from the
   * executeProcesses() for-loop so it can also be called from the
   * event-driven completion handler.
   */
  private summarizeTurnCommands(commands: import("./types.js").OsProcessCommand[]): string {
    const parts: string[] = [];
    for (const cmd of commands) {
      switch (cmd.kind) {
        case "bb_write":
          parts.push(`write(${cmd.key})`);
          break;
        case "bb_read":
          parts.push(`read(${cmd.keys.join(",")})`);
          break;
        case "spawn_child":
          parts.push(`spawn(${cmd.descriptor?.name || "child"})`);
          break;
        case "spawn_graph": {
          const nodes = (cmd as any).nodes || [];
          const names = nodes.map((n: any) => n.name).join(", ");
          parts.push(`graph(${nodes.length} nodes: ${names})`);
          break;
        }
        case "spawn_ephemeral":
          parts.push(`ephemeral(${cmd.name || "scout"})`);
          break;
        case "spawn_system":
          parts.push(`shell(${(cmd as any).command || "cmd"})`);
          break;
        case "idle":
          parts.push(`idle(wake=${((cmd as any).wakeOnSignals || []).join(",")})`);
          break;
        case "exit":
          parts.push(`exit(code=${(cmd as any).code}, ${((cmd as any).reason || "").slice(0, 80)})`);
          break;
        case "signal_emit":
          parts.push(`signal(${(cmd as any).signal})`);
          break;
        default:
          parts.push(cmd.kind);
      }
    }
    return parts.join(" | ");
  }

  private async processOneResult(result: OsProcessTurnResult): Promise<void> {
    const now = new Date().toISOString();
    const proc = this.table.get(result.pid);
    if (!proc) return;

    proc.tickCount += 1;
    proc.tokensUsed += result.tokensUsed;
    proc.lastActiveAt = now;

    // Check if process exceeded its token budget (only when per-process budgets are enabled)
    if (this.config.kernel.processTokenBudgetEnabled &&
        proc.tokenBudget !== undefined && proc.tokensUsed > proc.tokenBudget) {
      this.addTrigger('resource_exhaustion');
      this.emitter?.emit({
        action: 'os_metacog',
        status: 'completed',
        message: `token_budget_exceeded pid=${proc.pid} name=${proc.name} used=${proc.tokensUsed} budget=${proc.tokenBudget}`,
      });
    }

    if (!result.success) {
      // GAP 1: Record strategy FAILURE for the strategy that was active on this process
      if (proc.activeStrategyId) {
        this.memoryStore.recordStrategyOutcome(proc.activeStrategyId, false, proc.tokensUsed);
      }
      // Process failed — kill it and trigger metacog
      const parentPid = proc.parentPid;
      this.supervisor.kill(proc.pid, false, `execution_failed: ${result.response}`);
      this.executor.disposeThread(proc.pid);
      this.router.disposeThread(proc.pid);
      this.emitter?.emit({
        action: "os_process_kill",
        status: "completed",
        agentId: proc.pid,
        agentName: proc.name,
        message: `execution_failed`,
      });
      this.addTrigger("process_failed");

      // Auto-signal parent when a child process dies (don't depend on LLM compliance)
      if (parentPid) {
        this.emitChildDoneSignal(proc.pid, proc.name, parentPid, 1, proc.exitReason ?? `execution_failed: ${result.response}`);
      }
      return;
    }

    // Gap 8: Wire TelemetryCollector.onProcessComplete() for process-level telemetry
    if (this.config.kernel.telemetryEnabled) {
      this.telemetryCollector.onProcessComplete(
        proc.pid,
        result.tokensUsed,
        result.response.split("\n"),
      );
    }

    // ── Hard Spawn Enforcement ──
    // For the top-level orchestrator's first tick: enforce spawn requirement.
    // proc.tickCount was incremented above, so tickCount === 1 means this was tick 0's result.
    if (
      !proc.parentPid &&
      proc.type === "lifecycle" &&
      proc.tickCount === 1
    ) {
      const hasSpawnCommand = result.commands.some(c =>
        c.kind === "spawn_child" || c.kind === "spawn_system" || c.kind === "spawn_kernel" || c.kind === "spawn_ephemeral" || c.kind === "spawn_graph"
      );
      if (!hasSpawnCommand) {
        // REJECT: orchestrator tried to solve directly instead of spawning workers.
        // Preserve bb_write commands so architecture docs aren't lost on retry.
        const bbWrites = result.commands.filter(c => c.kind === "bb_write");
        if (bbWrites.length > 0) {
          await this.executeProcessCommands(proc.pid, bbWrites);
        }
        this.emitter?.emit({
          action: "os_command_rejected",
          status: "completed",
          agentId: proc.pid,
          agentName: proc.name,
          message: `tick 0 rejected: orchestrator produced zero spawn commands — must design topology and spawn child processes (preserved ${bbWrites.length} bb_write commands)`,
        });
        // Discard remaining commands, keep process in running state — it will run again
        // next tick with a re-prompt (see llm-executor rejection re-prompt)
        return;
      }
    }

    // ── Architect-Phase Deadlock Enforcement ──
    // After scouts return, the orchestrator must spawn lifecycle children.
    // If it has scout results but no lifecycle children and is going idle without
    // spawning any, that's a deadlock — reject and re-prompt.
    if (
      !proc.parentPid &&
      proc.type === "lifecycle" &&
      proc.tickCount >= 1
    ) {
      const hasLifecycleChildren = this.table.getAll().some(
        p => p.parentPid === proc.pid && p.type === "lifecycle"
      );
      const hasScoutResults = this.ipcBus.bbReadAll().some(
        entry => entry.key.startsWith("ephemeral:") || entry.key.startsWith("scout:")
      );
      const goingIdle = result.commands.some(c => c.kind === "idle");
      const spawnsLifecycle = result.commands.some(c =>
        c.kind === "spawn_child" || c.kind === "spawn_graph"
      );

      if (!hasLifecycleChildren && hasScoutResults && !spawnsLifecycle) {
        // Preserve bb_write and ephemeral commands before rejecting — don't discard useful work
        const preservable = result.commands.filter(c => c.kind === "bb_write" || c.kind === "spawn_ephemeral");
        if (preservable.length > 0) {
          await this.executeProcessCommands(proc.pid, preservable);
        }
        this.emitter?.emit({
          action: "os_command_rejected",
          status: "completed",
          agentId: proc.pid,
          agentName: proc.name,
          message: `architect-phase deadlock: scout data available but no lifecycle children spawned — must design topology and spawn Phase 0 (preserved ${preservable.length} commands, rejected idle/exit)`,
        });
        return;
      }
    }

    // Emit turn summary so the UI shows what the process decided
    if (this.emitter && result.commands.length > 0) {
      const summary = this.summarizeTurnCommands(result.commands);
      this.emitter.emitStreamEvent(proc.pid, proc.name, {
        type: "status",
        status: `Turn ${proc.tickCount} complete → ${summary}`,
      });
    }

    // Execute any commands the process returned
    await this.executeProcessCommands(proc.pid, result.commands);

    // Auto-exit daemons that complete a turn without issuing exit/idle/sleep.
    // Daemons are housekeeping processes — if they produce output without
    // explicitly managing their own lifecycle, they're done.
    const hasLifecycleCmd = result.commands.some(
      c => c.kind === "exit" || c.kind === "idle" || c.kind === "sleep" || c.kind === "checkpoint"
    );
    if (!hasLifecycleCmd && proc.type === "daemon" && proc.state === "running") {
      this.supervisor.kill(proc.pid, false, "auto-exit: daemon completed turn without lifecycle command");
      this.executor.disposeThread(proc.pid);
      this.router.disposeThread(proc.pid);
      this.emitter?.emit({
        action: "os_process_exit",
        status: "completed",
        agentId: proc.pid,
        agentName: proc.name,
        message: "auto-exit: daemon completed turn without lifecycle command",
      });
    }
  }

  /**
   * Run all pending ephemerals with concurrency control.
   * Ephemerals are spawned non-blocking during command processing;
   * this method runs them in parallel (up to maxConcurrent) and writes
   * results to blackboard + emits wake signals when each completes.
   */
  private async drainPendingEphemerals(): Promise<void> {
    if (this.pendingEphemerals.length === 0) return;

    const pending = [...this.pendingEphemerals];
    this.pendingEphemerals = [];
    const maxConcurrent = this.config.ephemeral.maxConcurrent;

    const runOne = async (desc: typeof pending[0]): Promise<void> => {
      this.activeEphemeralCount++;
      try { await this.runOneEphemeral(desc); } finally { this.activeEphemeralCount--; }
    };

    // Run with concurrency control — classic self-removing pool pattern
    const pool: Promise<void>[] = [];
    for (const desc of pending) {
      const p = runOne(desc).then(() => { pool.splice(pool.indexOf(p), 1); });
      pool.push(p);
      if (pool.length >= maxConcurrent) {
        await Promise.race(pool);
      }
    }
    await Promise.all(pool);
  }

  private async runOneEphemeral(desc: { pid: string; ephemeralId: string; tablePid: string; name: string; model: string; prompt: string; workingDir: string; startTime: number }): Promise<void> {
      try {
        const ephThread = this.client.startThread({
          model: desc.model,
          workingDirectory: desc.workingDir,
          sandboxMode: "danger-full-access",
        });
        this.ephemeralThreads.set(desc.tablePid, ephThread);

        // Emit a synthetic "started" event so the UI shows immediate feedback
        this.emitter?.emitStreamEvent(desc.tablePid, desc.name, {
          type: "status",
          status: `Starting inference (model=${desc.model})...`,
        });

        // Heartbeat: emit periodic progress while waiting for LLM response
        let heartbeatStopped = false;
        const heartbeatInterval = setInterval(() => {
          if (heartbeatStopped) return;
          const elapsed = Math.round((Date.now() - desc.startTime) / 1000);
          this.emitter?.emitStreamEvent(desc.tablePid, desc.name, {
            type: "status",
            status: `Waiting for response... (${elapsed}s elapsed)`,
          });
        }, 15_000);

        let ephTurnResult: import("../types.js").TurnResult;
        try {
          ephTurnResult = await ephThread.run(desc.prompt, {
            onStreamEvent: this.emitter
              ? (event) => {
                  this.emitter!.emitStreamEvent(desc.tablePid, desc.name, event);
                  this.lastStreamEventAt.set(desc.tablePid, Date.now());
                  this.streamTokenCount.set(desc.tablePid, (this.streamTokenCount.get(desc.tablePid) ?? 0) + 1);
                }
              : undefined,
          });
        } finally {
          heartbeatStopped = true;
          clearInterval(heartbeatInterval);
        }
        this.ephemeralThreads.delete(desc.tablePid);
        const ephDurationMs = Date.now() - desc.startTime;

        // Emit completion summary with response preview
        const responsePreview = ephTurnResult.finalResponse.slice(0, 200).replace(/\n/g, " ");
        this.emitter?.emitStreamEvent(desc.tablePid, desc.name, {
          type: "status",
          status: `Completed in ${Math.round(ephDurationMs / 1000)}s (${Math.ceil(ephTurnResult.finalResponse.length / 4)} tokens)`,
        });
        // Emit response preview as thinking so it's expandable
        if (responsePreview) {
          this.emitter?.emitStreamEvent(desc.tablePid, desc.name, {
            type: "text_delta",
            text: responsePreview + (ephTurnResult.finalResponse.length > 200 ? "..." : ""),
          });
        }

        const ephResult: import("./types.js").OsEphemeralResult = {
          ephemeralId: desc.ephemeralId,
          name: desc.name,
          success: true,
          response: ephTurnResult.finalResponse,
          durationMs: ephDurationMs,
          model: desc.model,
          tokensEstimate: Math.ceil(ephTurnResult.finalResponse.length / 4),
        };

        // Wrap state mutations in mutex for proper wake + reschedule
        const release = await this.mutex.acquire();
        try {
          this.ipcBus.bbWrite(`ephemeral:${desc.name}:${desc.ephemeralId}`, ephResult, "kernel");
          this.ipcBus.emitSignal("ephemeral:ready", "kernel", { name: desc.name, id: desc.ephemeralId, parentPid: desc.pid });
          this.tickSignals.push("ephemeral:ready");

          // Kill the process table entry so it shows as dead in topology
          this.supervisor.kill(desc.tablePid, false, "ephemeral completed");
          this.emitter?.emit({
            action: "os_process_exit",
            status: "completed",
            agentId: desc.tablePid,
            agentName: desc.name,
            message: `completed duration=${ephDurationMs}ms`,
          });

          if (this.config.kernel.telemetryEnabled) {
            this.telemetryCollector.onEphemeralComplete(ephResult);
          }

          this.emitter?.emit({
            action: "os_ephemeral_spawn",
            status: "completed",
            agentId: desc.ephemeralId,
            agentName: desc.name,
            message: `parent=${desc.pid} model=${desc.model} duration=${ephDurationMs}ms`,
          });

          // Flush IPC + wake + reschedule
          const { wokenPids } = this.ipcBus.flush();
          for (const pid of wokenPids) {
            const p = this.table.get(pid);
            if (p && p.state === "idle") this.supervisor.activate(pid);
          }
          this.dagEngine.buildFromProcesses(this.table.getAll());
          this.emitter?.writeLiveState(this.snapshot());
          if (this.shouldHalt()) { this.haltResolve?.(); return; }
          this.doSchedulingPass();
        } finally {
          release();
        }
      } catch (err) {
        this.ephemeralThreads.delete(desc.tablePid);
        const ephDurationMs = Date.now() - desc.startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Emit failure summary
        this.emitter?.emitStreamEvent(desc.tablePid, desc.name, {
          type: "status",
          status: `Failed after ${Math.round(ephDurationMs / 1000)}s: ${errorMsg.slice(0, 200)}`,
        });

        const ephResult: import("./types.js").OsEphemeralResult = {
          ephemeralId: desc.ephemeralId,
          name: desc.name,
          success: false,
          response: "",
          error: errorMsg,
          durationMs: ephDurationMs,
          model: desc.model,
          tokensEstimate: 0,
        };

        // Wrap state mutations in mutex for proper wake + reschedule
        const release = await this.mutex.acquire();
        try {
          this.ipcBus.bbWrite(`ephemeral:${desc.name}:${desc.ephemeralId}`, ephResult, "kernel");
          this.ipcBus.emitSignal("ephemeral:ready", "kernel", { name: desc.name, id: desc.ephemeralId, parentPid: desc.pid, error: true });
          this.tickSignals.push("ephemeral:ready");

          // Kill the process table entry so it shows as dead in topology
          this.supervisor.kill(desc.tablePid, false, `ephemeral failed: ${errorMsg}`);
          this.emitter?.emit({
            action: "os_process_exit",
            status: "failed",
            agentId: desc.tablePid,
            agentName: desc.name,
            message: `failed: ${errorMsg}`,
          });

          if (this.config.kernel.telemetryEnabled) {
            this.telemetryCollector.onEphemeralComplete(ephResult);
          }

          this.emitter?.emit({
            action: "os_ephemeral_spawn",
            status: "failed",
            agentId: desc.ephemeralId,
            agentName: desc.name,
            message: `parent=${desc.pid} error=${errorMsg}`,
          });

          // Flush IPC + wake + reschedule
          const { wokenPids } = this.ipcBus.flush();
          for (const pid of wokenPids) {
            const p = this.table.get(pid);
            if (p && p.state === "idle") this.supervisor.activate(pid);
          }
          this.dagEngine.buildFromProcesses(this.table.getAll());
          this.emitter?.writeLiveState(this.snapshot());
          if (this.shouldHalt()) { this.haltResolve?.(); return; }
          this.doSchedulingPass();
        } finally {
          release();
        }
      }
  }

  /**
   * Execute OS commands returned by a process turn.
   */
  private async executeProcessCommands(pid: string, commands: OsProcessCommand[]): Promise<void> {
    const procName = this.table.get(pid)?.name ?? pid;
    // Reorder: process exit LAST so bb_write/signals run before death
    const reordered = [
      ...commands.filter((c) => c.kind !== "exit"),
      ...commands.filter((c) => c.kind === "exit"),
    ];

    for (const cmd of reordered) {
      try {
        switch (cmd.kind) {
          case "sleep":
            this.supervisor.sleep(pid, cmd.durationMs);
            break;

          case "idle":
            this.supervisor.idle(pid, {
              signals: cmd.wakeOnSignals,
            });
            break;

          case "checkpoint": {
            const summary = cmd.summary ?? `auto-checkpoint at tick ${this.scheduler.tickCount}`;
            const objectives = cmd.pendingObjectives ?? [];
            const cpArtifacts = cmd.artifacts ?? {};
            const cp = this.supervisor.checkpoint(pid, summary, objectives, cpArtifacts);

            // Enrich checkpoint with process metadata + executor state for cross-run persistence
            const cpProc = this.table.get(pid);
            if (cpProc) {
              cp.runId = this.runId;
              cp.tickCount = cpProc.tickCount;
              cp.tokensUsed = cpProc.tokensUsed;
              cp.processName = cpProc.name;
              cp.processType = cpProc.type;
              cp.processObjective = cpProc.objective;
              cp.processPriority = cpProc.priority;
              cp.processModel = cpProc.model;
              cp.processWorkingDir = cpProc.workingDir;
              cp.parentPid = cpProc.parentPid;
              cp.backend = cpProc.backend;
              cp.executorState = this.router.captureCheckpointState(cpProc) ?? undefined;
            }

            // Persist to disk
            this.memoryStore.saveCheckpoint(cp);

            this.emitter?.emit({
              action: "os_checkpoint",
              status: "completed",
              agentId: pid,
              agentName: procName,
              message: `checkpoint saved: ${summary}`,
            });
            break;
          }

          case "spawn_child": {
            const childTokenBudget = this.config.kernel.processTokenBudgetEnabled
              ? (cmd.descriptor.tokenBudget ??
                (this.blueprintDerivedTokenBudget > 0 ? this.blueprintDerivedTokenBudget : undefined))
              : undefined;
            // Auto-infer browser capabilities for observer-named processes
            const inferredCapabilities = cmd.descriptor.capabilities
              ?? (this.browserMcpConfig && /observer/i.test(cmd.descriptor.name)
                ? { observationTools: ["browser"] }
                : undefined);

            const resolvedDescriptor = {
              ...cmd.descriptor,
              capabilities: inferredCapabilities,
              tokenBudget: childTokenBudget,
              parentPid: pid,
              // Always use config default model — LLM may output wrong provider model names
              model: this.config.kernel.processModel,
              workingDir: cmd.descriptor.workingDir ?? this.workingDir,
            };

            // Conditional spawn: if condition is present, register as deferral
            if (cmd.condition) {
              // Dedup: reject if same parent already has a pending deferral with this spawn name
              const dupDefer = [...this.deferrals.values()].find(
                d => d.descriptor.name === cmd.descriptor.name && d.registeredByPid === pid
              );
              if (dupDefer) {
                this.emitter?.emit({
                  action: "os_command_rejected",
                  status: "completed",
                  agentId: pid,
                  agentName: procName,
                  message: `defer dedup: "${cmd.descriptor.name}" already has pending deferral id=${dupDefer.id} from same parent`,
                });
                break;
              }
              const ds: DeferEntry = {
                id: randomUUID(),
                descriptor: resolvedDescriptor,
                condition: cmd.condition,
                registeredAt: new Date().toISOString(),
                registeredAtMs: Date.now(),
                registeredByTick: this.scheduler.tickCount,
                registeredByPid: pid,
                reason: `conditional spawn_child from ${pid}: ${cmd.descriptor.name}`,
                maxWaitTicks: cmd.maxWaitTicks,
                maxWaitMs: cmd.maxWaitTicks ? cmd.maxWaitTicks * 30_000 : undefined, // ~30s per logical tick as wall-clock fallback
              };
              this.deferrals.set(ds.id, ds);
              this.emitter?.emit({
                action: "os_defer",
                status: "started",
                agentId: pid,
                agentName: procName,
                message: `deferred spawn of "${cmd.descriptor.name}" condition=${JSON.stringify(cmd.condition)}`,
              });
            } else {
              // Immediate spawn (existing behavior)
              const child = this.supervisor.spawn(resolvedDescriptor);
              this.supervisor.activate(child.pid);
              this.emitter?.emit({
                action: "os_process_spawn",
                status: "completed",
                agentId: child.pid,
                agentName: child.name,
                message: `parent=${pid}`,
              });
            }
            break;
          }

          case "spawn_graph": {
            let immediateCount = 0;
            let deferredCount = 0;
            for (const node of cmd.nodes) {
              const nodeTokenBudget = this.config.kernel.processTokenBudgetEnabled
                ? (this.blueprintDerivedTokenBudget > 0 ? this.blueprintDerivedTokenBudget : undefined)
                : undefined;
              // Auto-infer browser capabilities for observer-named processes
              // when browserMcpConfig is available but the LLM didn't emit capabilities
              const inferredCapabilities = node.capabilities
                ?? (this.browserMcpConfig && /observer/i.test(node.name)
                  ? { observationTools: ["browser"] }
                  : undefined);

              const nodeDescriptor = {
                type: node.type as "daemon" | "lifecycle" | "event",
                name: node.name,
                objective: node.objective,
                priority: node.priority,
                completionCriteria: node.completionCriteria,
                capabilities: inferredCapabilities,
                tokenBudget: nodeTokenBudget,
                parentPid: pid,
                model: this.config.kernel.processModel,
                workingDir: this.workingDir,
              };

              if (!node.after || node.after.length === 0) {
                // Immediate spawn — no dependencies
                const child = this.supervisor.spawn(nodeDescriptor);
                this.supervisor.activate(child.pid);
                immediateCount++;
                this.emitter?.emit({
                  action: "os_process_spawn",
                  status: "completed",
                  agentId: child.pid,
                  agentName: child.name,
                  message: `parent=${pid} (graph immediate: "${node.name}")`,
                });
              } else {
                // Parse after strings into DeferCondition
                const conditions: DeferCondition[] = node.after.map((dep) => {
                  if (dep.includes(":")) {
                    // Contains colon → blackboard key
                    return { type: "blackboard_key_exists" as const, key: dep };
                  }
                  // No colon → process name
                  return { type: "process_dead_by_name" as const, name: dep };
                });

                const condition: DeferCondition = conditions.length === 1
                  ? conditions[0]!
                  : { type: "all_of", conditions };

                // Dedup: reject if same parent already has a pending deferral with this spawn name
                const dupGraphDefer = [...this.deferrals.values()].find(
                  d => d.descriptor.name === node.name && d.registeredByPid === pid
                );
                if (dupGraphDefer) {
                  this.emitter?.emit({
                    action: "os_command_rejected",
                    status: "completed",
                    agentId: pid,
                    agentName: procName,
                    message: `defer dedup: graph node "${node.name}" already has pending deferral id=${dupGraphDefer.id} from same parent`,
                  });
                  continue;
                }
                const ds: DeferEntry = {
                  id: randomUUID(),
                  descriptor: nodeDescriptor,
                  condition,
                  registeredAt: new Date().toISOString(),
                  registeredAtMs: Date.now(),
                  registeredByTick: this.scheduler.tickCount,
                  registeredByPid: pid,
                  reason: `graph node "${node.name}" after=[${node.after.join(", ")}]`,
                };
                this.deferrals.set(ds.id, ds);
                deferredCount++;
                this.emitter?.emit({
                  action: "os_defer",
                  status: "started",
                  agentId: pid,
                  agentName: procName,
                  message: `graph deferred: "${node.name}" after=[${node.after.join(", ")}] id=${ds.id}`,
                });
              }
            }
            this.emitter?.emit({
              action: "os_defer",
              status: "started",
              agentId: pid,
              agentName: procName,
              message: `spawn_graph: ${immediateCount} immediate, ${deferredCount} deferred (${cmd.nodes.length} total nodes)`,
            });
            break;
          }

          case "bb_write":
            this.ipcBus.bbWrite(cmd.key, cmd.value, pid);
            // Gap 6: track which blackboard keys each process has written so metacog
            // can see data provenance (who produced what) in buildContextPrompt.
            {
              const writingProc = this.table.get(pid);
              if (writingProc) {
                if (!writingProc.blackboardKeysWritten) writingProc.blackboardKeysWritten = [];
                if (!writingProc.blackboardKeysWritten.includes(cmd.key)) {
                  writingProc.blackboardKeysWritten.push(cmd.key);
                }
              }

              // Emit shell output as protocol events so they flow through the
              // stream segmenter and appear in live terminal views.
              // The bb_write value is the CUMULATIVE ring buffer, so we track
              // last-emitted line count and only emit the delta.
              if (writingProc?.backend?.kind === "system" && typeof cmd.value === "string") {
                const isStdout = cmd.key.endsWith(":stdout");
                const isStderr = cmd.key.endsWith(":stderr");
                if (isStdout || isStderr) {
                  const allLines = cmd.value.split("\n");
                  const cursorKey = `${pid}:${isStderr ? "stderr" : "stdout"}`;
                  const lastCount = this.shellOutputCursors.get(cursorKey) ?? 0;
                  const newLines = allLines.slice(lastCount);
                  this.shellOutputCursors.set(cursorKey, allLines.length);
                  if (newLines.length > 0) {
                    this.emitter?.emit({
                      action: "os_shell_output",
                      status: "completed",
                      agentId: pid,
                      agentName: writingProc.name,
                      message: newLines.join("\n"),
                      detail: {
                        stream: isStderr ? "stderr" : "stdout",
                        key: cmd.key,
                        lineCount: newLines.length,
                      },
                    });
                  }
                }
              }
            }
            break;

          case "bb_read":
            // Read is handled by injecting results into the next prompt turn.
            // Store the read results on the blackboard under a process-scoped key
            // so buildProcessPrompt can include them.
            {
              const readResults: Record<string, unknown> = {};
              for (const key of cmd.keys) {
                const entry = this.ipcBus.bbRead(key, pid);
                if (entry) {
                  readResults[key] = entry.value;
                }
              }
              // Write the read results back so the process sees them on next turn
              this.ipcBus.bbWrite(`_inbox:${pid}`, readResults, "kernel");
            }
            break;

          case "signal_emit":
            this.ipcBus.emitSignal(cmd.signal, pid, cmd.payload);
            this.tickSignals.push(cmd.signal);
            break;

          case "request_kernel":
            this.ipcBus.bbWrite(`kernel_request:${pid}`, cmd.question, pid);
            this.addTrigger("novel_situation");
            break;

          case "spawn_ephemeral": {
            const ephProc = this.table.get(pid);
            if (!ephProc) break;
            if (!this.config.ephemeral.enabled) break;

            const spawnCount = ephProc.ephemeralSpawnCount ?? 0;
            if (spawnCount >= this.config.ephemeral.maxPerProcess) {
              const rejName = cmd.name ?? "unnamed";
              this.ipcBus.bbWrite(`ephemeral:${rejName}:rejected`, {
                success: false,
                error: `Per-process ephemeral limit reached (${this.config.ephemeral.maxPerProcess})`,
              }, "kernel");
              break;
            }

            const ephemeralId = `eph-${randomUUID().slice(0, 12)}`;
            const ephName = cmd.name ?? "ephemeral";
            // Always use the config default model for ephemerals. The LLM may
            // output a model name from the wrong provider (e.g. "claude-haiku-4-5"
            // when running under Codex). The config default is already set to the
            // correct provider-appropriate model by entry.ts.
            const ephModel = this.config.ephemeral.defaultModel;

            // Register in process table so ephemerals appear in topology/DAG
            const ephTableProc = this.supervisor.spawn({
              type: "event",
              name: ephName,
              objective: cmd.objective,
              parentPid: pid,
              model: ephModel,
              workingDir: ephProc.workingDir,
            });
            this.supervisor.activate(ephTableProc.pid);
            this.emitter?.emit({
              action: "os_process_spawn",
              status: "started",
              agentId: ephTableProc.pid,
              agentName: ephName,
              message: `parent=${procName} type=ephemeral model=${ephModel}`,
            });

            // Non-blocking: push descriptor, increment count, continue processing commands
            ephProc.ephemeralSpawnCount = spawnCount + 1;
            this.pendingEphemerals.push({
              pid,
              ephemeralId,
              tablePid: ephTableProc.pid,
              name: ephName,
              model: ephModel,
              prompt: [
                "You are a single-turn helper process. You run once, return findings, then terminate.",
                "IMPORTANT: You have NO blackboard access. Do NOT claim to write to any blackboard key (scout:*, ephemeral:*, etc.).",
                "Your text response IS your output — the kernel captures it and delivers it to your parent automatically.",
                "Your work directly unblocks your parent — accuracy and completeness matter.",
                "",
                "## Context",
                `Parent process: ${ephProc.name} (working on: ${ephProc.objective ?? "unknown"})`,
                `Working directory: ${ephProc.workingDir}`,
                "",
                "## Task",
                cmd.objective,
                "",
                "## Tools",
                "You have full access to: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch.",
                "USE THEM. Do not guess file contents — read them. Do not guess command output — run them.",
                "",
                "## Output Format",
                "Structure your response for machine consumption by your parent process:",
                "- Lead with the direct answer or result",
                "- Use headings/lists for multi-part findings",
                "- Include exact file paths, line numbers, and code snippets when relevant",
                "- Omit preamble, pleasantries, and meta-commentary",
                "- If you found nothing or cannot complete the task, say so immediately with what blocked you",
                "",
                "## Constraints",
                "- Single turn only — you cannot spawn processes or continue after this response",
                "- Stay focused on the task above — do not explore tangents",
              ].join("\n"),
              workingDir: ephProc.workingDir,
              startTime: Date.now(),
            });
            break;
          }

          case "spawn_system": {
            // Feature gate
            if (!this.config.systemProcess?.enabled) {
              this.emitter?.emit({
                action: "os_command_rejected",
                status: "failed",
                agentId: pid,
                agentName: procName,
                message: `spawn_system rejected: systemProcess.enabled is false`,
              });
              break;
            }
            // Check limit
            const systemCount = this.table.getAll().filter(
              p => p.backend?.kind === "system" && p.state !== "dead"
            ).length;
            if (systemCount >= this.config.systemProcess.maxSystemProcesses) {
              this.emitter?.emit({
                action: "os_command_rejected",
                status: "failed",
                agentId: pid,
                agentName: procName,
                message: `spawn_system rejected: max system processes (${this.config.systemProcess.maxSystemProcesses}) reached`,
              });
              break;
            }
            const sysChild = this.supervisor.spawn({
              type: "lifecycle",
              name: cmd.name,
              objective: `System process: ${cmd.command} ${(cmd.args ?? []).join(" ")}`,
              parentPid: pid,
              model: this.config.kernel.processModel,
              workingDir: this.workingDir,
              backend: { kind: "system", command: cmd.command, args: cmd.args, env: cmd.env },
            });
            this.supervisor.activate(sysChild.pid);
            // Start the shell process in the router
            this.router.startProcess(sysChild).catch(() => {
              this.supervisor.kill(sysChild.pid, false, "shell start failed");
            });
            this.emitter?.emit({
              action: "os_system_spawn",
              status: "completed",
              agentId: sysChild.pid,
              agentName: sysChild.name,
              message: `command=${cmd.command} parent=${pid}`,
              detail: {
                trigger: "process",
                command: cmd.command,
                args: cmd.args,
                parentPid: pid,
                objective: sysChild.objective,
              },
            });
            break;
          }

          case "spawn_kernel": {
            // Feature gate
            if (!this.config.childKernel?.enabled) {
              this.emitter?.emit({
                action: "os_command_rejected",
                status: "failed",
                agentId: pid,
                agentName: procName,
                message: `spawn_kernel rejected: childKernel.enabled is false`,
              });
              break;
            }
            // Depth guard: child kernels cannot spawn sub-kernels
            if (this.config.kernel.parentKernelId) {
              this.emitter?.emit({
                action: "os_command_rejected",
                status: "failed",
                agentId: pid,
                agentName: procName,
                message: `spawn_kernel rejected: this kernel is already a child (depth limit)`,
              });
              break;
            }
            // Check limit
            const kernelCount = this.table.getAll().filter(
              p => p.backend?.kind === "kernel" && p.state !== "dead"
            ).length;
            if (kernelCount >= this.config.childKernel.maxChildKernels) {
              this.emitter?.emit({
                action: "os_command_rejected",
                status: "failed",
                agentId: pid,
                agentName: procName,
                message: `spawn_kernel rejected: max child kernels (${this.config.childKernel.maxChildKernels}) reached`,
              });
              break;
            }
            const kernelChild = this.supervisor.spawn({
              type: "lifecycle",
              name: cmd.name,
              objective: `Sub-kernel: ${cmd.goal}`,
              parentPid: pid,
              model: this.config.kernel.processModel,
              workingDir: this.workingDir,
              backend: { kind: "kernel", goal: cmd.goal, maxTicks: cmd.maxTicks },
            });
            this.supervisor.activate(kernelChild.pid);
            // Boot the child kernel in the router
            this.router.startProcess(kernelChild).catch(() => {
              this.supervisor.kill(kernelChild.pid, false, "subkernel boot failed");
            });
            this.emitter?.emit({
              action: "os_subkernel_spawn",
              status: "completed",
              agentId: kernelChild.pid,
              agentName: kernelChild.name,
              message: `goal=${cmd.goal} parent=${pid}`,
              detail: {
                trigger: "process",
                goal: cmd.goal,
                parentPid: pid,
                maxTicks: cmd.maxTicks,
              },
            });
            break;
          }

          case "cancel_defer": {
            // Cancel pending deferrals by spawn name, scoped to this process as registrant
            const matches = [...this.deferrals.entries()].filter(
              ([, d]) => d.descriptor.name === cmd.name && d.registeredByPid === pid
            );
            if (matches.length === 0) {
              this.emitter?.emit({
                action: "os_command_rejected",
                status: "completed",
                agentId: pid,
                agentName: procName,
                message: `cancel_defer: no pending deferral with name "${cmd.name}" from this process`,
              });
              break;
            }
            for (const [id] of matches) {
              this.deferrals.delete(id);
            }
            this.emitter?.emit({
              action: "os_defer",
              status: "completed",
              agentId: pid,
              agentName: procName,
              message: `cancel_defer: removed ${matches.length} deferral(s) for "${cmd.name}" reason="${cmd.reason}"`,
            });
            break;
          }

          case "exit": {
            const exitingProc = this.table.get(pid);
            const parentOfExiting = exitingProc?.parentPid;

            // ── Executive Exit Prevention ──
            // The orchestrator must not exit while the computation topology is active.
            // This mirrors Unix init protection — the executive process IS coherence.
            if (exitingProc && !exitingProc.parentPid && exitingProc.type === "lifecycle" && exitingProc.name === "goal-orchestrator") {
              const livingChildren = this.table.getAll().filter(
                p => p.parentPid === pid && p.state !== "dead"
              );
              const hasDeferrals = this.deferrals.size > 0;

              if (livingChildren.length > 0 || hasDeferrals) {
                // Reject exit. If deferrals remain but no living children exist,
                // child:done alone is an impossible wake condition, so also wake
                // on the next tick to force a deferral re-scan / executive re-eval.
                const wakeSignals = livingChildren.length > 0
                  ? ["child:done"]
                  : ["tick:1", "child:done"];
                this.supervisor.idle(pid, { signals: wakeSignals });
                this.emitter?.emit({
                  action: "os_command_rejected",
                  status: "completed",
                  agentId: pid,
                  agentName: exitingProc.name,
                  message: `executive exit prevented: ${livingChildren.length} living children, ${this.deferrals.size} pending deferrals — forced idle with wakeOnSignals: ${JSON.stringify(wakeSignals)}`,
                });
                this.addTrigger("goal_drift");
                break; // Skip the kill
              }
            }

            // GAP 1: Record per-process strategy outcome based on exit code
            if (exitingProc?.activeStrategyId) {
              this.memoryStore.recordStrategyOutcome(
                exitingProc.activeStrategyId,
                cmd.code === 0,
                exitingProc.tokensUsed,
              );
            }
            // Trigger observation_failed when an observer exits with non-zero code
            if (
              cmd.code !== 0 &&
              exitingProc?.capabilities?.observationTools?.length
            ) {
              this.addTrigger("observation_failed");
            }
            this.supervisor.kill(pid, false, cmd.reason);
            this.executor.disposeThread(pid);
            this.router.disposeThread(pid);
            this.emitter?.emit({
              action: "os_process_kill",
              status: "completed",
              agentId: pid,
              agentName: exitingProc?.name ?? procName,
              message: `exit: ${cmd.reason}`,
            });
            // Auto-signal parent when a child exits (structural, not LLM-dependent)
            if (parentOfExiting && exitingProc) {
              this.emitChildDoneSignal(pid, exitingProc.name, parentOfExiting, cmd.code, cmd.reason);
            }
            break;
          }

          case "self_report": {
            const reportingProc = this.table.get(pid);
            if (reportingProc) {
              if (!reportingProc.selfReports) reportingProc.selfReports = [];
              const report: SelfReport = {
                tick: reportingProc.tickCount,
                efficiency: cmd.efficiency,
                blockers: cmd.blockers,
                resourcePressure: cmd.resourcePressure,
                suggestedAction: cmd.suggestedAction,
                reason: cmd.reason,
                timestamp: new Date().toISOString(),
              };
              reportingProc.selfReports.push(report);
              this.emitter?.emit({
                action: "os_process_event",
                status: "completed",
                agentId: pid,
                agentName: reportingProc.name,
                message: `self_report efficiency=${cmd.efficiency} pressure=${cmd.resourcePressure} action=${cmd.suggestedAction}${cmd.blockers.length > 0 ? ' blockers=' + cmd.blockers.join(',') : ''}`,
                detail: {
                  kind: "self_report",
                  efficiency: cmd.efficiency,
                  resourcePressure: cmd.resourcePressure,
                  suggestedAction: cmd.suggestedAction,
                  blockers: cmd.blockers,
                  reason: cmd.reason,
                  tick: reportingProc.tickCount,
                },
              });
            }
            break;
          }
        }
      } catch {
        // Command execution failed — continue with remaining commands
      }
    }
  }

  /**
   * Parse the metacog response for structured commands and execute them.
   * Gracefully handles non-JSON responses (backward compatible with existing tests).
   */
  private parseMetacogResponse(response: string): number | undefined {
    let parsed: MetacogResponse;
    try {
      parsed = JSON.parse(response);
    } catch {
      // Non-JSON response — graceful no-op (backward compat with mock threads)
      return undefined;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.commands)) {
      return undefined;
    }

    this.emitter?.emit({
      action: "os_metacog",
      status: "completed",
      message: `assessment=${parsed.assessment ?? "none"} commands=${parsed.commands.length}`,
      detail: {
        assessment: parsed.assessment ?? "",
        commands: parsed.commands.map((c: { kind: string; reason?: string; pid?: string; descriptor?: { name?: string }; heuristic?: string; confidence?: number }) => ({
          kind: c.kind,
          reason: c.reason,
          targetPid: c.pid,
          targetName: c.descriptor?.name,
          ...(c.kind === "learn" ? { heuristic: c.heuristic, confidence: c.confidence } : {}),
        })),
        citedHeuristicIds: parsed.citedHeuristicIds,
        commandCount: parsed.commands.length,
      },
    });

    // Record metacog decision in history for awareness daemon analysis
    const historyEntry: MetacogHistoryEntry = {
      tick: this.scheduler.tickCount,
      assessment: parsed.assessment ?? "",
      commands: parsed.commands,
      trigger: this.pendingTriggers.length > 0 ? this.pendingTriggers[0] : undefined,
    };
    this.metacogHistory.push(historyEntry);
    if (this.metacogHistory.length > this.config.awareness.historyWindow) {
      this.metacogHistory = this.metacogHistory.slice(-this.config.awareness.historyWindow);
    }

    // Retroactively fill outcome for entry from ~5 ticks ago
    const retroTick = this.scheduler.tickCount - 5;
    const retroEntry = this.metacogHistory.find(e => e.tick === retroTick && !e.outcome);
    if (retroEntry) {
      const allProcsNow = this.table.getAll();
      const activeNow = allProcsNow.filter(p => p.state === "running").length;
      const stalledNow = allProcsNow.filter(p => p.state === "sleeping" || p.state === "idle").length;
      const totalNow = allProcsNow.filter(p => p.state !== "dead").length;
      const stalledRatio = totalNow > 0 ? stalledNow / totalNow : 0;
      // Simple heuristic: improved if stalled ratio is low, degraded if high
      retroEntry.outcome = stalledRatio < 0.3 ? "improved" : stalledRatio > 0.6 ? "degraded" : "neutral";
    }

    // Snapshot intervention count BEFORE executing commands so we can
    // reliably identify which interventions were created THIS tick
    const preInterventionCount = this.pendingInterventions.length;

    for (const cmd of parsed.commands) {
      try {
        this.executeMetacogCommand(cmd);
      } catch {
        // Individual command failure shouldn't stop others
      }
    }

    // Get intervention IDs that were JUST created (if any)
    const newInterventionIds = this.pendingInterventions
      .slice(preInterventionCount)
      .map(iv => iv.id);
    const firstInterventionId = newInterventionIds.length > 0
      ? newInterventionIds[0]
      : undefined;

    // Track which heuristics influenced this evaluation for retrospective validation.
    // Uses metacog's explicit citations (citedHeuristicIds) when available — these are
    // heuristics the metacog actually read and acted on, not just textually similar ones.
    // Falls back to Jaccard top-5 only when the metacog doesn't cite (backward compat).
    const citedIds = Array.isArray(parsed.citedHeuristicIds) && parsed.citedHeuristicIds.length > 0
      ? parsed.citedHeuristicIds.filter((id: string) => this.memoryStore.get(id) !== undefined)
      : this.memoryStore.query(this.goal).slice(0, 5).map(h => h.id);
    for (const hId of citedIds) {
      this.heuristicApplicationLog.push({
        heuristicId: hId,
        appliedAtTick: this.scheduler.tickCount,
        metacogCommandKind: parsed.commands[0]?.kind ?? 'unknown',
        interventionId: firstInterventionId,
      });
    }
    // Cap log at 200 entries
    if (this.heuristicApplicationLog.length > 200) {
      this.heuristicApplicationLog = this.heuristicApplicationLog.slice(-200);
    }

    // Return metacog's self-scheduled next wake time (if provided)
    return typeof parsed.nextWakeMs === "number" && parsed.nextWakeMs > 0
      ? parsed.nextWakeMs
      : undefined;
  }

  /**
   * Execute a single metacognitive command.
   */
  private executeMetacogCommand(cmd: MetacogCommand): void {
    // Capture pre-snapshot for intervention outcome tracking
    const interventionTrackedKinds: Array<MetacogCommand['kind']> = [
      'fork', 'kill', 'spawn', 'defer', 'reprioritize',
      'rewrite_dag', 'evolve_blueprint',
    ];
    if ((interventionTrackedKinds as string[]).includes(cmd.kind)) {
      const allProcsNow = this.table.getAll();
      const totalTokensNow = allProcsNow.reduce((s, p) => s + p.tokensUsed, 0);
      const preSnap: InterventionSnapshot = {
        totalTokensUsed: totalTokensNow,
        activeProcessCount: allProcsNow.filter(p => p.state === 'running').length,
        stalledProcessCount: allProcsNow.filter(p => p.state === 'sleeping' || p.state === 'idle').length,
        deadCount: allProcsNow.filter(p => p.state === 'dead').length,
      };

      // Capture topology snapshot for causal attribution
      const dagMetrics = this.dagEngine.metrics();
      const livingProcs = allProcsNow.filter(p => p.state !== 'dead');
      const livingCount = livingProcs.length;
      const stalledCount = livingProcs.filter(p => p.state === 'sleeping' || p.state === 'idle').length;
      const idleCount = livingProcs.filter(p => p.state === 'idle').length;
      const wallTimeMs = Date.now() - this.startTime;
      const causalFactors: TopologySnapshot = {
        processCount: livingCount,
        stalledRatio: livingCount > 0 ? stalledCount / livingCount : 0,
        tokenVelocity: wallTimeMs > 0 ? (totalTokensNow / wallTimeMs) * 1000 : 0,
        dagDepth: dagMetrics.maxDepth,
        idleRatio: livingCount > 0 ? idleCount / livingCount : 0,
      };

      this.pendingInterventions.push({
        id: randomUUID(),
        commandKind: cmd.kind,
        tick: this.scheduler.tickCount,
        preSnapshot: preSnap,
        ticksToEvaluate: 5,
        causalFactors,
      });
    }

    switch (cmd.kind) {
      case "spawn": {
        // Dedup: skip if a living process or pending deferral already has this name
        const dupLiving = this.table.getAll().find(
          p => p.name === cmd.descriptor.name && p.state !== "dead"
        );
        const dupDeferred = [...this.deferrals.values()].find(
          d => d.descriptor.name === cmd.descriptor.name
        );
        if (dupLiving || dupDeferred) {
          this.emitter?.emit({
            action: "os_command_rejected",
            status: "completed",
            message: `metacog spawn dedup: "${cmd.descriptor.name}" already ${dupLiving ? "alive" : "deferred"}`,
          });
          break;
        }
        const proc = this.supervisor.spawn({
          ...cmd.descriptor,
          // Always use config default model — LLM may output wrong provider model names
          model: this.config.kernel.processModel,
          workingDir: cmd.descriptor.workingDir ?? this.workingDir,
        });
        this.supervisor.activate(proc.pid);
        this.emitter?.emit({
          action: "os_process_spawn",
          status: "completed",
          agentId: proc.pid,
          agentName: proc.name,
          message: `metacog_spawn`,
          detail: {
            trigger: "metacog",
            objective: cmd.descriptor.objective,
            type: cmd.descriptor.type,
            priority: cmd.descriptor.priority,
            model: this.config.kernel.processModel,
          },
        });
        break;
      }

      case "defer": {
        // Dedup: reject if a pending deferral with the same spawn name already exists
        const dupDefer = [...this.deferrals.values()].find(
          d => d.descriptor.name === cmd.descriptor.name
        );
        if (dupDefer) {
          this.emitter?.emit({
            action: "os_command_rejected",
            status: "completed",
            message: `defer dedup: "${cmd.descriptor.name}" already has pending deferral id=${dupDefer.id} — use cancel_defer first to replace`,
          });
          break;
        }
        const ds: DeferEntry = {
          id: randomUUID(),
          descriptor: {
            ...cmd.descriptor,
            // Always use config default model — LLM may output wrong provider model names
            model: this.config.kernel.processModel,
            workingDir: cmd.descriptor.workingDir ?? this.workingDir,
          },
          condition: cmd.condition,
          registeredAt: new Date().toISOString(),
          registeredAtMs: Date.now(),
          registeredByTick: this.scheduler.tickCount,
          reason: cmd.reason,
          maxWaitTicks: cmd.maxWaitTicks,
          maxWaitMs: cmd.maxWaitTicks ? cmd.maxWaitTicks * 30_000 : undefined,
        };
        this.deferrals.set(ds.id, ds);
        this.emitter?.emit({
          action: "os_defer",
          status: "started",
          message: `registered id=${ds.id} name=${cmd.descriptor.name} condition=${JSON.stringify(cmd.condition)} reason="${cmd.reason}"`,
          detail: {
            deferralId: ds.id,
            processName: cmd.descriptor.name,
            condition: cmd.condition,
            reason: cmd.reason,
            maxWaitTicks: cmd.maxWaitTicks,
            registeredAtTick: this.scheduler.tickCount,
          },
        });
        break;
      }

      case "cancel_defer": {
        const matches = [...this.deferrals.entries()].filter(
          ([, d]) => d.descriptor.name === cmd.name
        );
        if (matches.length === 0) {
          this.emitter?.emit({
            action: "os_command_rejected",
            status: "completed",
            message: `cancel_defer: no pending deferral with name "${cmd.name}"`,
          });
          break;
        }
        for (const [id] of matches) {
          this.deferrals.delete(id);
        }
        this.emitter?.emit({
          action: "os_defer",
          status: "completed",
          message: `cancel_defer: removed ${matches.length} deferral(s) for "${cmd.name}" reason="${cmd.reason}"`,
        });
        break;
      }

      case "kill": {
        // GAP 2: Capture counterfactual snapshot BEFORE the kill, then run simulation.
        const targetProc = this.table.get(cmd.pid);
        if (targetProc) {
          const tokPerTick = targetProc.tickCount > 0
            ? targetProc.tokensUsed / targetProc.tickCount
            : 0;
          const killAction: KernelAction = {
            kind: "kill",
            pid: cmd.pid,
            processMeta: {
              name: targetProc.name,
              tokensUsed: targetProc.tokensUsed,
              tickCount: targetProc.tickCount,
              tokensPerTick: tokPerTick,
              priority: targetProc.priority,
            },
            timestamp: Date.now(),
            tick: this.scheduler.tickCount,
          };
          // Capture ring-buffer snapshot of current process table
          this.counterfactualSim.captureSnapshot(
            this.scheduler.tickCount,
            killAction,
            this.table.getAll(),
          );
          // Simulate counterfactual (most recent snapshot, index = length - 1)
          const snapshotIndex = this.counterfactualSim.getSnapshots().length - 1;
          const cfResult = this.counterfactualSim.simulateCounterfactual(
            snapshotIndex,
            killAction,
            this.scheduler.tickCount,
          );
          if (cfResult) {
            // Log to causal attribution store and keep in-memory for metacog context
            try {
              this.memoryStore.learn(
                cfResult.reasoning,
                0.5,
                `counterfactual:kill:${cmd.pid}`,
                this.runId,
              );
            } catch {
              // max heuristics reached — log in-memory only
            }
            // Keep the last 10 counterfactual summaries for metacog context
            this.recentCounterfactualLogs.push(cfResult.reasoning);
            if (this.recentCounterfactualLogs.length > 10) {
              this.recentCounterfactualLogs.shift();
            }
            // GAP 1 (R6): Push KillEvalRecord for kill-threshold calibration (cap at 20)
            this.killEvalHistory.push({
              timestamp: Date.now(),
              pid: cmd.pid,
              tokenDelta: cfResult.estimatedTokenDelta,
              wasPrematurely: false,
            });
            if (this.killEvalHistory.length > 20) {
              this.killEvalHistory.shift();
            }
          }
        }
        this.supervisor.kill(cmd.pid, cmd.cascade, cmd.reason);
        this.executor.disposeThread(cmd.pid);
        this.router.disposeThread(cmd.pid);
        // Abort ephemeral thread if this PID is an in-flight ephemeral
        this.ephemeralThreads.get(cmd.pid)?.abort();
        this.ephemeralThreads.delete(cmd.pid);
        // Cancel inflight LLM call if still running (same as watchdog kill path)
        const killCb = this.turnKillCallbacks.get(cmd.pid);
        if (killCb) killCb();
        this.emitter?.emit({
          action: "os_process_kill",
          status: "completed",
          agentId: cmd.pid,
          agentName: targetProc?.name,
          message: `metacog_kill: ${cmd.reason}`,
          detail: {
            trigger: "metacog",
            reason: cmd.reason,
            cascade: cmd.cascade,
            targetName: targetProc?.name,
            targetTokensUsed: targetProc?.tokensUsed,
            targetTickCount: targetProc?.tickCount,
            targetPriority: targetProc?.priority,
          },
        });
        break;
      }

      case "spawn_system": {
        // Feature gate
        if (!this.config.systemProcess?.enabled) {
          this.emitter?.emit({
            action: "os_command_rejected",
            status: "failed",
            message: `metacog spawn_system rejected: systemProcess.enabled is false`,
          });
          break;
        }
        const sysProc = this.supervisor.spawn({
          type: "lifecycle",
          name: cmd.name,
          objective: cmd.objective,
          priority: cmd.priority ?? this.config.processes.defaultPriority,
          model: this.config.kernel.processModel,
          workingDir: this.workingDir,
          backend: { kind: "system", command: cmd.command, args: cmd.args, env: cmd.env },
        });
        this.supervisor.activate(sysProc.pid);
        this.router.startProcess(sysProc).catch(() => {
          this.supervisor.kill(sysProc.pid, false, "shell start failed");
        });
        this.emitter?.emit({
          action: "os_system_spawn",
          status: "completed",
          agentId: sysProc.pid,
          agentName: sysProc.name,
          message: `metacog_spawn_system command=${cmd.command}`,
          detail: {
            trigger: "metacog",
            command: cmd.command,
            args: cmd.args,
            objective: cmd.objective,
            priority: cmd.priority,
          },
        });
        break;
      }

      case "spawn_kernel": {
        // Feature gate
        if (!this.config.childKernel?.enabled) {
          this.emitter?.emit({
            action: "os_command_rejected",
            status: "failed",
            message: `metacog spawn_kernel rejected: childKernel.enabled is false`,
          });
          break;
        }
        // Depth guard
        if (this.config.kernel.parentKernelId) {
          this.emitter?.emit({
            action: "os_command_rejected",
            status: "failed",
            message: `metacog spawn_kernel rejected: this kernel is already a child (depth limit)`,
          });
          break;
        }
        const kernelProc = this.supervisor.spawn({
          type: "lifecycle",
          name: cmd.name,
          objective: `Sub-kernel: ${cmd.goal}`,
          priority: cmd.priority ?? this.config.processes.defaultPriority,
          model: this.config.kernel.processModel,
          workingDir: this.workingDir,
          backend: { kind: "kernel", goal: cmd.goal, maxTicks: cmd.maxTicks },
        });
        this.supervisor.activate(kernelProc.pid);
        this.router.startProcess(kernelProc).catch(() => {
          this.supervisor.kill(kernelProc.pid, false, "subkernel boot failed");
        });
        this.emitter?.emit({
          action: "os_subkernel_spawn",
          status: "completed",
          agentId: kernelProc.pid,
          agentName: kernelProc.name,
          message: `metacog_spawn_kernel goal=${cmd.goal}`,
          detail: {
            trigger: "metacog",
            goal: cmd.goal,
            maxTicks: cmd.maxTicks,
            priority: cmd.priority,
          },
        });
        break;
      }

      case "reprioritize":
        this.supervisor.setPriority(cmd.pid, cmd.priority);
        break;

      case "rewrite_dag":
        // GAP 3 (R6): Delegate to handleDagRewrite for topology mutation
        this.handleDagRewrite(cmd.mutation, cmd.reason);
        break;

      case "learn":
        this.memoryStore.learn(
          cmd.heuristic,
          cmd.confidence,
          cmd.context,
          this.runId,
          undefined,
          cmd.scope,
        );
        this.emitter?.emit({
          action: "os_heuristic_learned",
          status: "completed",
          message: `heuristic learned: "${cmd.heuristic.slice(0, 80)}" confidence=${cmd.confidence} scope=${cmd.scope ?? "local"}`,
          detail: {
            heuristic: cmd.heuristic,
            confidence: cmd.confidence,
            context: cmd.context,
            scope: cmd.scope ?? "local",
          },
        });
        break;

      case "define_blueprint": {
        const bp: TopologyBlueprint = {
          id: randomUUID(),
          ...cmd.blueprint,
          stats: { uses: 0, successes: 0, failures: 0, avgTokenEfficiency: 0, avgWallTimeMs: 0, lastUsedAt: "", alpha: 1, beta: 1, tagStats: {} },
          learnedAt: new Date().toISOString(),
        };
        this.memoryStore.addBlueprint(bp);
        this.emitter?.emit({
          action: "os_metacog",
          status: "completed",
          message: `define_blueprint name=${bp.name} id=${bp.id}`,
        });
        break;
      }

      case "fork": {
        const sourceProc = this.table.get(cmd.pid);
        if (!sourceProc) throw new Error(`Process not found: ${cmd.pid}`);
        const forked = this.supervisor.fork(
          cmd.pid,
          cmd.newObjective ?? sourceProc.objective,
        );
        if (cmd.newPriority !== undefined) {
          this.supervisor.setPriority(forked.pid, cmd.newPriority);
        }
        this.supervisor.activate(forked.pid);
        this.emitter?.emit({
          action: "os_process_spawn",
          status: "completed",
          agentId: forked.pid,
          agentName: forked.name,
          message: `metacog_fork source=${cmd.pid}`,
        });
        // DC-1: Wire TelemetryCollector.onFork()
        this.telemetryCollector.onFork(cmd.pid, forked.pid);
        break;
      }

      case "evolve_blueprint": {
        const source = this.memoryStore.getBlueprint(cmd.sourceBlueprintId);
        if (!source) throw new Error(`Blueprint not found: ${cmd.sourceBlueprintId}`);

        const newBlueprintId = `${cmd.sourceBlueprintId}-evolved-${Date.now()}`;
        // Deep clone the source blueprint
        const evolved: TopologyBlueprint = JSON.parse(JSON.stringify(source));
        evolved.id = newBlueprintId;
        evolved.evolvedFrom = cmd.sourceBlueprintId;
        evolved.learnedAt = new Date().toISOString();
        evolved.source = "metacog";

        // Apply mutations
        if (cmd.mutations.namePrefix) {
          evolved.name = `${cmd.mutations.namePrefix}${evolved.name}`;
        }
        if (cmd.mutations.gatingChange) {
          evolved.gatingStrategy = cmd.mutations.gatingChange as BlueprintGatingStrategy;
        }
        if (cmd.mutations.roleChanges) {
          for (const change of cmd.mutations.roleChanges) {
            if (change.action === "remove") {
              evolved.roles = evolved.roles.filter((r) => r.name !== change.roleName);
            } else if (change.action === "add") {
              evolved.roles.push({
                name: change.roleName,
                type: (change.type as OsProcessType) ?? "lifecycle",
                cardinality: "one",
                priorityOffset: change.priority ?? 0,
                objectiveTemplate: change.template ?? change.roleName,
                spawnTiming: "immediate",
              });
            } else if (change.action === "modify") {
              const role = evolved.roles.find((r) => r.name === change.roleName);
              if (role) {
                if (change.template) role.objectiveTemplate = change.template;
                if (change.type) role.type = change.type as OsProcessType;
                if (change.priority !== undefined) role.priorityOffset = change.priority;
              }
            }
          }
        }

        // Inherit Bayesian priors from parent, decayed toward uniform Beta(1,1)
        // newAlpha = 1 + (parentAlpha - 1) * 0.5  (blends toward 1)
        // newBeta  = 1 + (parentBeta  - 1) * 0.5  (blends toward 1)
        const parentAlpha = source.stats.alpha ?? 1;
        const parentBeta = source.stats.beta ?? 1;
        evolved.stats = {
          uses: 0,
          successes: 0,
          failures: 0,
          avgTokenEfficiency: 0,
          avgWallTimeMs: 0,
          lastUsedAt: "",
          alpha: 1.0 + (parentAlpha - 1.0) * 0.5,
          beta: 1.0 + (parentBeta - 1.0) * 0.5,
          tagStats: {},
        };

        this.memoryStore.addBlueprint(evolved);
        this.emitter?.emit({
          action: "os_metacog",
          status: "completed",
          message: `evolve_blueprint source=${cmd.sourceBlueprintId} new=${newBlueprintId}`,
        });
        break;
      }

      case "record_strategy": {
        // Gap 13: support both the legacy full-strategy form and the simplified
        // LLM-emittable form introduced in the JSON schema update.
        let strategyToSave: SchedulingStrategy;
        if ("strategy" in cmd) {
          // Legacy form: { kind: "record_strategy"; strategy: SchedulingStrategy }
          strategyToSave = cmd.strategy;
        } else {
          // Simplified schema form: { kind: "record_strategy"; strategyName, outcome, context? }
          strategyToSave = {
            id: `strategy-${Date.now()}`,
            description: cmd.strategyName,
            conditions: cmd.context ? [cmd.context] : [],
            adjustments: {},
            outcomes: {
              successes: cmd.outcome === "success" ? 1 : 0,
              failures: cmd.outcome === "failure" ? 1 : 0,
            },
            createdAt: Date.now(),
            lastUsed: Date.now(),
          };
        }
        this.memoryStore.saveSchedulingStrategy(strategyToSave);
        this.emitter?.emit({
          action: "os_metacog",
          status: "completed",
          message: `record_strategy id=${strategyToSave.id} conditions=${strategyToSave.conditions.join(",")}`,
        });
        break;
      }

      case "halt": {
        // Guard: metacog cannot halt with "achieved" while goal processes are still active.
        // Metacog is an observer — it has no tools and cannot produce deliverables itself.
        // It can only declare achievement when all goal work has naturally completed.
        const goalProcs = this.table
          .getAll()
          .filter(
            (p) =>
              p.state !== "dead" &&
              (p.type === "lifecycle" || p.type === "event"),
          );
        if (cmd.status === "achieved" && goalProcs.length > 0) {
          const names = goalProcs.map((p) => p.name).join(", ");
          this.emitter?.emit({
            action: "os_metacog",
            status: "completed",
            message: `halt_rejected: ${goalProcs.length} goal process(es) still active [${names}] — cannot declare achieved`,
          });
          break;
        }
        // Also reject "achieved" if deferrals are pending — more work is expected
        if (cmd.status === "achieved" && this.deferrals.size > 0) {
          this.emitter?.emit({
            action: "os_metacog",
            status: "completed",
            message: `halt_rejected: ${this.deferrals.size} deferral(s) still pending — cannot declare achieved`,
          });
          break;
        }
        this.halt(`metacog_${cmd.status}: ${cmd.summary}`);
        break;
      }

      case "noop":
        // Intentional no-op — metacog decided no action needed
        break;

      case "delegate_evaluation": {
        const evalScope = cmd.evaluationScope;
        const scopeKey = evalScope.slice(0, 20).replace(/\s+/g, '-');
        const subEvalProc = this.supervisor.spawn({
          type: "lifecycle",
          name: `sub-evaluator-${Date.now()}`,
          objective: `You are a specialized sub-evaluator. Your evaluation scope: ${evalScope}. Read the blackboard key 'metacog:system-state' to understand system state. Analyze the specified scope deeply. Write your findings and recommendations to blackboard key 'eval:${scopeKey}'. Then exit.`,
          priority: cmd.priority ?? 60,
          model: this.config.kernel.metacogModel,
          workingDir: this.workingDir,
        });
        this.supervisor.activate(subEvalProc.pid);
        this.emitter?.emit({
          action: 'os_process_spawn',
          status: 'completed',
          agentId: subEvalProc.pid,
          agentName: subEvalProc.name,
          message: `delegate_evaluation scope="${evalScope}"`,
        });
        break;
      }
    }
  }

  /**
   * GAP 3 (R6): Handle a rewrite_dag metacog command by applying a DagMutation.
   * Supports: collapse_parallel_to_sequential, fan_out, insert_checkpoint, merge_processes.
   * Each mutation kills/spawns processes and emits a 'dag:rewritten' signal.
   */
  private handleDagRewrite(mutation: DagMutation, reason: string): void {
    const pidsAffected: string[] = [];

    /** Snapshot selected blackboard keys into a plain object. */
    const snapshotBlackboard = (keys?: string[]): Record<string, unknown> => {
      const snapshot: Record<string, unknown> = {};
      if (!keys) return snapshot;
      for (const key of keys) {
        const entry = this.ipcBus.bbRead(key, 'kernel');
        if (entry) snapshot[key] = entry.value;
      }
      return snapshot;
    };

    switch (mutation.type) {
      case 'collapse_parallel_to_sequential': {
        const bbSnapshot = snapshotBlackboard(mutation.preserveBlackboardKeys);
        // Kill all parallel workers
        for (const pid of mutation.pids) {
          pidsAffected.push(pid);
          this.supervisor.kill(pid, false, 'dag_rewrite');
          this.executor.disposeThread(pid);
          this.router.disposeThread(pid);
          this.ephemeralThreads.get(pid)?.abort();
          this.ephemeralThreads.delete(pid);
        }
        // Spawn a single sequential replacement with preserved context
        const contextStr = Object.keys(bbSnapshot).length > 0
          ? `\n\nContext from collapsed processes:\n${JSON.stringify(bbSnapshot, null, 2)}`
          : '';
        const newProc = this.supervisor.spawn({
          type: 'lifecycle',
          name: 'sequential-replacement',
          objective: mutation.newObjective + contextStr,
          model: this.config.kernel.processModel,
          workingDir: this.workingDir,
        });
        this.supervisor.activate(newProc.pid);
        pidsAffected.push(newProc.pid);
        this.ipcBus.emitSignal('dag:rewritten', 'kernel', {
          mutation: 'collapse_parallel_to_sequential',
          killed: mutation.pids,
          spawned: newProc.pid,
        });
        break;
      }

      case 'fan_out': {
        const bbSnapshot = snapshotBlackboard(mutation.preserveBlackboardKeys);
        // Kill source process
        pidsAffected.push(mutation.sourcePid);
        this.supervisor.kill(mutation.sourcePid, false, 'dag_rewrite');
        this.executor.disposeThread(mutation.sourcePid);
        this.router.disposeThread(mutation.sourcePid);
        this.ephemeralThreads.get(mutation.sourcePid)?.abort();
        this.ephemeralThreads.delete(mutation.sourcePid);
        // Spawn N workers with shared context
        const contextStr = Object.keys(bbSnapshot).length > 0
          ? `\n\nShared context:\n${JSON.stringify(bbSnapshot, null, 2)}`
          : '';
        const spawnedPids: string[] = [];
        for (const objective of mutation.workerObjectives) {
          const workerProc = this.supervisor.spawn({
            type: 'lifecycle',
            name: 'fan-out-worker',
            objective: objective + contextStr,
            model: this.config.kernel.processModel,
            workingDir: this.workingDir,
          });
          this.supervisor.activate(workerProc.pid);
          spawnedPids.push(workerProc.pid);
          pidsAffected.push(workerProc.pid);
        }
        this.ipcBus.emitSignal('dag:rewritten', 'kernel', {
          mutation: 'fan_out',
          killed: [mutation.sourcePid],
          spawned: spawnedPids,
        });
        break;
      }

      case 'insert_checkpoint': {
        // Spawn checkpoint process
        const checkpointProc = this.supervisor.spawn({
          type: 'lifecycle',
          name: 'checkpoint-process',
          objective: mutation.checkpointObjective,
          model: this.config.kernel.processModel,
          workingDir: this.workingDir,
        });
        this.supervisor.activate(checkpointProc.pid);
        pidsAffected.push(checkpointProc.pid);
        // Wire DAG edges: afterPid → checkpoint → beforePid
        this.dagEngine.applyPatch({
          addEdges: [
            { from: mutation.afterPid, to: checkpointProc.pid, relation: 'dependency', label: 'dag_rewrite' },
            { from: checkpointProc.pid, to: mutation.beforePid, relation: 'dependency', label: 'dag_rewrite' },
          ],
        });
        this.ipcBus.emitSignal('dag:rewritten', 'kernel', {
          mutation: 'insert_checkpoint',
          checkpointPid: checkpointProc.pid,
          afterPid: mutation.afterPid,
          beforePid: mutation.beforePid,
        });
        break;
      }

      case 'merge_processes': {
        const bbSnapshot = snapshotBlackboard(mutation.preserveBlackboardKeys);
        // Kill all processes to be merged
        for (const pid of mutation.pids) {
          pidsAffected.push(pid);
          this.supervisor.kill(pid, false, 'dag_rewrite');
          this.executor.disposeThread(pid);
          this.router.disposeThread(pid);
          this.ephemeralThreads.get(pid)?.abort();
          this.ephemeralThreads.delete(pid);
        }
        // Spawn one unified replacement with preserved context
        const contextStr = Object.keys(bbSnapshot).length > 0
          ? `\n\nContext from merged processes:\n${JSON.stringify(bbSnapshot, null, 2)}`
          : '';
        const mergedProc = this.supervisor.spawn({
          type: 'lifecycle',
          name: 'merged-process',
          objective: mutation.mergedObjective + contextStr,
          model: this.config.kernel.processModel,
          workingDir: this.workingDir,
        });
        this.supervisor.activate(mergedProc.pid);
        pidsAffected.push(mergedProc.pid);
        this.ipcBus.emitSignal('dag:rewritten', 'kernel', {
          mutation: 'merge_processes',
          killed: mutation.pids,
          spawned: mergedProc.pid,
        });
        break;
      }
    }

    // Record in dag rewrite history for observability
    this.dagRewriteHistory.push({
      timestamp: Date.now(),
      mutationType: mutation.type,
      reason,
      pidsAffected,
    });

    this.emitter?.emit({
      action: 'os_metacog',
      status: 'completed',
      message: `dag_rewrite type=${mutation.type} reason="${reason}" pidsAffected=${pidsAffected.length}`,
    });
  }

  /**
   * Process commands injected via os-inject.json (from connect CLI or MCP tools).
   * Reads the file, executes all commands, then deletes it.
   */
  private processInjectedCommands(): void {
    const injectPath = path.join(this.workingDir, "os-inject.json");
    try {
      const content = fs.readFileSync(injectPath, "utf-8");
      fs.unlinkSync(injectPath);

      const parsed = JSON.parse(content);
      if (!parsed || !Array.isArray(parsed.commands)) return;

      for (const cmd of parsed.commands) {
        try {
          this.executeMetacogCommand(cmd as MetacogCommand);
        } catch {
          // Individual command failure shouldn't stop others
        }
      }

      this.emitter?.emit({
        action: "os_metacog",
        status: "completed",
        message: `injected_commands=${parsed.commands.length}`,
      });
    } catch {
      // No inject file — normal case
    }
  }

  /**
   * Emit a synthetic child:done signal when a child process exits or fails.
   * This ensures the parent is woken structurally, not dependent on LLM compliance.
   * exitCode and exitReason are included so the parent can distinguish success from failure.
   */
  private emitChildDoneSignal(
    childPid: string,
    childName: string,
    parentPid: string,
    exitCode?: number,
    exitReason?: string,
  ): void {
    const signalName = "child:done";
    this.ipcBus.emitSignal(signalName, childPid, {
      name: childName,
      pid: childPid,
      parentPid,
      exitCode,
      exitReason,
    });
    this.tickSignals.push(signalName);
  }

  /** Collect signal names emitted during this tick. */
  private collectRecentSignalNames(): string[] {
    return [...this.tickSignals];
  }

  /** Extract goal tags from the current goal string. */
  private extractGoalTags(): string[] {
    return extractGoalTagsFromGoal(this.goal);
  }

  /**
   * At boot, use an LLM to classify which stored strategies are relevant to the current goal.
   * This replaces the keyword-based deriveCurrentConditions() which could only emit 3 hardcoded
   * tags that never matched the rich natural-language conditions metacog writes when recording
   * strategies. Runs once, result cached for the run.
   */
  async matchStrategiesAtBoot(): Promise<void> {
    const strategies = this.memoryStore.getSchedulingStrategies();
    if (strategies.length === 0) {
      this.bootMatchedStrategyIds = new Set();
      return;
    }

    const strategySummaries = strategies.map((s, i) =>
      `${i + 1}. [${s.id}] "${s.description}" — conditions: ${s.conditions.join(", ")} — success rate: ${s.outcomes.successes}/${s.outcomes.successes + s.outcomes.failures}`
    ).join("\n");

    const prompt = `You are a strategy matcher for a cognitive operating system. Given a goal and a list of learned scheduling strategies from prior runs, return the IDs of strategies that are relevant to this goal.

GOAL: ${this.goal}

STRATEGIES:
${strategySummaries}

Return ONLY a JSON array of strategy ID strings that are relevant. If none match, return [].
Example: ["strategy-123", "strategy-456"]`;

    try {
      const thread = this.client.startThread({
        model: this.config.ephemeral.defaultModel,
      });
      const result = await thread.run(prompt);
      const parsed = JSON.parse(result.finalResponse) as string[];
      this.bootMatchedStrategyIds = new Set(
        Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : []
      );

      this.emitter?.emit({
        action: "os_strategy_match",
        status: "completed",
        message: `LLM matched ${this.bootMatchedStrategyIds.size}/${strategies.length} strategies to goal`,
      });
    } catch {
      // Fallback: no matched strategies (silent failure, same as before)
      this.bootMatchedStrategyIds = new Set();
    }
  }

  /**
   * Get strategies applicable to the current run, using boot-time LLM classification.
   * Returns empty if boot matching hasn't run yet — callers must go through run().
   */
  private getApplicableStrategies(): SchedulingStrategy[] {
    if (!this.bootMatchedStrategyIds || this.bootMatchedStrategyIds.size === 0) {
      return [];
    }
    const all = this.memoryStore.getSchedulingStrategies();
    return all.filter(s => this.bootMatchedStrategyIds!.has(s.id));
  }

  /**
   * GAP 1 (R6): Compute an adjustment to kill aggressiveness based on recent counterfactual
   * kill evaluations.
   * - If avgTokenSavedPerKill > 500: kills are saving tokens → be more aggressive (-0.1)
   * - If avgTokenSavedPerKill < 0: kills were net negative → be more conservative (+0.15)
   * - Otherwise: no adjustment (0.0)
   */
  private computeKillThresholdAdjustment(): number {
    if (this.killEvalHistory.length === 0) return 0.0;
    const avgTokenSavedPerKill =
      this.killEvalHistory.reduce((sum, r) => sum + r.tokenDelta, 0) /
      this.killEvalHistory.length;
    if (avgTokenSavedPerKill > 500) return -0.1;
    if (avgTokenSavedPerKill < 0) return +0.15;
    return 0.0;
  }

  private shouldConsultMetacog(): boolean {
    return (
      this.pendingTriggers.length > 0 ||
      this.scheduler.shouldConsultMetacog(this.config.scheduler.metacogCadence)
    );
  }

  private recordProgressSnapshot(): void {
    // Dedup: only one snapshot per tick — two call sites (watchdog + main metacog)
    // can both fire in the same tick, wasting the awareness history window on duplicates.
    if (this.scheduler.tickCount <= this.lastProgressTick) return;
    this.lastProgressTick = this.scheduler.tickCount;

    const allProcs = this.table.getAll();
    const snap: ProgressSnapshot = {
      tick: this.scheduler.tickCount,
      activeProcessCount: allProcs.filter(p => p.state === 'running').length,
      totalTokensUsed: allProcs.reduce((s, p) => s + p.tokensUsed, 0),
      blackboardKeyCount: this.ipcBus.summary().blackboardKeyCount,
      heuristicsLearned: this.memoryStore.getAll().length,
      interventionCount: this.pendingInterventions.length,
    };
    this.progressTimeline.push(snap);
    if (this.progressTimeline.length > this.config.awareness.historyWindow) {
      this.progressTimeline = this.progressTimeline.slice(-this.config.awareness.historyWindow);
    }
  }

  private shouldConsultAwareness(): boolean {
    if (!this.config.awareness.enabled || !this.awarenessDaemon) return false;
    // Always run awareness on halt — the decision to stop is the most consequential
    // metacog decision and should never escape second-order evaluation.
    if (this.halted) return true;
    return this.metacogEvalCount > 0 && this.metacogEvalCount % this.config.awareness.cadence === 0;
  }

  private buildAwarenessContext(): AwarenessContext {
    // Build heuristic inventory with real application counts from log
    const heuristicInventory = this.memoryStore.getAll().map(h => {
      const entries = this.heuristicApplicationLog.filter(e => e.heuristicId === h.id);
      let positiveOutcomes = 0;
      let negativeOutcomes = 0;
      let neutralOutcomes = 0;
      let lastAppliedTick = 0;

      for (const entry of entries) {
        if (entry.appliedAtTick > lastAppliedTick) lastAppliedTick = entry.appliedAtTick;
        if (entry.interventionId) {
          const intervention = this.pendingInterventions.find(iv => iv.id === entry.interventionId);
          if (intervention?.outcome === 'improved') positiveOutcomes++;
          else if (intervention?.outcome === 'degraded') negativeOutcomes++;
          else if (intervention?.outcome === 'neutral') neutralOutcomes++;
        }
      }

      return {
        id: h.id,
        heuristic: h.heuristic,
        confidence: h.confidence,
        timesApplied: entries.length,
        positiveOutcomes,
        negativeOutcomes,
        neutralOutcomes,
        lastAppliedTick,
        validatedAgainstCode: false,
      };
    });

    return {
      metacogHistory: this.metacogHistory.slice(-this.config.awareness.historyWindow),
      interventionOutcomes: this.pendingInterventions.filter(iv => iv.outcome !== undefined).slice(-20),
      heuristicInventory,
      progressTimeline: this.progressTimeline.slice(-this.config.awareness.historyWindow),
      priorNotes: this.awarenessDaemon?.getLastNotes() ?? [],
      ticksSinceLastEval: this.scheduler.tickCount - this.lastAwarenessTick,
      haltPending: this.halted || undefined,
      haltReason: this.haltReason || undefined,
    };
  }

  private buildMetacogContext(): MetacogContext {
    const ticksSinceLastEval =
      this.scheduler.tickCount - this.lastMetacogTick;

    // Determine the primary trigger (first pending, if any)
    const trigger =
      this.pendingTriggers.length > 0
        ? this.pendingTriggers[0]
        : undefined;

    // Collect process events since last eval
    const processEvents = this.table.clearEvents();

    // IPC summary from bus (typed as OsIpcSummary)
    const ipcActivity: OsIpcSummary = this.ipcBus.summary();

    // DAG delta since last metacog eval
    const lastEvalTime =
      this.lastMetacogTick > 0
        ? new Date(
            this.startTime +
              this.lastMetacogTick * this.config.kernel.tickIntervalMs,
          ).toISOString()
        : new Date(this.startTime).toISOString();
    const dagDelta: OsDagDelta = this.dagEngine.delta(lastEvalTime);

    // Progress metrics
    const allProcesses = this.table.getAll();
    const totalTokensUsed = allProcesses.reduce(
      (sum, p) => sum + p.tokensUsed,
      0,
    );
    const activeProcessCount = allProcesses.filter(
      (p) => p.state === "running",
    ).length;
    const stalledProcessCount = allProcesses.filter(
      (p) => p.state === "sleeping" || p.state === "idle",
    ).length;

    const progressMetrics: OsProgressMetrics = {
      activeProcessCount,
      stalledProcessCount,
      totalTokensUsed,
      tokenBudgetRemaining: this.config.kernel.tokenBudget - totalTokensUsed,
      wallTimeElapsedMs: Date.now() - this.startTime,
      tickCount: this.scheduler.tickCount,
    };

    // Query relevant heuristics from memory store
    const relevantHeuristics = this.memoryStore.query(this.goal);

    const processCountForComplexity = allProcesses.filter(p => p.state !== 'dead').length;
    const stalledRatioForComplexity = processCountForComplexity > 0
      ? stalledProcessCount / processCountForComplexity
      : 0;
    const systemComplexity = processCountForComplexity * (1 + stalledRatioForComplexity);

    // Gather causal insights (heuristics whose context starts with 'causal:')
    const causalInsights = this.memoryStore.getAll()
      .filter(h => h.context?.startsWith('causal:') && !h.supersededBy)
      .slice(0, 20);

    // GAP 1 (R6): Kill threshold calibration state for metacog
    const avgTokenSavedPerKill = this.killEvalHistory.length > 0
      ? this.killEvalHistory.reduce((sum, r) => sum + r.tokenDelta, 0) / this.killEvalHistory.length
      : undefined;
    const killThresholdAdjustment = this.computeKillThresholdAdjustment();

    const ctx: MetacogContext = {
      ticksSinceLastEval,
      trigger,
      processEvents,
      ipcActivity,
      dagDelta,
      progressMetrics,
      relevantHeuristics,
      interventionHistory: this.pendingInterventions
        .filter(iv => iv.outcome !== undefined)
        .slice(-10),
      systemComplexity,
      causalInsights: causalInsights.length > 0 ? causalInsights : undefined,
      // GAP 2: surface recent counterfactual simulation results for kill decisions
      counterfactualInsights: this.recentCounterfactualLogs.length > 0
        ? [...this.recentCounterfactualLogs]
        : undefined,
      // GAP 1 (R6): kill calibration state so metacog can see and act on threshold adjustment
      avgTokenSavedPerKill,
      killThresholdAdjustment: killThresholdAdjustment !== 0.0 ? killThresholdAdjustment : undefined,
      ...(this.lastPerfRecommendations.length > 0
        ? { perfRecommendations: this.lastPerfRecommendations }
        : {}),
      awarenessNotes: this.pendingAwarenessNotes.length > 0 ? [...this.pendingAwarenessNotes] : undefined,
      flaggedHeuristics: (() => {
        const entry = this.ipcBus.bbRead("awareness:heuristic-flags", "kernel");
        if (entry && Array.isArray(entry.value) && entry.value.length > 0) {
          return entry.value as Array<{ id: string; reason: string }>;
        }
        return undefined;
      })(),
      metacogFocus: this.metacogFocus ?? undefined,
      oscillationWarnings: this.pendingOscillationWarnings.length > 0 ? [...this.pendingOscillationWarnings] : undefined,
      detectedBlindSpots: this.pendingBlindSpots.length > 0 ? [...this.pendingBlindSpots] : undefined,
      deferrals: this.deferrals.size > 0
        ? Array.from(this.deferrals.values()).map(ds => ({
            id: ds.id,
            name: ds.descriptor.name ?? "unnamed",
            condition: ds.condition,
            waitedTicks: this.scheduler.tickCount - ds.registeredByTick,
            reason: ds.reason,
          }))
        : undefined,
      // Observation results from observer processes (blackboard keys starting with observation:)
      observationResults: (() => {
        const results: Array<{ key: string; value: unknown }> = [];
        for (const entry of this.ipcBus.bbReadAll()) {
          if (entry.key.startsWith("observation:")) {
            results.push({ key: entry.key, value: entry.value });
          }
        }
        return results.length > 0 ? results : undefined;
      })(),
      // Blackboard value summaries (first ~200 chars of each value)
      blackboardValueSummaries: (() => {
        const summaries: Record<string, string> = {};
        for (const entry of this.ipcBus.bbReadAll()) {
          const val = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
          summaries[entry.key] = val.length > 200 ? val.slice(0, 200) + "..." : val;
        }
        return Object.keys(summaries).length > 0 ? summaries : undefined;
      })() as Record<string, string> | undefined,
      // Completion criteria for processes that exited code 0 this tick
      recentExitCriteria: (() => {
        const criteria = processEvents
          .filter(e => e.kind === "killed" || e.kind === "state_changed")
          .map(e => this.table.get(e.pid))
          .filter((p): p is OsProcess => !!(p && p.state === "dead" && p.exitCode === 0 && p.completionCriteria?.length))
          .map(p => ({
            pid: p.pid,
            name: p.name,
            criteria: p.completionCriteria!,
            bbKeysWritten: p.blackboardKeysWritten ?? [],
          }));
        return criteria.length > 0 ? criteria : undefined;
      })(),
    };

    // Clear awareness notes after consumption (consume-once semantics)
    if (this.pendingAwarenessNotes.length > 0) {
      this.pendingAwarenessNotes = [];
    }
    // Consume-once: clear metacog focus and pending warnings
    this.metacogFocus = null;
    this.pendingOscillationWarnings = [];
    this.pendingBlindSpots = [];

    return ctx;
  }

  shouldHalt(): boolean {
    if (this.halted) {
      return true;
    }

    // Wall time exceeded (0 = no limit)
    if (
      this.config.kernel.wallTimeLimitMs > 0 &&
      this.startTime > 0 &&
      Date.now() - this.startTime > this.config.kernel.wallTimeLimitMs
    ) {
      this.haltReason = "wall_time_exceeded";
      return true;
    }

    // Token budget exceeded
    const allProcesses = this.table.getAll();
    const totalTokensUsed = allProcesses.reduce(
      (sum, p) => sum + p.tokensUsed,
      0,
    );
    if (totalTokensUsed >= this.config.kernel.tokenBudget) {
      this.haltReason = "token_budget_exceeded";
      return true;
    }

    // Never halt while LLM calls or ephemerals are still in-flight —
    // their results may spawn new processes or write goal-critical data.
    if (this.inflight.size > 0 || this.activeEphemeralCount > 0) {
      return false;
    }

    // All processes are dead and no restart policies apply
    const livingProcesses = allProcesses.filter((p) => p.state !== "dead");
    if (livingProcesses.length === 0 && allProcesses.length > 0) {
      // Check if any dead processes have restart policies that could fire
      const restartable = allProcesses.filter(
        (p) =>
          p.state === "dead" &&
          (p.restartPolicy === "always" ||
            (p.restartPolicy === "on-failure" && p.exitCode !== 0)),
      );
      if (restartable.length === 0) {
        this.haltReason = "all_processes_dead";
        return true;
      }
    }

    // Don't halt if deferrals are pending — more goal work is expected
    if (this.deferrals.size > 0) {
      return false;
    }

    // All goal work is done: no lifecycle/event processes alive, only daemons remain.
    // Use a grace period to allow metacog/awareness to detect premature orchestrator
    // exit and potentially respawn workers before we commit to halting.
    if (livingProcesses.length > 0) {
      const goalProcesses = livingProcesses.filter(
        (p) => p.type === "lifecycle" || p.type === "event",
      );
      if (goalProcesses.length === 0) {
        const gracePeriodMs = this.config.kernel.goalCompleteGracePeriodMs ?? 30_000;

        if (this.goalWorkDoneAt === 0) {
          // First time noticing only daemons remain — start grace period
          this.goalWorkDoneAt = Date.now();
          this.emitter?.emit({
            action: "os_halt_grace_period",
            status: "completed",
            message: `only daemons remain — grace period started (${gracePeriodMs}ms). Metacog can respawn workers to continue goal work.`,
          });
          return false;
        }

        if (Date.now() - this.goalWorkDoneAt < gracePeriodMs) {
          return false; // still in grace period
        }

        this.haltReason = "goal_work_complete";
        return true;
      } else {
        // Lifecycle/event processes exist again (metacog respawned something) — reset grace period
        if (this.goalWorkDoneAt > 0) {
          this.goalWorkDoneAt = 0;
          this.emitter?.emit({
            action: "os_halt_grace_period",
            status: "completed",
            message: `grace period canceled — lifecycle processes respawned, goal work continuing`,
          });
        }
      }
    }

    return false;
  }

  halt(reason: string): void {
    this.haltReason = reason;
    this.emitter?.emit({
      action: "os_halt",
      status: "completed",
      message: reason,
    });
    if (this.haltResolve) {
      // Event loop is running — haltResolve sets this.halted, clears timers, resolves
      this.haltResolve();
    } else {
      // No event loop (e.g. unit tests) — set halted directly
      this.halted = true;
    }
  }

  // ─── Deferred Spawns ────────────────────────────────────────────

  /**
   * Evaluate a deferral condition against current system state.
   */
  private evaluateDeferCondition(cond: DeferCondition): boolean {
    switch (cond.type) {
      case "blackboard_key_exists":
        return this.ipcBus.bbRead(cond.key) !== undefined;
      case "blackboard_key_match": {
        const entry = this.ipcBus.bbRead(cond.key);
        return entry !== undefined && entry.value === cond.value;
      }
      case "blackboard_value_contains": {
        const entry = this.ipcBus.bbRead(cond.key);
        if (!entry) return false;
        const val = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
        return val.includes(cond.substring);
      }
      case "process_dead": {
        const proc = this.table.get(cond.pid);
        return !proc || proc.state === "dead";
      }
      case "process_dead_by_name": {
        const procs = this.table.getAll().filter(p => p.name === cond.name);
        return procs.length > 0 && procs.every(p => p.state === "dead");
      }
      case "all_of":
        return cond.conditions.every(c => this.evaluateDeferCondition(c));
      case "any_of":
        return cond.conditions.some(c => this.evaluateDeferCondition(c));
    }
  }

  /**
   * Check all deferral conditions and spawn processes whose conditions are met.
   * Called once per tick (step 2c).
   */
  private processDeferrals(): void {
    if (this.deferrals.size === 0) return;

    const tickNum = this.scheduler.tickCount;
    const triggered: string[] = [];

    for (const [id, ds] of this.deferrals) {
      // Check TTL expiry — spawn anyway instead of silently dropping work.
      // The metacog can kill the process if it's no longer needed.
      const waited = tickNum - ds.registeredByTick;
      const wallWaitMs = ds.registeredAtMs ? Date.now() - ds.registeredAtMs : 0;
      const tickExpired = ds.maxWaitTicks && waited > ds.maxWaitTicks;
      const wallExpired = ds.maxWaitMs && wallWaitMs > ds.maxWaitMs;
      if (tickExpired || wallExpired) {
        const proc = this.supervisor.spawn({
          ...ds.descriptor,
          // Always use config default model — LLM may output wrong provider model names
          model: this.config.kernel.processModel,
          workingDir: ds.descriptor.workingDir ?? this.workingDir,
        });
        this.supervisor.activate(proc.pid);
        triggered.push(id);
        this.emitter?.emit({
          action: "os_defer",
          status: "completed",
          agentId: proc.pid,
          agentName: proc.name,
          message: `expired_but_spawned id=${id} name=${ds.descriptor.name} — condition not met after ${waited} ticks (${Math.round(wallWaitMs / 1000)}s wall), spawning anyway`,
        });
        continue;
      }

      if (this.evaluateDeferCondition(ds.condition)) {
        const proc = this.supervisor.spawn({
          ...ds.descriptor,
          // Always use config default model — LLM may output wrong provider model names
          model: this.config.kernel.processModel,
          workingDir: ds.descriptor.workingDir ?? this.workingDir,
        });
        this.supervisor.activate(proc.pid);
        triggered.push(id);

        this.emitter?.emit({
          action: "os_defer",
          status: "completed",
          agentId: proc.pid,
          agentName: proc.name,
          message: `triggered id=${id} reason="${ds.reason}" waited=${tickNum - ds.registeredByTick} ticks`,
        });
      }
    }

    for (const id of triggered) {
      this.deferrals.delete(id);
    }
  }

  // ─── Checkpoint-Restore (GAP-7) ──────────────────────────────────

  /**
   * Save checkpoints for all non-dead, non-spawned processes.
   * Called at the start of shutdown() to persist in-flight state.
   */
  private saveAllCheckpoints(): void {
    const processes = this.table.getAll().filter(
      (p) => p.state !== "dead" && p.state !== "spawned",
    );

    for (const proc of processes) {
      const summary = proc.checkpoint?.conversationSummary ?? `shutdown checkpoint at tick ${this.scheduler.tickCount}`;
      const objectives = proc.checkpoint?.pendingObjectives ?? [proc.objective];

      const cp: import("./types.js").OsProcessCheckpoint = {
        pid: proc.pid,
        capturedAt: new Date().toISOString(),
        conversationSummary: summary,
        pendingObjectives: objectives,
        artifacts: proc.checkpoint?.artifacts ?? {},
        // Cross-run persistence metadata
        runId: this.runId,
        tickCount: proc.tickCount,
        tokensUsed: proc.tokensUsed,
        processName: proc.name,
        processType: proc.type,
        processObjective: proc.objective,
        processPriority: proc.priority,
        processModel: proc.model,
        processWorkingDir: proc.workingDir,
        parentPid: proc.parentPid,
        backend: proc.backend,
        executorState: this.router.captureCheckpointState(proc) ?? undefined,
      };

      this.memoryStore.saveCheckpoint(cp);
    }

    this.emitter?.emit({
      action: "os_checkpoint",
      status: "completed",
      message: `saved ${processes.length} shutdown checkpoints for run ${this.runId}`,
    });
  }

  /**
   * Restore processes from a prior run's checkpoints.
   * Skips daemons (spawned fresh every boot) and non-LLM backends (can't resume).
   */
  private restoreFromPriorRun(runId: string): void {
    const checkpoints = this.memoryStore.loadCheckpoints(runId);
    if (checkpoints.length === 0) return;

    let restored = 0;
    for (const cp of checkpoints) {
      // Skip daemons — they are spawned fresh every boot
      if (cp.processType === "daemon") continue;

      // Skip non-LLM backends — shell processes can't resume, sub-kernels re-boot from scratch
      const backendKind = cp.backend?.kind ?? "llm";
      if (backendKind !== "llm") continue;

      try {
        const proc = this.supervisor.restore(cp);
        this.supervisor.activate(proc.pid);
        restored++;

        this.emitter?.emit({
          action: "os_restore",
          status: "completed",
          agentId: proc.pid,
          message: `restored from ${runId}:${cp.pid} (${cp.processName ?? "unknown"})`,
        });
      } catch (err) {
        this.emitter?.emit({
          action: "os_restore",
          status: "failed",
          message: `failed to restore ${cp.pid}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    this.emitter?.emit({
      action: "os_restore",
      status: "completed",
      message: `restored ${restored}/${checkpoints.length} processes from run ${runId}`,
    });
  }

  shutdown(): void {
    // Save all in-flight process checkpoints before disposing threads
    this.saveAllCheckpoints();

    // Dispose all threads (both legacy executor and router)
    for (const proc of this.table.getAll()) {
      this.executor.disposeThread(proc.pid);
      this.router.disposeThread(proc.pid);
    }
    // Abort all in-flight ephemeral threads
    for (const thread of this.ephemeralThreads.values()) {
      thread.abort();
    }
    this.ephemeralThreads.clear();

    // Record blueprint outcome if one was selected
    if (this.selectedBlueprintInfo) {
      const allProcesses = this.table.getAll();
      const totalTokens = allProcesses.reduce((sum, p) => sum + p.tokensUsed, 0);
      const success = this.haltReason === "goal_work_complete" ||
        this.haltReason?.startsWith("metacog_achieved");

      // Compute fractional completion score
      const lifecycleProcesses = allProcesses.filter((p) => p.type === "lifecycle");
      const completedLifecycle = lifecycleProcesses.filter(
        (p) => p.state === "dead" && p.exitCode === 0,
      ).length;
      const totalLifecycle = Math.max(lifecycleProcesses.length, 1);

      // Check if a final result was produced
      const hasFinalResult = this.ipcBus.bbRead("final_result", "kernel") !== undefined;

      // completionScore: 80% from process completion ratio + 20% from final result
      const completionScore = (completedLifecycle / totalLifecycle) * 0.8 + (hasFinalResult ? 0.2 : 0);

      // Extract goal tags
      const goalTags = this.extractGoalTags();

      this.memoryStore.recordBlueprintOutcome({
        blueprintId: this.selectedBlueprintInfo.id,
        runId: this.runId,
        success,
        completionScore,
        goalTags,
        completedProcessCount: completedLifecycle,
        totalTokens,
        wallTimeMs: Date.now() - this.startTime,
        processCount: allProcesses.length,
        haltReason: this.haltReason,
      });

      // GAP 3: Record blueprint task history for decomposition learning.
      // Persists (blueprint, taskClass, success, cost) tuples for recommendBlueprint().
      const taskClass = this.extractGoalTags();
      const bpTaskRecord: BlueprintTaskRecord = {
        blueprintId: this.selectedBlueprintInfo.id,
        taskClass,
        success,
        tokensUsed: totalTokens,
        wallTimeMs: Date.now() - this.startTime,
        timestamp: Date.now(),
      };
      this.memoryStore.recordBlueprintTask(bpTaskRecord);
    }

    // Record scheduling strategy outcome for cross-run learning
    // FL-4: Use haltReason to determine actual success rather than anySuccess
    // (anySuccess was always true once any process exited, making it meaningless)
    if (this.activeStrategyId) {
      const strategySuccess =
        this.haltReason === "goal_work_complete" ||
        this.haltReason?.startsWith("metacog_achieved");
      this.memoryStore.recordStrategyOutcome(this.activeStrategyId, strategySuccess);
    }

    // Persist kill calibration for cross-run learning
    this.memoryStore.setKillCalibration({
      killThresholdAdjustment: this.killThresholdAdjustment,
      killEvalHistory: this.killEvalHistory,
      savedAt: Date.now(),
    });

    // Retrospective heuristic validation: reinforce heuristics that were applied during
    // interventions that subsequently improved the system
    {
      const improvedInterventionIds = new Set(
        this.pendingInterventions
          .filter(i => i.outcome === 'improved')
          .map(i => i.id)
      );
      const reinforcedIds = [...new Set(
        this.heuristicApplicationLog
          .filter(e => e.interventionId && improvedInterventionIds.has(e.interventionId))
          .map(e => e.heuristicId)
      )];
      if (reinforcedIds.length > 0) {
        const count = this.memoryStore.reinforceBatch(reinforcedIds);
        this.emitter?.emit({ type: 'os_heuristics_reinforced', count, ids: reinforcedIds } as any);
      }

      // Negative reinforcement: penalize heuristics cited during degraded outcomes
      const degradedInterventionIds = new Set(
        this.pendingInterventions
          .filter(i => i.outcome === 'degraded')
          .map(i => i.id)
      );
      const penalizedIds = [...new Set(
        this.heuristicApplicationLog
          .filter(e => e.interventionId && degradedInterventionIds.has(e.interventionId))
          .map(e => e.heuristicId)
      )];
      // Don't penalize a heuristic that was also reinforced — net positive wins
      const netPenalizedIds = penalizedIds.filter(id => !reinforcedIds.includes(id));
      if (netPenalizedIds.length > 0) {
        const count = this.memoryStore.penalizeBatch(netPenalizedIds);
        this.emitter?.emit({ type: 'os_heuristics_penalized', count, ids: netPenalizedIds } as any);
      }
    }

    // FL-2: Decay heuristics before saving to prevent unbounded accumulation
    this.memoryStore.decay();
    // Prune heuristics that decayed below threshold — prevents zombie entries from
    // accumulating indefinitely and counting toward maxHeuristics
    this.memoryStore.prune();

    // Save heuristics and blueprints
    this.memoryStore.saveHeuristics();
    this.memoryStore.saveBlueprints();

    // GAP 2: Auto-promote high-confidence heuristics into scheduling strategies
    this.memoryStore.shutdown();

    // Mark consolidation timestamp so next boot knows whether consolidator is needed
    this.memoryStore.markConsolidated();

    // GAP 2 (R6): Prune underperforming blueprints (>= 5 uses, fitness < 20%)
    const pruned = this.memoryStore.pruneBlueprints(5, 0.2);
    if (pruned > 0) {
      this.emitter?.emit({
        action: 'os_metacog',
        status: 'completed',
        message: `Pruned ${pruned} underperforming blueprints`,
      });
    }

    // Save DAG snapshot
    const processStates: Record<string, string> = {};
    for (const proc of this.table.getAll()) {
      processStates[proc.pid] = proc.state;
    }
    const dagSnapshot = this.dagEngine.snapshot(
      this.runId,
      "shutdown",
      processStates as Record<string, import("./types.js").OsProcessState>,
    );
    this.memoryStore.saveSnapshot(dagSnapshot);
  }

  /**
   * Build a rich objective for the memory-consolidator daemon.
   * Injects the full heuristic inventory so the LLM can reason about
   * duplicates, contradictions, gaps, and patterns worth extracting.
   */
  private buildConsolidatorObjective(): string {
    const allHeuristics = this.memoryStore.getAll();
    const lines: string[] = [
      "You are the memory consolidator — responsible for the quality and coherence",
      "of this system's learned knowledge. The heuristics below are what the cognitive",
      "kernel has learned across runs. Your job is to review them and improve the store.",
      "",
      "## Current Heuristics",
    ];

    if (allHeuristics.length === 0) {
      lines.push("(none yet — the system is fresh)");
    } else {
      for (const h of allHeuristics) {
        const scopeLabel = h.scope ? ` scope=${h.scope}` : "";
        const superseded = h.supersededBy ? ` SUPERSEDED by ${h.supersededBy}` : "";
        lines.push(
          `- [id=${h.id}, conf=${h.confidence.toFixed(2)}, reinforced=${h.reinforcementCount}x${scopeLabel}${superseded}] ${h.heuristic}`,
          `  context: ${h.context}`,
        );
      }
    }

    lines.push(
      "",
      "## Your Tasks",
      "",
      "Review the heuristics above and take any of these actions using OS commands:",
      "",
      "### 1. Merge duplicates",
      "If two or more heuristics express the same insight in different words,",
      "use `learn` to create a single cleaner version, then `supersede` the old ones.",
      "The merged heuristic should have confidence = max of the originals.",
      "",
      "### 2. Flag contradictions",
      "If two heuristics give opposing advice for the same context, report the",
      "contradiction via `bb_write` key \"consolidation:contradictions\" so the",
      "metacog can evaluate which is correct. Do not resolve contradictions yourself",
      "— the system needs runtime evidence to determine which is right.",
      "",
      "### 3. Extract missing patterns",
      "Read the DAG snapshots at `" + this.config.memory.basePath + "/snapshots/`",
      "using your file tools. Look for recurring topology patterns (process types,",
      "coordination sequences, failure modes) that are NOT yet captured as heuristics.",
      "Use `learn` to codify any patterns you find, with confidence 0.5 (tentative).",
      "",
      "### 4. Sharpen vague heuristics",
      "If a heuristic is too vague to be actionable (e.g. \"be careful with dependencies\"),",
      "either make it specific via `learn` + `supersede`, or flag it for removal.",
      "",
      "## Output",
      "After completing your review, write a summary to the blackboard:",
      "`bb_write` key \"consolidation:report\" with: merges performed, contradictions found,",
      "patterns extracted, heuristics sharpened. Then go idle.",
      "",
      "## Constraints",
      "- Do NOT invent heuristics from general knowledge — only from evidence in the",
      "  snapshot data or from patterns visible in the existing heuristic set.",
      "- Preserve high-confidence, well-reinforced heuristics. Focus your energy on",
      "  the low-confidence, low-reinforcement entries and obvious redundancies.",
      "- This is a single pass — do your best work, write the report, then idle.",
    );

    return lines.join("\n");
  }

  snapshot(): OsSystemSnapshot {
    const allProcesses = this.table.getAll();
    const topology = this.dagEngine.currentTopology();
    const dagMetrics = this.dagEngine.metrics();

    const ipcSummary: OsIpcSummary = this.ipcBus.summary();

    const totalTokensUsed = allProcesses.reduce(
      (sum, p) => sum + p.tokensUsed,
      0,
    );
    const activeProcessCount = allProcesses.filter(
      (p) => p.state === "running",
    ).length;
    const stalledProcessCount = allProcesses.filter(
      (p) => p.state === "sleeping" || p.state === "idle",
    ).length;

    const progressMetrics: OsProgressMetrics = {
      activeProcessCount,
      stalledProcessCount,
      totalTokensUsed,
      tokenBudgetRemaining: this.config.kernel.tokenBudget - totalTokensUsed,
      wallTimeElapsedMs: Date.now() - this.startTime,
      tickCount: this.scheduler.tickCount,
    };

    const recentHeuristics = this.memoryStore.query(this.goal).slice(0, 10);

    // Capture blackboard contents
    const bbEntries = this.ipcBus.bbReadAll();
    const blackboard: Record<string, unknown> = {};
    for (const entry of bbEntries) {
      if (!entry.key.startsWith("_inbox:")) {
        blackboard[entry.key] = entry.value;
      }
    }

    return {
      runId: this.runId,
      tickCount: this.scheduler.tickCount,
      goal: this.goal,
      processes: allProcesses,
      dagTopology: topology,
      dagMetrics,
      ipcSummary,
      progressMetrics,
      recentEvents: this.table.events.slice(-50),
      recentHeuristics,
      blackboard,
      selectedBlueprint: this.selectedBlueprintInfo ?? undefined,
      deferrals: this.deferrals.size > 0
        ? Array.from(this.deferrals.values()).map(ds => ({
            id: ds.id,
            name: ds.descriptor.name ?? "unnamed",
            condition: ds.condition,
            waitedTicks: this.scheduler.tickCount - ds.registeredByTick,
            reason: ds.reason,
          }))
        : undefined,
    };
  }

  addTrigger(trigger: OsMetacogTrigger): void {
    this.pendingTriggers.push(trigger);
    this.metacog.addTrigger(trigger);
  }

  // ── Public accessors for MCP tools ──────────────────────────────────

  getProcessTable(): OsProcessTable {
    return this.table;
  }

  getSupervisor(): OsProcessSupervisor {
    return this.supervisor;
  }

  getIpcBus(): OsIpcBus {
    return this.ipcBus;
  }

  getDagEngine(): OsDagEngine {
    return this.dagEngine;
  }

  getMemoryStore(): ScopedMemoryStore {
    return this.memoryStore;
  }

  getGoal(): string {
    return this.goal;
  }

  getConfig(): OsConfig {
    return this.config;
  }

  getExecutor(): OsProcessExecutor {
    return this.executor;
  }

  /** Apply a single awareness adjustment — extracted for testability. */
  applyAwarenessAdjustment(adj: AwarenessAdjustment): void {
    switch (adj.kind) {
      case 'adjust_kill_threshold': {
        this.killEvalHistory.push({
          timestamp: Date.now(),
          pid: "awareness-adjustment",
          tokenDelta: adj.delta > 0 ? -200 : 200,
          wasPrematurely: adj.delta > 0,
        });
        break;
      }
      case 'flag_overconfident_heuristic': {
        const h = this.memoryStore.get(adj.heuristicId);
        if (h) {
          const reduction = Math.max(0.05, (h.confidence - (adj.observedAccuracy ?? h.confidence * 0.8)) * 0.5);
          h.confidence = Math.max(0.1, h.confidence - reduction);
          this.memoryStore.saveHeuristics();
          this.emitter?.emit({ type: 'os_awareness_adjust', kind: 'flag_overconfident_heuristic', heuristicId: adj.heuristicId, newConfidence: h.confidence } as any);
        }
        break;
      }
      case 'detect_oscillation': {
        this.pendingOscillationWarnings.push({ processType: adj.processType, killCount: adj.killCount, respawnCount: adj.respawnCount, windowTicks: adj.windowTicks });
        this.emitter?.emit({ type: 'os_awareness_oscillation', processType: adj.processType, killCount: adj.killCount, respawnCount: adj.respawnCount, windowTicks: adj.windowTicks } as any);
        break;
      }
      case 'suggest_metacog_focus': {
        this.metacogFocus = adj.area;
        this.emitter?.emit({ type: 'os_awareness_focus', area: adj.area } as any);
        break;
      }
      case 'detect_blind_spot': {
        this.pendingBlindSpots.push({ unusedCommandKind: adj.unusedCommandKind, ticksSinceLastUse: adj.ticksSinceLastUse });
        this.ipcBus.bbWrite(`awareness:blind-spot:${adj.unusedCommandKind}`, { ticksSinceLastUse: adj.ticksSinceLastUse, detectedAt: this.scheduler.tickCount }, "awareness-daemon");
        this.emitter?.emit({ type: 'os_awareness_blind_spot', commandKind: adj.unusedCommandKind } as any);
        break;
      }
      case 'noop':
        break;
    }
  }
}
