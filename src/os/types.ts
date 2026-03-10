// ─── Process Self-Report ─────────────────────────────────────────

export interface SelfReport {
  tick: number;
  efficiency: number;
  blockers: string[];
  resourcePressure: "low" | "medium" | "high";
  suggestedAction: "continue" | "need_help" | "should_die" | "need_more_budget";
  reason?: string;
  timestamp: string;
}

// ─── Process Capabilities ───────────────────────────────────────

export type OsProcessCapabilities = {
  /** Named observation tool sets this process can use.
   * Controls which tools are documented in the process's prompt. */
  observationTools?: string[];  // e.g., ["browser", "http", "shell"]
};

// ─── Process Backend ────────────────────────────────────────────

export type OsProcessBackend =
  | { kind: "llm" }
  | { kind: "system"; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "kernel"; goal: string; config?: Partial<OsKernelConfig>; maxTicks?: number };

// ─── Process Model ───────────────────────────────────────────────

export type OsProcessType = "daemon" | "lifecycle" | "event";

export type OsProcessState =
  | "spawned"
  | "running"
  | "sleeping"
  | "idle"
  | "suspended"
  | "checkpoint"
  | "dead";

export type OsParentDeathPolicy = "orphan" | "cascade";

export type OsRestartPolicy = "always" | "on-failure" | "never";

// ─── Executor Checkpoint State ──────────────────────────────────
// Discriminated union for executor-specific checkpoint data.
// Each backend captures its own minimal state needed for restoration context.

export type ExecutorCheckpointState =
  | { kind: "llm"; threadSessionId: string | null; turnCount: number }
  | { kind: "system"; stdoutTail?: string[] }
  | { kind: "kernel"; childRunId: string; ticksRun: number; halted: boolean };

export type OsProcessCheckpoint = {
  pid: string;
  capturedAt: string;
  conversationSummary: string;
  pendingObjectives: string[];
  artifacts: Record<string, string>;
  // Cross-run persistence fields (GAP-7)
  runId?: string;
  tickCount?: number;
  tokensUsed?: number;
  processName?: string;
  processType?: OsProcessType;
  processObjective?: string;
  processPriority?: number;
  processModel?: string;
  processWorkingDir?: string;
  parentPid?: string | null;
  backend?: OsProcessBackend;
  executorState?: ExecutorCheckpointState;
  blackboardKeysWritten?: string[];
};

export type OsProcess = {
  pid: string;
  type: OsProcessType;
  state: OsProcessState;
  name: string;
  parentPid: string | null;
  objective: string;
  priority: number;

  // Scheduling
  spawnedAt: string;
  lastActiveAt: string;
  sleepUntil?: string;
  wakeOnSignals?: string[];
  // Resource tracking
  tickCount: number;
  tokenBudget?: number;
  tokensUsed: number;

  // Execution
  model: string;
  workingDir: string;
  checkpoint?: OsProcessCheckpoint;

  // Lineage
  children: string[];
  onParentDeath: OsParentDeathPolicy;
  restartPolicy: OsRestartPolicy;

  // Termination
  exitCode?: number;
  exitReason?: string;

  // Observability — keys this process has written to the blackboard
  blackboardKeysWritten?: string[];

  // Scoped blackboard — ID of this process's private scope
  scopeId?: string;

  // Ephemeral spawn tracking
  ephemeralSpawnCount?: number;

  // Self-reported efficiency and resource state
  selfReports?: SelfReport[];

  // Strategy tracking — which scheduling strategy was active when this process last ran
  activeStrategyId?: string;

  // Backend — determines which executor handles this process (defaults to LLM)
  backend?: OsProcessBackend;

  // Completion criteria — human-readable post-conditions that define "done"
  completionCriteria?: string[];

  // Capabilities — metadata controlling prompt-level tool guidance
  capabilities?: OsProcessCapabilities;
};

