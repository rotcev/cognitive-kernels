import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  OsConfig,
  OsProcess,
  OsProcessDescriptor,
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
import type { KernelEvent, KernelEventInput } from "./state-machine/events.js";
import { createEventSequencer } from "./state-machine/events.js";
import type { KernelEffect, KernelEffectInput } from "./state-machine/effects.js";
import { createEffectSequencer } from "./state-machine/effects.js";
import { transition } from "./state-machine/transition.js";
import type { KernelState } from "./state-machine/state.js";
import type { TopologyExpr, MetacogMemoryCommand } from "./topology/types.js";


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

  /** PIDs being drained — let current turn finish, then kill. */
  private drainingPids: Set<string> = new Set();

  /** Transition-approved metacog evaluation — consumed by doMetacogCheck. */
  private transitionApprovedMetacog = false;
  /** Transition-approved awareness evaluation — consumed by doMetacogCheck. */
  private transitionApprovedAwareness = false;

  /** Typed event log — the input side of the state machine. */
  private readonly eventLog: KernelEvent[] = [];
  private readonly nextSeq = createEventSequencer();

  /** Typed effect log — the output side of the state machine. */
  private readonly effectLog: KernelEffect[] = [];
  private readonly nextEffectSeq = createEffectSequencer();

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
    this.logEvent({ type: "boot", goal });
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

    // ── Delegate process creation to pure transition function ──
    const hasNewEpisodicData = this.memoryStore.hasNewEpisodicData();
    const consolidatorObjective = hasNewEpisodicData ? this.buildConsolidatorObjective() : undefined;

    const state = this.extractState();
    const bootEvent: KernelEvent = {
      type: "boot",
      goal,
      workingDir: this.workingDir,
      hasNewEpisodicData,
      consolidatorObjective,
      awarenessEnabled: this.config.awareness.enabled,
      awarenessModel: this.config.awareness.model,
      timestamp: Date.now(),
      seq: this.nextSeq(),
    };

    const [newState, effects] = transition(state, bootEvent);

    // Apply state changes: processes, blackboard
    this.applyStateChanges(newState);

    // Interpret effects (submit_llm, emit_protocol)
    this.interpretTransitionEffects(effects);

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
      const housekeepMs = this.config.kernel.housekeepIntervalMs ?? 500;
      this.housekeepTimer = setInterval(() => {
        this.safeHousekeep();
      }, housekeepMs);
      (this.housekeepTimer as NodeJS.Timeout).unref?.();
      this.collectEffect({ type: "schedule_timer", timer: "housekeep", delayMs: housekeepMs });

      const snapshotMs = this.config.kernel.snapshotIntervalMs ?? 10_000;
      this.snapshotTimer = setInterval(() => {
        this.safeSnapshotWrite();
      }, snapshotMs);
      (this.snapshotTimer as NodeJS.Timeout).unref?.();
      this.collectEffect({ type: "schedule_timer", timer: "snapshot", delayMs: snapshotMs });

      // Self-scheduling metacog: fires once at boot, then reschedules based on
      // metacog's own nextWakeMs (capped at metacogIntervalMs as fallback max).
      this.scheduleNextMetacog(5_000); // first check 5s after boot — metacog declares initial topology


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
    this.logEvent({ type: "timer_fired", timer: "housekeep" });
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
    this.logEvent({ type: "timer_fired", timer: "snapshot" });
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

    // Delegate scheduling decision to transition — it checks cadence, triggers, goal drift.
    this.transitionApprovedMetacog = false;
    this.transitionApprovedAwareness = false;
    {
      const mcTimerEvent: KernelEvent = {
        type: "timer_fired",
        timer: "metacog",
        timestamp: Date.now(),
        seq: this.nextSeq(),
      };
      this.logEvent(mcTimerEvent);
      const state = this.extractState();
      const [newState, effects] = transition(state, mcTimerEvent);
      this.applyStateChanges(newState);
      this.interpretTransitionEffects(effects);
    }

    if (!this.transitionApprovedMetacog) return undefined;

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
        // TODO(Wave 7): Move metacog daemon lifecycle to transition effects
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
        // TODO(Wave 7): Move metacog daemon idle to transition effects
        // Return daemon to idle after its turn
        this.supervisor.idle(metacogDaemonProc.pid, {});
      }

      this.lastMetacogTick = this.scheduler.tickCount;
      const triggerCount = this.pendingTriggers.length;

      // (2) Read all pending items from 'metacog:commands' channel
      // (3) Apply each MetacogCommand via executeMetacogCommand()
      let metacogCommandCount = 0;
      const cmdEntry = this.ipcBus.bbRead("metacog:commands", "kernel");
      if (cmdEntry && typeof cmdEntry.value === "string") {
        try {
          const parsed = JSON.parse(cmdEntry.value);
          if (parsed && Array.isArray(parsed.commands)) {
            metacogCommandCount = parsed.commands.length;
          }
        } catch { /* count stays 0 */ }
        nextWakeMs = this.parseMetacogResponse(cmdEntry.value);
        this.ipcBus.bbDelete("metacog:commands");
      }
      this.ipcBus.bbDelete("metacog:system-state");

      // Track metacog evaluation count
      this.metacogEvalCount += 1;

      // Delegate pure state changes to transition (clears pendingTriggers)
      {
        const mcEvent: KernelEvent = {
          type: "metacog_evaluated",
          commandCount: metacogCommandCount,
          triggerCount,
          timestamp: Date.now(),
          seq: this.nextSeq(),
        };
        this.logEvent(mcEvent);
        const mcState = this.extractState();
        const [newState, effects] = transition(mcState, mcEvent);
        this.applyStateChanges(newState);
        this.interpretTransitionEffects(effects);
      }

      // Record progress snapshot for awareness context
      this.recordProgressSnapshot();

      // Run awareness daemon — transition decides cadence via submit_awareness effect
      if (this.transitionApprovedAwareness && this.awarenessDaemon) {
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

          const awEvent: KernelEvent = {
            type: "awareness_evaluated",
            hasAdjustment: awarenessResp.adjustments.length > 0,
            timestamp: Date.now(),
            seq: this.nextSeq(),
          };
          this.logEvent(awEvent);
          const awState = this.extractState();
          const [awNewState, awEffects] = transition(awState, awEvent);
          this.applyStateChanges(awNewState);
          this.interpretTransitionEffects(awEffects);
        } catch {
          // Awareness eval failed — continue without notes
        }

        // TODO: Move awareness daemon idle to transition effects
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
    this.collectEffect({ type: "schedule_timer", timer: "metacog", delayMs: clamped });
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
    this.collectEffect({ type: "schedule_timer", timer: "watchdog", delayMs: intervalMs });
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
    this.logEvent({ type: "timer_fired", timer: "watchdog" });
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
              this.emitProtocol("os_process_kill", `watchdog_kill: ${cmd.reason}`, {
                agentId: cmd.pid,
                agentName: this.table.get(cmd.pid)?.name ?? cmd.pid,
                detail: { trigger: "watchdog", reason: cmd.reason },
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
          // TODO(Wave 7): Move watchdog awareness daemon lifecycle to transition effects
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

            {
              const awEvent: KernelEvent = {
                type: "awareness_evaluated",
                hasAdjustment: awarenessResp.adjustments.length > 0,
                timestamp: Date.now(),
                seq: this.nextSeq(),
              };
              this.logEvent(awEvent);
              const awState = this.extractState();
              const [awNewState, awEffects] = transition(awState, awEvent);
              this.applyStateChanges(awNewState);
              this.interpretTransitionEffects(awEffects);
            }
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
    // TODO(Wave 7): Legacy tick() path — remove when sub-kernels use eventLoop()
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

        // TODO(Wave 7): Dead executive recovery is now handled by transition's handleHousekeep.
        // This tick()-path code is legacy (used by sub-kernels) — keep addTrigger for compatibility.
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

    // 8e. Goal drift trigger detection is now handled by transition's handleHousekeep.
    // pendingTriggers will already contain "goal_drift" if conditions are met.

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
        // TODO(Wave 7): Move watchdog metacog daemon lifecycle to transition effects
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
          // TODO(Wave 7): Move watchdog metacog daemon idle to transition effects
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

          {
            const awEvent: KernelEvent = {
              type: "awareness_evaluated",
              hasAdjustment: awarenessResp.adjustments.length > 0,
              timestamp: Date.now(),
              seq: this.nextSeq(),
            };
            this.logEvent(awEvent);
            const awState = this.extractState();
            const [awNewState, awEffects] = transition(awState, awEvent);
            this.applyStateChanges(awNewState);
            this.interpretTransitionEffects(awEffects);
          }
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
  /**
   * Run one housekeep cycle: transition for pure state + housekeepIO for runtime I/O.
   * Used by safeHousekeep (adds mutex/halt/scheduling) and tests (direct call).
   */
  private housekeep(): void {
    const state = this.extractState();
    const timerEvent: KernelEvent = {
      type: "timer_fired",
      timer: "housekeep",
      pendingEphemeralCount: this.pendingEphemerals.length + this.activeEphemeralCount,
      bbKeyCount: this.ipcBus.summary().blackboardKeyCount,
      lastForceWakeTime: this.lastForceWakeTime,
      bbKeysAtLastForceWake: this.bbKeysAtLastForceWake,
      timestamp: Date.now(),
      seq: this.nextSeq(),
    };
    const [newState, effects] = transition(state, timerEvent);
    this.applyStateChanges(newState);
    this.interpretTransitionEffects(effects);

    // Track force-wake state for deadlock detection across housekeep cycles
    const forceWokeOrchestrator = effects.some(
      e => e.type === "emit_protocol" && e.message?.includes("deadlock_detected")
    );
    if (forceWokeOrchestrator) {
      this.lastForceWakeTime = Date.now();
      this.bbKeysAtLastForceWake = this.ipcBus.summary().blackboardKeyCount;
    }

    this.housekeepIO();
  }

  /**
   * I/O-heavy housekeep operations that the transition function cannot handle.
   * Called after transition has already applied pure state decisions.
   *
   * Wave 3 migration: cadence signals, zombie reaping, daemon restarts, DAG rebuild,
   * and strategy application are now handled by transition effects (signal_emit, flush_ipc,
   * activate_process, submit_llm, rebuild_dag, apply_strategies).
   *
   * Wave 5 migration: deferral processing now handled by transition's processPureDeferrals().
   *
   * Remaining here: telemetry (observability, not decisions).
   */
  private housekeepIO(): void {
    // 0. Reset per-tick state
    this.tickSignals = [];

    // 1. Deferral processing — fully migrated to transition's processPureDeferrals() (Wave 5).
    // Transition evaluates conditions, spawns processes, emits submit_llm effects.
    // applyStateChanges syncs new processes + deferrals; interpretTransitionEffects submits them.

    // 2. Telemetry collection + perf analysis (observability, not decision-making — OK to keep)
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

    this.logEvent({
      type: "process_submitted",
      pid: proc.pid,
      name: proc.name,
      model: proc.model ?? this.config.kernel.processModel,
    });

    this.collectEffect({
      type: "submit_llm",
      pid: proc.pid,
      name: proc.name,
      model: proc.model ?? this.config.kernel.processModel,
    });

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
    const completedProc = this.table.get(result.pid);
    this.logEvent({
      type: "process_completed",
      pid: result.pid,
      name: completedProc?.name ?? "unknown",
      success: result.success,
      commandCount: result.commands.length,
      tokensUsed: result.tokensUsed,
      commands: result.commands,
      response: result.response,
    });
    const release = await this.mutex.acquire();
    try {
      await this.processOneResult(result);
      // NOTE: lastProcessCompletionTime is set by transition via applyStateChanges

      // Meaningful tick: actual work just completed. This is the only place
      // tickCount is incremented in the event-driven model, so tick-based
      // mechanisms (deferrals, interventions, metacog cadence) operate at
      // the timescale of real scheduling cycles, not 500ms timer fires.
      this.scheduler.tick();

      // Drain check — if this process was marked for draining (topology removed
      // it while it was in-flight), kill it now that its turn has completed.
      if (this.drainingPids.has(result.pid)) {
        this.supervisor.kill(result.pid, false, "drained from topology");
        this.executor.disposeThread(result.pid);
        this.router.disposeThread(result.pid);
        this.drainingPids.delete(result.pid);
      }

      // NOTE: Deferral processing fully migrated to transition's processPureDeferrals() (Wave 5).
      // Transition evaluates all conditions purely and emits submit_llm effects.

      // Fire-and-forget ephemerals spawned by this process's commands
      void this.drainPendingEphemerals();

      // Flush IPC — wake processes unblocked by bb writes / signals
      // This flush catches I/O-side signals from drainPendingEphemerals().
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
   *
   * TODO(Wave 7): This method is now redundant for the transition-driven path.
   * handleHousekeep in transition.ts calls selectRunnable() and emits submit_llm
   * effects directly. This imperative version remains because it's called from
   * multiple event-driven loop handlers (process_completed, timer handlers, etc.).
   * Wave 7 should migrate all callers to the transition path and remove this method.
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

  private async processOneResult(result: OsProcessTurnResult): Promise<void> {
    const proc = this.table.get(result.pid);
    if (!proc) return;

    // Snapshot which processes are already dead before transition
    const wasDeadBefore = new Set<string>();
    for (const p of this.table.getAll()) {
      if (p.state === "dead") wasDeadBefore.add(p.pid);
    }

    // ── Delegate to pure transition function ──
    const state = this.extractState();
    const event: KernelEvent = {
      type: "process_completed",
      pid: result.pid,
      name: proc.name,
      success: result.success,
      commandCount: result.commands.length,
      tokensUsed: result.tokensUsed,
      commands: result.commands,
      response: result.response,
      timestamp: Date.now(),
      seq: this.nextSeq(),
    };

    const [newState, effects] = transition(state, event);

    // Apply all state changes (processes, blackboard, deferrals, triggers)
    this.applyStateChanges(newState);

    // Interpret effects (submit_llm, emit_protocol, start_shell, etc.)
    this.interpretTransitionEffects(effects);

    // ── Post-transition side effects (I/O that can't live in pure transition) ──

    // Dispose threads for newly-dead processes
    for (const [pid, p] of newState.processes) {
      if (p.state === "dead" && !wasDeadBefore.has(pid)) {
        this.executor.disposeThread(pid);
        this.router.disposeThread(pid);
      }
    }

    // GAP 1: Record strategy outcome
    if (!result.success && proc.activeStrategyId) {
      this.memoryStore.recordStrategyOutcome(proc.activeStrategyId, false, proc.tokensUsed);
    }
    if (result.success) {
      const exitCmd = result.commands.find(c => c.kind === "exit");
      if (exitCmd && exitCmd.kind === "exit" && proc.activeStrategyId) {
        this.memoryStore.recordStrategyOutcome(proc.activeStrategyId, exitCmd.code === 0, proc.tokensUsed);
      }
    }

    // Gap 8: Telemetry
    if (result.success && this.config.kernel.telemetryEnabled) {
      this.telemetryCollector.onProcessComplete(
        proc.pid,
        result.tokensUsed,
        result.response.split("\n"),
      );
    }

    // NOTE: The old processOneResult body (token tracking, failure handling,
    // hard spawn enforcement, architect-phase deadlock, command execution,
    // auto-exit daemons) is now handled by the transition function above.
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

        // ── Delegate state mutations to pure transition function ──
        const release = await this.mutex.acquire();
        try {
          this.logEvent({
            type: "ephemeral_completed",
            id: desc.ephemeralId,
            name: desc.name,
            success: true,
          });

          const state = this.extractState();
          const event: KernelEvent = {
            type: "ephemeral_completed",
            id: desc.ephemeralId,
            name: desc.name,
            success: true,
            tablePid: desc.tablePid,
            parentPid: desc.pid,
            response: ephTurnResult.finalResponse,
            durationMs: ephDurationMs,
            model: desc.model,
            timestamp: Date.now(),
            seq: this.nextSeq(),
          };

          const [newState, effects] = transition(state, event);
          this.applyStateChanges(newState);
          this.interpretTransitionEffects(effects);

          // Post-transition I/O
          this.ipcBus.emitSignal("ephemeral:ready", "kernel", { name: desc.name, id: desc.ephemeralId, parentPid: desc.pid });
          this.tickSignals.push("ephemeral:ready");

          if (this.config.kernel.telemetryEnabled) {
            const ephResult: import("./types.js").OsEphemeralResult = {
              ephemeralId: desc.ephemeralId,
              name: desc.name,
              success: true,
              response: ephTurnResult.finalResponse,
              durationMs: ephDurationMs,
              model: desc.model,
              tokensEstimate: Math.ceil(ephTurnResult.finalResponse.length / 4),
            };
            this.telemetryCollector.onEphemeralComplete(ephResult);
          }

          // Flush IPC + wake + reschedule
          // TODO(Wave 3): Transition already emits flush_ipc; this flush catches
          // post-transition I/O signals emitted above (ipcBus.emitSignal).
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

        // ── Delegate state mutations to pure transition function ──
        const release = await this.mutex.acquire();
        try {
          this.logEvent({
            type: "ephemeral_completed",
            id: desc.ephemeralId,
            name: desc.name,
            success: false,
          });

          const state = this.extractState();
          const event: KernelEvent = {
            type: "ephemeral_completed",
            id: desc.ephemeralId,
            name: desc.name,
            success: false,
            tablePid: desc.tablePid,
            parentPid: desc.pid,
            error: errorMsg,
            durationMs: ephDurationMs,
            model: desc.model,
            timestamp: Date.now(),
            seq: this.nextSeq(),
          };

          const [newState, effects] = transition(state, event);
          this.applyStateChanges(newState);
          this.interpretTransitionEffects(effects);

          // Post-transition I/O
          this.ipcBus.emitSignal("ephemeral:ready", "kernel", { name: desc.name, id: desc.ephemeralId, parentPid: desc.pid, error: true });
          this.tickSignals.push("ephemeral:ready");

          if (this.config.kernel.telemetryEnabled) {
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
            this.telemetryCollector.onEphemeralComplete(ephResult);
          }

          // Flush IPC + wake + reschedule
          // TODO(Wave 3): Transition already emits flush_ipc; this flush catches
          // post-transition I/O signals emitted above (ipcBus.emitSignal).
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
   * Parse the metacog response for structured commands and execute them.
   * Gracefully handles non-JSON responses (backward compatible with existing tests).
   */
  private parseMetacogResponse(response: string): number | undefined {
    let parsed: any;
    try {
      parsed = JSON.parse(response);
    } catch {
      // Non-JSON response — graceful no-op (backward compat with mock threads)
      return undefined;
    }

    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    // ── Detect format: new topology-based vs legacy commands-based ──
    const isTopologyFormat = "topology" in parsed || "memory" in parsed;

    if (!isTopologyFormat) {
      // Legacy commands-based format: { assessment, commands, citedHeuristicIds }
      if (!Array.isArray(parsed.commands)) return undefined;
      return this.parseMetacogResponseLegacy(parsed as MetacogResponse);
    }

    // ── New topology format: { assessment, topology, memory, halt, citedHeuristicIds } ──
    const topology: TopologyExpr | null = parsed.topology ?? null;
    const memory: MetacogMemoryCommand[] = Array.isArray(parsed.memory) ? parsed.memory : [];
    const halt: { status: "achieved" | "unachievable" | "stalled"; summary: string } | null = parsed.halt ?? null;
    const assessment: string = parsed.assessment ?? "";
    const citedHeuristicIds: string[] | undefined = parsed.citedHeuristicIds;

    // Emit protocol event for observability
    this.emitter?.emit({
      action: "os_metacog",
      status: "completed",
      message: `assessment=${assessment.slice(0, 100)} topology=${topology !== null ? "declared" : "null"} memory=${memory.length} halt=${halt?.status ?? "none"}`,
      detail: {
        assessment,
        topology: topology !== null,
        memoryCommands: memory.map(m => m.kind),
        halt: halt?.status ?? null,
        citedHeuristicIds,
      },
    });

    // Record metacog decision in history for awareness daemon analysis
    // Synthesize a minimal commands array for backward compat with MetacogHistoryEntry
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
      tick: this.scheduler.tickCount,
      assessment,
      commands: syntheticCommands,
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
      const stalledNow = allProcsNow.filter(p => p.state === "sleeping" || p.state === "idle").length;
      const totalNow = allProcsNow.filter(p => p.state !== "dead").length;
      const stalledRatio = totalNow > 0 ? stalledNow / totalNow : 0;
      retroEntry.outcome = stalledRatio < 0.3 ? "improved" : stalledRatio > 0.6 ? "degraded" : "neutral";
    }

    // Execute memory commands directly (learn, define_blueprint, evolve_blueprint, record_strategy)
    for (const cmd of memory) {
      try {
        this.executeMemoryCommand(cmd);
      } catch {
        // Individual memory command failure shouldn't stop others
      }
    }

    // Create topology_declared event and feed through transition
    const topoEvent: KernelEvent = {
      type: "topology_declared",
      topology,
      memory,
      halt,
      timestamp: Date.now(),
      seq: this.nextSeq(),
    };
    this.logEvent(topoEvent);
    const state = this.extractState();
    const [newState, effects] = transition(state, topoEvent);
    this.applyStateChanges(newState);
    this.interpretTransitionEffects(effects);

    // Track which heuristics influenced this evaluation for retrospective validation
    const citedIds = Array.isArray(citedHeuristicIds) && citedHeuristicIds.length > 0
      ? citedHeuristicIds.filter((id: string) => this.memoryStore.get(id) !== undefined)
      : this.memoryStore.query(this.goal).slice(0, 5).map(h => h.id);
    for (const hId of citedIds) {
      this.heuristicApplicationLog.push({
        heuristicId: hId,
        appliedAtTick: this.scheduler.tickCount,
        metacogCommandKind: topology !== null ? "topology" : (memory[0]?.kind ?? "unknown"),
      });
    }
    // Cap log at 200 entries
    if (this.heuristicApplicationLog.length > 200) {
      this.heuristicApplicationLog = this.heuristicApplicationLog.slice(-200);
    }

    // Topology format does not use self-scheduled wake
    return undefined;
  }

  /**
   * Legacy parseMetacogResponse path for commands-based format.
   * Used when metacog output contains { assessment, commands, citedHeuristicIds }.
   */
  private parseMetacogResponseLegacy(parsed: MetacogResponse): number | undefined {
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
      const stalledNow = allProcsNow.filter(p => p.state === "sleeping" || p.state === "idle").length;
      const totalNow = allProcsNow.filter(p => p.state !== "dead").length;
      const stalledRatio = totalNow > 0 ? stalledNow / totalNow : 0;
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
   * Execute a single memory command from the topology-based metacog format.
   * Handles: learn, define_blueprint, evolve_blueprint, record_strategy.
   */
  private executeMemoryCommand(cmd: MetacogMemoryCommand): void {
    switch (cmd.kind) {
      case "learn":
        this.memoryStore.learn(
          cmd.heuristic,
          cmd.confidence,
          cmd.context,
          this.runId,
          undefined,
          cmd.scope as "global" | "local" | undefined,
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
        const bp = {
          id: randomUUID(),
          ...cmd.blueprint,
          stats: { uses: 0, successes: 0, failures: 0, avgTokenEfficiency: 0, avgWallTimeMs: 0, lastUsedAt: "", alpha: 1, beta: 1, tagStats: {} },
          learnedAt: new Date().toISOString(),
        } as TopologyBlueprint;
        this.memoryStore.addBlueprint(bp);
        this.emitter?.emit({
          action: "os_metacog",
          status: "completed",
          message: `define_blueprint name=${bp.name} id=${bp.id}`,
        });
        break;
      }

      case "evolve_blueprint": {
        const source = this.memoryStore.getBlueprint(cmd.sourceBlueprintId);
        if (!source) throw new Error(`Blueprint not found: ${cmd.sourceBlueprintId}`);

        const newBlueprintId = `${cmd.sourceBlueprintId}-evolved-${Date.now()}`;
        const evolved: TopologyBlueprint = JSON.parse(JSON.stringify(source));
        evolved.id = newBlueprintId;
        evolved.evolvedFrom = cmd.sourceBlueprintId;
        evolved.learnedAt = new Date().toISOString();
        evolved.source = "metacog";

        // Apply mutations (cmd.mutations is Record<string, unknown>)
        const mutations = cmd.mutations as Record<string, any>;
        if (mutations.namePrefix) {
          evolved.name = `${mutations.namePrefix}${evolved.name}`;
        }
        if (mutations.gatingChange) {
          evolved.gatingStrategy = mutations.gatingChange as BlueprintGatingStrategy;
        }
        if (mutations.roleChanges) {
          for (const change of mutations.roleChanges) {
            if (change.action === "remove") {
              evolved.roles = evolved.roles.filter((r: any) => r.name !== change.roleName);
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
              const role = evolved.roles.find((r: any) => r.name === change.roleName);
              if (role) {
                if (change.template) role.objectiveTemplate = change.template;
                if (change.type) role.type = change.type as OsProcessType;
                if (change.priority !== undefined) role.priorityOffset = change.priority;
              }
            }
          }
        }

        // Inherit Bayesian priors from parent, decayed toward uniform Beta(1,1)
        const parentAlpha = source.stats.alpha ?? 1;
        const parentBeta = source.stats.beta ?? 1;
        evolved.stats = {
          uses: 0, successes: 0, failures: 0,
          avgTokenEfficiency: 0, avgWallTimeMs: 0, lastUsedAt: "",
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
        const stratObj = cmd.strategy as Record<string, any>;
        const strategyToSave: SchedulingStrategy = {
          id: `strategy-${Date.now()}`,
          description: JSON.stringify(stratObj),
          conditions: [],
          adjustments: {},
          outcomes: { successes: 0, failures: 0 },
          createdAt: Date.now(),
          lastUsed: Date.now(),
          ...stratObj,
        };
        this.memoryStore.saveSchedulingStrategy(strategyToSave);
        this.emitter?.emit({
          action: "os_metacog",
          status: "completed",
          message: `record_strategy id=${strategyToSave.id}`,
        });
        break;
      }
    }
  }

  /**
   * Execute a single metacognitive command.
   * TODO(Wave 7): Metacog commands bypass the transition function and directly call
   * supervisor.activate/spawn/kill. These should be migrated to transition effects.
   */
  private executeMetacogCommand(cmd: MetacogCommand): void {
    // Capture pre-snapshot for intervention outcome tracking
    const interventionTrackedKinds: Array<MetacogCommand['kind']> = [
      'fork', 'kill', 'spawn', 'defer', 'reprioritize',
      'evolve_blueprint',
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
        this.emitProtocol("os_process_spawn", `metacog_spawn`, {
          agentId: proc.pid,
          agentName: proc.name,
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
        this.emitProtocol("os_process_kill", `metacog_kill: ${cmd.reason}`, {
          agentId: cmd.pid,
          agentName: targetProc?.name,
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
        this.emitProtocol("os_process_spawn", `metacog_fork source=${cmd.pid}`, {
          agentId: forked.pid,
          agentName: forked.name,
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
        this.emitProtocol("os_process_spawn", `delegate_evaluation scope="${evalScope}"`, {
          agentId: subEvalProc.pid,
          agentName: subEvalProc.name,
        });
        break;
      }
    }
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

  /** Record a kernel event. */
  private logEvent(event: KernelEventInput): void {
    this.eventLog.push({
      ...event,
      timestamp: Date.now(),
      seq: this.nextSeq(),
    } as KernelEvent);
  }

  /** Get the event log (for testing and Lens). */
  getEventLog(): readonly KernelEvent[] {
    return this.eventLog;
  }

  /** Record a kernel effect. */
  private collectEffect(effect: KernelEffectInput): void {
    this.effectLog.push({
      ...effect,
      seq: this.nextEffectSeq(),
    } as KernelEffect);
  }

  /**
   * Emit a protocol event AND collect it as an emit_protocol effect.
   * Phase 2 wrapper — progressively replacing direct this.emitter?.emit() calls.
   */
  private emitProtocol(action: string, message: string, detail?: Record<string, unknown>): void {
    this.collectEffect({ type: "emit_protocol", action, message });
    this.emitter?.emit({ action, status: "completed", message, ...detail });
  }

  /** Get the effect log (for testing and Lens). */
  getEffectLog(): readonly KernelEffect[] {
    return this.effectLog;
  }

  /**
   * Extract the kernel's deterministic state as a plain-data KernelState.
   * This bridges the mutable kernel class and the pure transition function.
   */
  extractState(): KernelState {
    // Build process map from process table
    const processes = new Map<string, OsProcess>();
    for (const proc of this.table.getAll()) {
      processes.set(proc.pid, proc);
    }

    // Snapshot blackboard from IPC bus for transition function use
    const blackboard = new Map<string, { value: unknown; writtenBy: string | null; version: number }>();
    for (const entry of this.ipcBus.bbReadAll()) {
      blackboard.set(entry.key, {
        value: entry.value,
        writtenBy: entry.writtenBy,
        version: entry.version,
      });
    }

    return {
      goal: this.goal,
      runId: this.runId,
      config: this.config,
      processes,
      inflight: new Set(this.inflight.keys()),
      activeEphemeralCount: this.activeEphemeralCount,
      blackboard,
      tickCount: this.scheduler.tickCount,
      schedulerStrategy: this.config.scheduler.strategy,
      schedulerMaxConcurrent: this.config.scheduler.maxConcurrentProcesses,
      schedulerRoundRobinIndex: this.scheduler.getRoundRobinIndex(),
      schedulerHeuristics: this.memoryStore.query(this.goal),
      currentStrategies: this.scheduler.getCurrentStrategies(),
      dagTopology: this.dagEngine.currentTopology(),
      deferrals: new Map(this.deferrals),
      pendingTriggers: [...this.pendingTriggers],
      lastMetacogTick: this.lastMetacogTick,
      metacogEvalCount: this.metacogEvalCount,
      activeStrategyId: this.activeStrategyId ?? null,
      matchedStrategyIds: this.bootMatchedStrategyIds ?? new Set(),

      metacogInflight: false, // kernel uses mutex — state machine will own this
      lastMetacogWakeAt: this.lastMetacogWakeAt,
      metacogHistory: [...this.metacogHistory],

      awarenessNotes: [...this.pendingAwarenessNotes],
      oscillationWarnings: [...this.pendingOscillationWarnings],
      blindSpots: [],
      metacogFocus: this.metacogFocus,

      drainingPids: new Set(this.drainingPids),

      killThresholdAdjustment: this.killThresholdAdjustment,
      killEvalHistory: [...this.killEvalHistory],

      selectedBlueprintInfo: this.selectedBlueprintInfo,

      ephemeralStats: { spawns: 0, successes: 0, failures: 0, totalDurationMs: 0 },
      heuristicApplicationLog: [...this.heuristicApplicationLog],

      halted: this.halted,
      haltReason: this.haltReason,
      goalWorkDoneAt: this.goalWorkDoneAt,
      startTime: this.startTime,
      consecutiveIdleTicks: this.consecutiveIdleTicks,
      lastProcessCompletionTime: this.lastProcessCompletionTime,
      housekeepCount: this.housekeepCount,
    };
  }

  /**
   * Apply state changes from a transition result back to kernel fields.
   * Only applies fields that the transition function can modify.
   */
  private applyStateChanges(newState: KernelState): void {
    // NOTE: Do NOT set this.halted here — haltResolve() sets it and must
    // not see it as already true (it uses the flag to prevent duplicate halts).
    // The caller checks newState.halted and calls haltResolve() if needed.

    // ── Scalar fields ──
    this.goal = newState.goal;
    this.haltReason = newState.haltReason ?? "";
    this.goalWorkDoneAt = newState.goalWorkDoneAt;
    this.activeStrategyId = newState.activeStrategyId ?? undefined;
    this.consecutiveIdleTicks = newState.consecutiveIdleTicks;
    this.lastProcessCompletionTime = newState.lastProcessCompletionTime;
    this.housekeepCount = newState.housekeepCount;
    this.lastMetacogTick = newState.lastMetacogTick;
    this.metacogEvalCount = newState.metacogEvalCount;
    this.scheduler.setRoundRobinIndex(newState.schedulerRoundRobinIndex);

    // ── Process table — trivial sync ──
    const existingPids = new Set(this.table.getAll().map(p => p.pid));

    for (const [pid, proc] of newState.processes) {
      if (!existingPids.has(pid)) {
        this.table.addDirect(proc);
      } else {
        const existing = this.table.get(pid)!;
        // Copy all mutable fields — NO decisions
        existing.state = proc.state;
        existing.tickCount = proc.tickCount;
        existing.tokensUsed = proc.tokensUsed;
        existing.lastActiveAt = proc.lastActiveAt;
        existing.exitCode = proc.exitCode;
        existing.exitReason = proc.exitReason;
        existing.children = proc.children;
        existing.selfReports = proc.selfReports;
        existing.blackboardKeysWritten = proc.blackboardKeysWritten;
        existing.ephemeralSpawnCount = proc.ephemeralSpawnCount;
        existing.checkpoint = proc.checkpoint;
        existing.sleepUntil = proc.sleepUntil;
        existing.wakeOnSignals = proc.wakeOnSignals;
      }
    }

    // ── Blackboard — write new/updated entries ──
    for (const [key, entry] of newState.blackboard) {
      this.ipcBus.bbWrite(key, entry.value, entry.writtenBy ?? "kernel");
    }

    // ── Deferrals ──
    this.deferrals = new Map(newState.deferrals);

    // ── Triggers ──
    this.pendingTriggers = [...newState.pendingTriggers];
    this.metacog.setTriggers(newState.pendingTriggers);
  }

  /**
   * Interpret effects from a transition result — execute each effect
   * using the kernel's runtime capabilities (I/O, timers, emitter).
   */
  private interpretTransitionEffects(effects: readonly KernelEffect[]): void {
    for (const effect of effects) {
      // Record in effect log
      this.collectEffect(effect);

      switch (effect.type) {
        case "emit_protocol":
          this.emitter?.emit({
            action: effect.action,
            status: "completed",
            message: effect.message,
          });
          break;

        case "halt":
          // Halt is applied by caller checking newState.halted
          break;

        case "submit_llm": {
          // Submit the process for LLM execution
          const proc = this.table.get(effect.pid);
          if (proc) {
            this.submitProcess(proc);
          }
          break;
        }

        case "submit_ephemeral": {
          // Queue ephemeral for execution — the transition already created the process
          const ephProc = this.table.get(effect.pid);
          const parentPid = ephProc?.parentPid;
          const parentProc = parentPid ? this.table.get(parentPid) : undefined;
          if (ephProc && parentProc) {
            this.pendingEphemerals.push({
              pid: parentProc.pid,
              ephemeralId: effect.ephemeralId,
              tablePid: ephProc.pid,
              name: effect.name,
              model: effect.model,
              prompt: [
                "You are a single-turn helper process. You run once, return findings, then terminate.",
                "IMPORTANT: You have NO blackboard access. Do NOT claim to write to any blackboard key (scout:*, ephemeral:*, etc.).",
                "Your text response IS your output — the kernel captures it and delivers it to your parent automatically.",
                "Your work directly unblocks your parent — accuracy and completeness matter.",
                "",
                "## Context",
                `Parent process: ${parentProc.name} (working on: ${parentProc.objective ?? "unknown"})`,
                `Working directory: ${parentProc.workingDir}`,
                "",
                "## Task",
                ephProc.objective,
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
              workingDir: parentProc.workingDir,
              startTime: Date.now(),
            });
          }
          break;
        }

        case "start_shell": {
          // Start the shell process via executor router
          const shellProc = this.table.get(effect.pid);
          if (shellProc) {
            this.router.startProcess(shellProc).catch(() => {
              this.supervisor.kill(shellProc.pid, false, "shell start failed");
            });
          }
          break;
        }

        case "start_subkernel": {
          // Start the sub-kernel via executor router
          const kernelProc = this.table.get(effect.pid);
          if (kernelProc) {
            this.router.startProcess(kernelProc).catch(() => {
              this.supervisor.kill(kernelProc.pid, false, "subkernel boot failed");
            });
          }
          break;
        }

        case "persist_memory": {
          // Handle checkpoint persistence
          if (effect.operation.startsWith("checkpoint:")) {
            const pid = effect.operation.slice("checkpoint:".length);
            const proc = this.table.get(pid);
            if (proc?.checkpoint) {
              // Enrich with executor state before saving
              proc.checkpoint.executorState = this.router.captureCheckpointState(proc) ?? undefined;
              this.memoryStore.saveCheckpoint(proc.checkpoint);
            }
          }
          break;
        }

        case "activate_process": {
          const proc = this.table.get(effect.pid);
          if (proc && (proc.state === "idle" || proc.state === "sleeping")) {
            this.supervisor.activate(effect.pid);
          }
          break;
        }
        case "idle_process": {
          const idleProc = this.table.get(effect.pid);
          // Guard: applyStateChanges already synced state to idle — only call supervisor.idle
          // if the process is NOT already idle (avoids invalid idle→idle transition).
          if (idleProc && idleProc.state !== "idle") {
            this.supervisor.idle(effect.pid, effect.wakeOnSignals ? { signals: effect.wakeOnSignals } : {});
          } else if (idleProc && effect.wakeOnSignals) {
            // Process already idle — just update wakeOnSignals without state transition
            idleProc.wakeOnSignals = effect.wakeOnSignals;
          }
          break;
        }
        case "signal_emit": {
          this.ipcBus.emitSignal(effect.signal, effect.sender, effect.payload);
          this.tickSignals.push(effect.signal);
          break;
        }
        case "child_done_signal": {
          this.emitChildDoneSignal(effect.childPid, effect.childName, effect.parentPid, effect.exitCode, effect.exitReason);
          break;
        }
        case "flush_ipc": {
          const { wokenPids } = this.ipcBus.flush();
          for (const pid of wokenPids) {
            const proc = this.table.get(pid);
            if (proc && proc.state === "idle") {
              this.supervisor.activate(pid);
            }
          }
          break;
        }
        case "rebuild_dag": {
          this.dagEngine.buildFromProcesses(this.table.getAll());
          break;
        }
        case "schedule_pass": {
          this.doSchedulingPass();
          break;
        }

        case "apply_strategies": {
          // Resolve strategy IDs to full strategy objects from memory store
          const allStrategies = this.memoryStore.getSchedulingStrategies();
          const strategyIdSet = new Set(effect.strategyIds);
          const applicable = allStrategies.filter(s => strategyIdSet.has(s.id));
          if (applicable.length > 0) {
            this.scheduler.applyStrategies(applicable);
          }
          this.router.setStrategiesSnapshot(applicable);
          break;
        }

        case "submit_metacog": {
          // Transition decided metacog should run — trigger the async metacog evaluation.
          // The actual LLM call happens in doMetacogCheck; we just signal that transition approved it.
          // doMetacogCheck already handles all the I/O (reading/writing blackboard, invoking LLM).
          // Setting a flag here so doMetacogCheck knows transition approved the evaluation.
          this.transitionApprovedMetacog = true;
          break;
        }

        case "submit_awareness": {
          // Transition decided awareness should run after metacog.
          // The actual LLM call happens in doMetacogCheck's awareness section.
          this.transitionApprovedAwareness = true;
          break;
        }

        case "spawn_topology_process": {
          // Spawn a new process from topology reconciliation
          const backend = effect.backend;
          const descriptor: OsProcessDescriptor = {
            type: "lifecycle",
            name: effect.name,
            objective: effect.objective,
            priority: effect.priority ?? this.config.processes.defaultPriority,
            model: effect.model ?? this.config.kernel.processModel,
            workingDir: this.workingDir,
            ...(backend && backend.kind !== "llm" ? { backend } : {}),
          };
          const proc = this.supervisor.spawn(descriptor);
          this.supervisor.activate(proc.pid);
          this.emitProtocol("os_process_spawn", `topology_spawn`, {
            agentId: proc.pid,
            agentName: proc.name,
            detail: {
              trigger: "topology",
              objective: effect.objective,
              type: "lifecycle",
              priority: descriptor.priority,
              model: descriptor.model,
              backend: backend?.kind ?? "llm",
            },
          });
          // Start execution based on backend kind
          if (!backend || backend.kind === "llm") {
            this.submitProcess(proc);
          } else {
            this.router.startProcess(proc).catch(() => {
              this.supervisor.kill(proc.pid, false, `${backend.kind} start failed`);
            });
          }
          break;
        }

        case "kill_process": {
          // Kill a process removed from topology
          this.supervisor.kill(effect.pid, false, "removed from topology");
          this.executor.disposeThread(effect.pid);
          this.router.disposeThread(effect.pid);
          // Cancel inflight LLM call if still running
          const killCb = this.turnKillCallbacks.get(effect.pid);
          if (killCb) killCb();
          this.emitter?.emit({
            action: "os_process_kill",
            status: "completed",
            agentId: effect.pid,
            agentName: effect.name,
            message: `topology_kill: removed from topology`,
          });
          break;
        }

        case "drain_process": {
          // Mark PID for drain — let current turn finish, then kill
          this.drainingPids.add(effect.pid);
          this.emitter?.emit({
            action: "os_process_drain",
            status: "started",
            agentId: effect.pid,
            agentName: effect.name,
            message: `topology_drain: will kill after current turn completes`,
          });
          break;
        }

        case "schedule_timer":
        case "cancel_timer":
        case "persist_snapshot":
          // These effect types are handled elsewhere or are observational
          break;
      }
    }
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
    // Delegate to pure transition function — the first strangler connection.
    // The transition function computes halt logic deterministically;
    // we interpret the effects (emit_protocol, halt) back into the kernel.
    const state = this.extractState();
    const haltCheckEvent: KernelEvent = {
      type: "halt_check",
      result: false,   // placeholder — transition computes the real result
      reason: null,
      timestamp: Date.now(),
      seq: this.nextSeq(),
    };

    const [newState, effects] = transition(state, haltCheckEvent);

    // Apply state changes (halted, haltReason, goalWorkDoneAt)
    this.applyStateChanges(newState);

    // Interpret effects (emit_protocol events)
    this.interpretTransitionEffects(effects);

    // Log the halt_check event with the computed result
    this.logEvent({
      type: "halt_check",
      result: newState.halted,
      reason: newState.halted ? newState.haltReason : null,
    });

    return newState.halted;
  }

  halt(reason: string): void {
    // Delegate to transition via external_command halt event
    const state = this.extractState();
    const haltEvent: KernelEvent = {
      type: "external_command",
      command: "halt",
      reason,
      timestamp: Date.now(),
      seq: this.nextSeq(),
    };
    const [newState, effects] = transition(state, haltEvent);
    this.applyStateChanges(newState);
    this.interpretTransitionEffects(effects);
    this.logEvent(haltEvent);

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
   * @deprecated Legacy — used only by tick() for sub-kernel compat.
   * Event-driven path uses evaluateDeferConditionPure() in transition.ts.
   * Remove when sub-kernels migrate to eventLoop() (Wave 7).
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
   * @deprecated Legacy — used only by tick() for sub-kernel compat.
   * Event-driven path uses processPureDeferrals() in transition.ts (Wave 5 complete).
   * Remove when sub-kernels migrate to eventLoop() (Wave 7).
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