export type OsProcessDescriptor = {
  type: OsProcessType;
  name: string;
  objective: string;
  priority?: number;
  model?: string;
  workingDir?: string;
  parentPid?: string | null;
  onParentDeath?: OsParentDeathPolicy;
  restartPolicy?: OsRestartPolicy;
  tokenBudget?: number;
  wakeOnSignals?: string[];
  backend?: OsProcessBackend;

  // Completion criteria — human-readable post-conditions that define "done"
  completionCriteria?: string[];

  // Capabilities — metadata controlling prompt-level tool guidance
  capabilities?: OsProcessCapabilities;
};

// ─── Process Events ──────────────────────────────────────────────

export type OsProcessEventKind =
  | "spawned"
  | "state_changed"
  | "killed"
  | "restarted"
  | "reparented"
  | "checkpoint_created"
  | "checkpoint_restored";

export type OsProcessEvent = {
  kind: OsProcessEventKind;
  pid: string;
  timestamp: string;
  details: Record<string, unknown>;
};

// ─── IPC: Blackboard ─────────────────────────────────────────────

export type OsBlackboardEntry = {
  key: string;
  value: unknown;
  writtenBy: string;
  writtenAt: string;
  version: number;
  readBy: string[];
};

// ─── IPC: Signals ────────────────────────────────────────────────

export type OsSignal = {
  name: string;
  payload?: unknown;
  emittedBy: string;
  emittedAt: string;
};

export type OsSignalSubscription = {
  pid: string;
  signalPattern: string;
};

// ─── DAG ─────────────────────────────────────────────────────────

export type OsDagNode = {
  pid: string;
  name: string;
  type: OsProcessType;
  state: OsProcessState;
  priority: number;
  parentPid: string | null;
};

export type OsDagEdge = {
  from: string;
  to: string;
  relation: "parent-child" | "dependency" | "orchestrates";
  label?: string;
};

export type OsDagTopology = {
  nodes: OsDagNode[];
  edges: OsDagEdge[];
};

export type OsDagPatch = {
  addNodes?: OsDagNode[];
  removeNodes?: string[];
  addEdges?: OsDagEdge[];
  removeEdges?: { from: string; to: string }[];
  updateNodes?: { pid: string; changes: Partial<OsDagNode> }[];
};

export type OsDagDelta = {
  since: string;
  nodesAdded: string[];
  nodesRemoved: string[];
  edgesAdded: OsDagEdge[];
  edgesRemoved: OsDagEdge[];
  nodesUpdated: string[];
};

export type OsDagMetrics = {
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  runningCount: number;
  stalledCount: number;
  deadCount: number;
};

export type OsDagSnapshot = {
  id: string;
  runId: string;
  capturedAt: string;
  trigger: string;
  topology: OsDagTopology;
  processStates: Record<string, OsProcessState>;
  metrics: OsDagMetrics;
  annotations?: string;
};

// ─── Memory / Heuristics ─────────────────────────────────────────

export type HeuristicScope = "global" | "local";

export type OsHeuristic = {
  id: string;
  heuristic: string;
  confidence: number;
  context: string;
  learnedAt: string;
  reinforcedAt: string;
  reinforcementCount: number;
  source: {
    runId: string;
    snapshotId?: string;
  };
  supersededBy?: string;
  /** Memory scope: "global" for cross-project meta-learnings, "local" for project-specific patterns. Defaults to "global" if omitted. */
  scope?: HeuristicScope;
};

// ─── Metacognitive Triggers ──────────────────────────────────────

export type OsMetacogTrigger =
  | "boot"
  | "process_failed"
  | "dag_deadlock"
  | "resource_exhaustion"
  | "ipc_timeout"
  | "priority_conflict"
  | "checkpoint_restore"
  | "goal_drift"
  | "novel_situation"
  | "tick_stall"
  | "observation_failed"
  | "process_completed";

// ─── Scheduling Strategy ─────────────────────────────────────────

export type SchedulingStrategy = {
  id: string;
  description: string;           // what this strategy does
  conditions: string[];          // when to apply: e.g. 'high_contention', 'many_lifecycle', 'synthesis_present'
  adjustments: {
    priorityBias?: Record<string, number>; // process name pattern → priority delta (e.g. { 'synthesis': -10 })
    disfavorPatterns?: string[];           // deprioritize processes whose name matches
    favorPatterns?: string[];              // boost processes whose name matches
  };
  outcomes: {
    successes: number;
    failures: number;
    avgTokensToCompletion?: number;
  };
  createdAt: number;  // Unix ms
  lastUsed: number;   // Unix ms
};

// ─── Scheduler ───────────────────────────────────────────────────

export type OsSchedulerStrategy =
  | "priority"
  | "round-robin"
  | "deadline"
  | "learned";

// ─── Metacog Context ─────────────────────────────────────────────

export type OsIpcSummary = {
  signalCount: number;
  blackboardKeyCount: number;
};

export type OsProgressMetrics = {
  goalAlignmentScore?: number;
  activeProcessCount: number;
  stalledProcessCount: number;
  totalTokensUsed: number;
  tokenBudgetRemaining?: number;
  wallTimeElapsedMs: number;
  tickCount: number;
};

// ─── Intervention Tracking ───────────────────────────────────────

export type InterventionSnapshot = {
  totalTokensUsed: number;
  activeProcessCount: number;
  stalledProcessCount: number;
  deadCount: number;
};

export interface TopologySnapshot {
  processCount: number;
  stalledRatio: number;      // fraction of processes that are stalled
  tokenVelocity: number;     // tokens/sec across all processes
  dagDepth: number;          // max depth of process dependency DAG
  idleRatio: number;         // fraction of processes that are idle
}

export interface CausalAttribution {
  factor: string;            // e.g. "stalledRatio", "processCount"
  value: number;             // value at intervention time
  correlation: "positive" | "negative" | "neutral"; // correlation with improved outcome
  confidence: number;        // 0-1
}

export type InterventionRecord = {
  id: string;
  commandKind: string;
  tick: number;
  preSnapshot: InterventionSnapshot;
  postSnapshot?: InterventionSnapshot;
  ticksToEvaluate: number;
  outcome?: 'improved' | 'degraded' | 'neutral';
  causalFactors?: TopologySnapshot;        // topology state at intervention time
  causalAttributions?: CausalAttribution[]; // computed after outcome evaluation
};

// ─── Kill Evaluation Record ──────────────────────────────────────
// GAP 1 (R6): Records the counterfactual token delta from a kill decision,
// used to calibrate kill aggressiveness over time.
export interface KillEvalRecord {
  timestamp: number;
  pid: string;
  tokenDelta: number;      // positive = tokens saved by killing
  wasPrematurely: boolean; // true if process recovered or outcome was negative
}

export interface KillCalibrationData {
  killThresholdAdjustment: number;
  killEvalHistory: KillEvalRecord[];
  savedAt: number;
}

// ─── Promotion Log ───────────────────────────────────────────────

export interface PromotionLogEntry {
  heuristicKey: string;
  heuristicValue: string;
  promotedAt: string;  // ISO timestamp
  strategyId: string;
  confidence: number;
  reinforcementCount: number;
}

// ─── Blueprint Task Record ────────────────────────────────────────
// Records the outcome of using a blueprint for a task class.
// Persisted in memory.json under 'blueprintTaskHistory'.
export interface BlueprintTaskRecord {
  blueprintId: string;
  taskClass: string[];
  success: boolean;
  tokensUsed: number;
  wallTimeMs: number;
  timestamp: number;
}

export type MetacogContext = {
  ticksSinceLastEval: number;
  trigger?: OsMetacogTrigger;
  processEvents: OsProcessEvent[];
  ipcActivity: OsIpcSummary;
  dagDelta: OsDagDelta;
  progressMetrics: OsProgressMetrics;
  relevantHeuristics: OsHeuristic[];
  /**
   * Performance recommendations from the last telemetry analysis cycle.
   * Populated only when OsKernelConfig.telemetryEnabled is true.
   * Typed inline to avoid a circular import between types.ts ↔ perf-analyzer.ts.
   */
  perfRecommendations?: Array<{
    kind: MetacogCommand['kind'];
    targetPid?: string;
    rationale: string;
    payload: Record<string, unknown>;
  }>;
  interventionHistory?: InterventionRecord[];
  systemComplexity?: number;
  /** Causal heuristics derived from intervention outcome evaluation (context starts with 'causal:'). */
  causalInsights?: OsHeuristic[];
  /** Counterfactual simulation results for recent kill actions (human-readable strings). */
  counterfactualInsights?: string[];
  /** Average tokens saved per kill, derived from recent counterfactual KillEvalRecords. */
  avgTokenSavedPerKill?: number;
  /** Kill threshold adjustment: -0.1 = more aggressive, +0.15 = more conservative, 0 = no change. */
  killThresholdAdjustment?: number;
  /** Notes from awareness daemon to guide metacog's next evaluation. */
  awarenessNotes?: string[];
  /** Heuristics flagged as suspicious by awareness daemon for metacog reconsideration. */
  flaggedHeuristics?: Array<{ id: string; reason: string }>;
  /** Current metacog focus area set by awareness daemon. */
  metacogFocus?: string;
  /** Oscillation warnings from awareness daemon. */
  oscillationWarnings?: Array<{processType: string; killCount: number; respawnCount: number; windowTicks: number}>;
  /** Blind spots detected by awareness daemon. */
  detectedBlindSpots?: Array<{unusedCommandKind: string; ticksSinceLastUse: number}>;
  /** Per-process stall durations in ms (set by watchdog on tick_stall trigger). */
  stallDurations?: Record<string, number>;
  /** Per-process inference telemetry for watchdog evaluation. */
  inferenceTelemetry?: Record<string, {
    secsSinceLastEvent: number;  // seconds since last stream event
    tokenCount: number;          // total stream events this turn
    tokenRate: number;           // events/sec
    durationSec: number;         // total turn duration
  }>;
  /** Pending deferrals waiting for conditions to be met. */
  deferrals?: Array<{ id: string; name: string; condition: DeferCondition; waitedTicks: number; reason: string }>;
  /** Summaries of blackboard values (first ~200 chars) keyed by blackboard key. */
  blackboardValueSummaries?: Record<string, string>;
  /** Process completion criteria for processes that exited code 0 this tick. */
  recentExitCriteria?: Array<{ pid: string; name: string; criteria: string[]; bbKeysWritten: string[] }>;
  /** Observation results from observer processes (blackboard keys starting with observation:). */
  observationResults?: Array<{ key: string; value: unknown }>;
  /** Seconds since last metacog wake — gives temporal awareness for self-scheduling. */
  sinceLastWakeSec?: number;
};

// ─── Awareness Daemon Types ─────────────────────────────────────

export interface MetacogHistoryEntry {
  tick: number;
  assessment: string;
  commands: MetacogCommand[];
  trigger?: OsMetacogTrigger;
  /** Filled in retroactively after 5 ticks */
  outcome?: 'improved' | 'degraded' | 'neutral' | 'unknown';
}

export interface HeuristicApplicationEntry {
  heuristicId: string;
  appliedAtTick: number;
  metacogCommandKind: string;
  interventionId?: string;
}

export interface HeuristicUsageRecord {
  id: string;
  heuristic: string;
  confidence: number;
  timesApplied: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  neutralOutcomes: number;
  lastAppliedTick: number;
  validatedAgainstCode: boolean;
}

export interface ProgressSnapshot {
  tick: number;
  activeProcessCount: number;
  totalTokensUsed: number;
  blackboardKeyCount: number;
  heuristicsLearned: number;
  interventionCount: number;
}

export interface AwarenessContext {
  /** Metacog's recent decisions (rolling window) */
  metacogHistory: MetacogHistoryEntry[];
  /** Intervention outcomes (from kernel's tracking) */
  interventionOutcomes: InterventionRecord[];
  /** Current heuristic inventory with usage stats */
  heuristicInventory: HeuristicUsageRecord[];
  /** System progress metrics over time (not just current tick) */
  progressTimeline: ProgressSnapshot[];
  /** Awareness daemon's own prior notes (self-continuity) */
  priorNotes: string[];
  /** Ticks since last awareness evaluation */
  ticksSinceLastEval: number;
  /** True when metacog has issued halt — this is a terminal evaluation */
  haltPending?: boolean;
  /** The halt reason from metacog, if halting */
  haltReason?: string;
}

export interface AwarenessResponse {
  /** The daemon's self-aware assessment of metacog's cognitive patterns */
  reflection: string;
  /** Notes to inject into metacog's next context */
  notes: string[];
  /** Heuristics flagged as suspicious (id + reason) */
  flaggedHeuristics: Array<{ id: string; reason: string }>;
  /** Recommended adjustments to metacog's behavior */
  adjustments: AwarenessAdjustment[];
}

export type AwarenessAdjustment =
  | { kind: 'adjust_kill_threshold'; delta: number; reason: string }
  | { kind: 'suggest_metacog_focus'; area: string; reason: string }
  | { kind: 'flag_overconfident_heuristic'; heuristicId: string; statedConfidence: number; observedAccuracy: number }
  | { kind: 'detect_oscillation'; processType: string; killCount: number; respawnCount: number; windowTicks: number }
  | { kind: 'detect_blind_spot'; unusedCommandKind: string; ticksSinceLastUse: number }
  | { kind: 'noop'; reasoning: string };

// ─── Process Turn Result ─────────────────────────────────────────

export type OsProcessTurnResult = {
  pid: string;
  success: boolean;
  response: string;
  tokensUsed: number;
  commands: OsProcessCommand[];
  usage?: import("../types.js").StreamEventUsage;
};

export type OsProcessCommand =
  | { kind: "sleep"; durationMs: number }
  | { kind: "idle"; wakeOnSignals?: string[] }
  | { kind: "checkpoint"; summary?: string; pendingObjectives?: string[]; artifacts?: Record<string, string> }
  | { kind: "spawn_child"; descriptor: OsProcessDescriptor; condition?: DeferCondition; maxWaitTicks?: number }
  | { kind: "spawn_graph"; nodes: SpawnGraphNode[] }
  | { kind: "bb_write"; key: string; value: unknown }
  | { kind: "bb_read"; keys: string[] }
  | { kind: "signal_emit"; signal: string; payload?: unknown }
  | { kind: "request_kernel"; question: string }
  | { kind: "exit"; code: number; reason: string }
  | { kind: "self_report"; efficiency: number; blockers: string[]; resourcePressure: "low" | "medium" | "high"; suggestedAction: "continue" | "need_help" | "should_die" | "need_more_budget"; reason?: string }
  | { kind: "spawn_ephemeral"; objective: string; name?: string; model?: string }
  | { kind: "spawn_system"; name: string; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "spawn_kernel"; name: string; goal: string; maxTicks?: number }
  | { kind: "cancel_defer"; name: string; reason: string }
  | { kind: "mcp_call"; tool: string; args: Record<string, unknown> };

// ─── Spawn Graph ───────────────────────────────────────────────

export interface SpawnGraphNode {
  name: string;
  type: "daemon" | "lifecycle" | "event";
  objective: string;
  priority?: number;
  completionCriteria?: string[];
  capabilities?: OsProcessCapabilities;
  /** Dependency expressions. Empty = spawn immediately.
   *  Process name (no colon) = wait for process to die.
   *  Blackboard key (contains colon) = wait for key to exist.
   *  Multiple entries = all conditions must be met. */
  after: string[];
}

// ─── Topology Blueprints ────────────────────────────────────────

export type BlueprintSource = "seed" | "metacog" | "orchestrator";

export type BlueprintGatingStrategy =
  | "signal-gate"
  | "checkpoint-gate"
  | "idle-gate"
  | "priority-only"
  | "custom";

export type BlueprintRole = {
  name: string;
  type: OsProcessType;
  cardinality: "one" | "per-subtask";
  priorityOffset: number;
  objectiveTemplate: string;
  wakeCondition?: { signals?: string[] };
  spawnTiming: "immediate" | "after-dependencies";
  capabilities?: OsProcessCapabilities;
};

export type BlueprintTagStats = {
  alpha: number;
  beta: number;
  observations: number;
};

export type BlueprintStats = {
  uses: number;
  successes: number;
  failures: number;
  avgTokenEfficiency: number;
  avgWallTimeMs: number;
  lastUsedAt: string;
  alpha: number;
  beta: number;
  tagStats: Record<string, BlueprintTagStats>;
};

export type TopologyBlueprint = {
  id: string;
  name: string;
  description: string;
  source: BlueprintSource;

  applicability: {
    goalPatterns: string[];
    minSubtasks: number;
    maxSubtasks: number;
    requiresSequencing: boolean;
  };

  roles: BlueprintRole[];
  gatingStrategy: BlueprintGatingStrategy;
  priorityStrategy: string;
  customGatingInstructions?: string;

  stats: BlueprintStats;
  learnedAt: string;
  evolvedFrom?: string;
};

export type BlueprintOutcome = {
  blueprintId: string;
  runId: string;
  success: boolean;
  completionScore: number;
  goalTags: string[];
  completedProcessCount: number;
  totalTokens: number;
  wallTimeMs: number;
  processCount: number;
  haltReason: string;
};

export type SelectedBlueprintInfo = {
  id: string;
  name: string;
  source: BlueprintSource;
  successRate: number;
  instantiatedRoles: string[];
  adapted: boolean;
};

// ─── Blueprint Mutation ─────────────────────────────────────────

export type BlueprintMutation = {
  namePrefix?: string;
  roleChanges?: Array<{
    action: "add" | "modify" | "remove";
    roleName: string;
    template?: string;
    type?: string;
    priority?: number;
  }>;
  gatingChange?: string;
};

// ─── Metacognitive Commands ─────────────────────────────────────

export type MetacogCommand =
  | { kind: "spawn"; descriptor: OsProcessDescriptor }
  | { kind: "kill"; pid: string; cascade: boolean; reason: string }
  | { kind: "reprioritize"; pid: string; priority: number }
  | { kind: "learn"; heuristic: string; confidence: number; context: string; scope?: HeuristicScope }
  | { kind: "halt"; status: "achieved" | "unachievable" | "stalled"; summary: string }
  | { kind: "define_blueprint"; blueprint: Omit<TopologyBlueprint, "id" | "stats" | "learnedAt"> }
  | { kind: "fork"; pid: string; newObjective?: string; newPriority?: number }
  | { kind: "evolve_blueprint"; sourceBlueprintId: string; mutations: BlueprintMutation; description: string }
  | { kind: "record_strategy"; strategy: SchedulingStrategy }
  | { kind: "record_strategy"; strategyName: string; outcome: "success" | "failure"; context?: string }
  | { kind: "noop"; reasoning: string }
  | { kind: "delegate_evaluation"; evaluationScope: string; priority?: number }
  | { kind: "spawn_system"; name: string; command: string; args?: string[]; env?: Record<string, string>; objective: string; priority?: number }
  | { kind: "spawn_kernel"; name: string; goal: string; priority?: number; maxTicks?: number }
  | { kind: "defer"; descriptor: OsProcessDescriptor; condition: DeferCondition; reason: string; maxWaitTicks?: number }
  | { kind: "cancel_defer"; name: string; reason: string }
  | { kind: "mcp_call"; tool: string; args: Record<string, unknown> };

// ─── Deferrals ──────────────────────────────────────────────────

export type DeferCondition =
  | { type: "blackboard_key_exists"; key: string }
  | { type: "blackboard_key_match"; key: string; value: unknown }
  | { type: "blackboard_value_contains"; key: string; substring: string }
  | { type: "process_dead"; pid: string }
  | { type: "process_dead_by_name"; name: string }
  | { type: "all_of"; conditions: DeferCondition[] }
  | { type: "any_of"; conditions: DeferCondition[] };

export interface DeferEntry {
  id: string;
  descriptor: OsProcessDescriptor;
  condition: DeferCondition;
  registeredAt: string;
  /** Epoch ms for wall-clock expiry calculation. */
  registeredAtMs?: number;
  registeredByTick: number;
  registeredByPid?: string;
  reason: string;
  maxWaitTicks?: number;
  /** Wall-clock expiry in ms. Whichever of maxWaitTicks/maxWaitMs fires first wins. */
  maxWaitMs?: number;
}

export type MetacogResponse = {
  assessment: string;
  commands: MetacogCommand[];
  /** IDs of heuristics that influenced this evaluation's decisions. Used for credit assignment. */
  citedHeuristicIds?: string[];
  /** Metacog-requested delay (ms) until next evaluation. The kernel caps this at metacogIntervalMs. */
  nextWakeMs?: number;
};

// ─── Configuration ───────────────────────────────────────────────

export type OsKernelConfig = {
  tickIntervalMs: number;
  maxConcurrentProcesses: number;
  metacogCadence: number;
  metacogModel: string;
  processModel: string;
  tokenBudget: number;
  /** When false (default), per-process token budgets are not enforced — processes run until the global budget is exhausted. */
  processTokenBudgetEnabled?: boolean;
  wallTimeLimitMs: number;
  /** When true, TelemetryCollector runs each tick and PerfAnalyzer output is injected into MetacogContext. */
  telemetryEnabled?: boolean;
  /** Cadences at which the kernel emits periodic tick:N signals (e.g. [1, 5, 10] emits tick:1 every tick, tick:5 every 5th, etc.). */
  tickSignalCadences?: number[];
  /** Set when this kernel is a child of another kernel — prevents sub-kernel spawning. */
  parentKernelId?: string;
  /** Watchdog interval for detecting tick stalls (default: 60000ms = 1 min). */
  watchdogIntervalMs?: number;
  /** Housekeeping timer interval (default: 500ms). */
  housekeepIntervalMs?: number;
  /** Metacog evaluation timer interval (default: 15000ms). */
  metacogIntervalMs?: number;
  /** Snapshot write timer interval (default: 10000ms). */
  snapshotIntervalMs?: number;
  /** Grace period before halting when only daemons remain (default: 30000ms).
   *  Gives metacog time to detect premature orchestrator exit and respawn workers. */
  goalCompleteGracePeriodMs?: number;
};

export type OsSchedulerConfig = {
  strategy: OsSchedulerStrategy;
  maxConcurrentProcesses: number;
  tickIntervalMs: number;
  metacogCadence: number;
  metacogTriggers: OsMetacogTrigger[];
};

export type OsIpcConfig = {
  blackboardMaxKeys: number;
};

export type OsMemoryConfig = {
  snapshotCadence: number;
  heuristicDecayRate: number;
  heuristicPruneThreshold: number;
  maxHeuristics: number;
  consolidationIntervalTicks: number;
  basePath: string;
};

export type OsProcessesConfig = {
  maxDepth: number;
  maxTotalProcesses: number;
  defaultPriority: number;
};

export type OsSystemProcessConfig = {
  enabled: boolean;
  maxSystemProcesses: number;
  stdoutBufferLines: number;
};

export type OsChildKernelConfig = {
  enabled: boolean;
  maxChildKernels: number;
  defaultMaxTicks: number;
  ticksPerParentTurn: number;
  maxDepth: number;
};

export type OsAwarenessConfig = {
  enabled: boolean;
  /** Evaluate every N metacog evaluations (default: 5) */
  cadence: number;
  /** Rolling window size for metacog history (default: 100) */
  historyWindow: number;
  /** Model for awareness agent (default: claude-sonnet-4-6) */
  model: string;
};

export type OsObservationConfig = {
  enabled: boolean;
  browserMcp: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    maxInstances: number;
  };
  defaultModel: string;
};

export type OsConfig = {
  enabled: boolean;
  kernel: OsKernelConfig;
  scheduler: OsSchedulerConfig;
  ipc: OsIpcConfig;
  memory: OsMemoryConfig;
  processes: OsProcessesConfig;
  ephemeral: OsEphemeralConfig;
  systemProcess: OsSystemProcessConfig;
  childKernel: OsChildKernelConfig;
  awareness: OsAwarenessConfig;
  observation: OsObservationConfig;
};

// ─── System Snapshot ─────────────────────────────────────────────

export type OsSystemSnapshot = {
  runId: string;
  tickCount: number;
  goal: string;
  processes: OsProcess[];
  dagTopology: OsDagTopology;
  dagMetrics: OsDagMetrics;
  ipcSummary: OsIpcSummary;
  progressMetrics: OsProgressMetrics;
  recentEvents: OsProcessEvent[];
  recentHeuristics: OsHeuristic[];
  blackboard?: Record<string, unknown>;
  /** Maps blackboard key → writer process name (populated from writtenBy PID). */
  blackboardWriters?: Record<string, string>;
  selectedBlueprint?: SelectedBlueprintInfo;
  deferrals?: Array<{ id: string; name: string; condition: DeferCondition; waitedTicks: number; reason: string }>;
};

// ─── Ephemeral Processes ─────────────────────────────────────────

export type OsEphemeralResult = {
  ephemeralId: string;
  name?: string;
  success: boolean;
  response: string;
  error?: string;
  durationMs: number;
  model: string;
  tokensEstimate: number;
};

export type OsEphemeralConfig = {
  enabled: boolean;
  maxPerProcess: number;
  maxConcurrent: number;
  defaultModel: string;
};

// ─── Telemetry ───────────────────────────────────────────────────

export interface ProcessMetrics {
  pid: string;
  /** Human-readable name from OsProcess.name — populated by TelemetryCollector.onTick(). */
  name?: string;
  tokensUsed: number;
  outputLineCount: number;
  tokensPerOutputLine: number;
  schedulingWaitMs: number;
  createdAt: number;
  firstActivatedAt: number | null;
  completedAt: number | null;
  /** Process priority — populated by TelemetryCollector.onTick(). */
  priority?: number;
}

export interface CheckpointMetrics {
  pid: string;
  count: number;
  totalOverheadMs: number;
}

export interface ForkDivergence {
  parentPid: string;
  childPid: string;
  divergenceScore: number; // 0 = identical, 1 = completely different
}

export interface TelemetrySnapshot {
  timestamp: number;
  processMetrics: Record<string, ProcessMetrics>;
  checkpointMetrics: Record<string, CheckpointMetrics>;
  forkDivergence: ForkDivergence[];
  blueprintUsage: Record<string, { count: number; avgGoalComplexity: number; }>;
}

// ─── Valid State Transitions ─────────────────────────────────────

export const VALID_STATE_TRANSITIONS: Record<OsProcessState, OsProcessState[]> = {
  spawned: ["running", "dead"],
  running: ["sleeping", "idle", "suspended", "checkpoint", "dead"],
  sleeping: ["running", "dead"],
  idle: ["running", "dead"],
  suspended: ["running", "dead"],
  checkpoint: ["running", "sleeping", "idle", "dead"],
  dead: [],
};
