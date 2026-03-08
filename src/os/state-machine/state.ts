/**
 * KernelState — the complete deterministic state of the kernel.
 *
 * This is the INPUT side of the state machine:
 *   transition(state, event) → (state', effects)
 *
 * Contains only plain data — no promises, timers, mutexes, or I/O handles.
 * The kernel class bridges between its runtime state and this snapshot.
 *
 * Every field here is something the transition function reads or writes.
 * If it's not needed for a transition decision, it doesn't belong here.
 */

import type {
  OsProcess,
  OsConfig,
  OsDagTopology,
  DeferEntry,
  OsMetacogTrigger,
  OsSchedulerStrategy,
  OsHeuristic,
  SchedulingStrategy,
  MetacogHistoryEntry,
} from "../types.js";

/** The deterministic kernel state — everything needed to compute the next transition. */
export type KernelState = {
  // --- Identity ---
  goal: string;
  runId: string;
  config: OsConfig;

  // --- Process table (plain data) ---
  processes: Map<string, OsProcess>;
  /** PIDs currently executing (LLM inference in flight). */
  inflight: Set<string>;
  /** Number of ephemeral scouts currently executing. */
  activeEphemeralCount: number;

  // --- IPC / Blackboard ---
  blackboard: Map<string, BlackboardEntry>;

  // --- Scheduling ---
  tickCount: number;
  schedulerStrategy: OsSchedulerStrategy;
  schedulerMaxConcurrent: number;
  schedulerRoundRobinIndex: number;
  schedulerHeuristics: OsHeuristic[];
  currentStrategies: SchedulingStrategy[];

  // --- DAG topology ---
  dagTopology: OsDagTopology;

  // --- Deferrals (conditional spawns) ---
  deferrals: Map<string, DeferEntry>;

  // --- Metacognition ---
  pendingTriggers: OsMetacogTrigger[];
  /** Tick count at which metacog last evaluated — used for goal_drift detection. */
  lastMetacogTick: number;
  /** Count of metacog evaluations — used for awareness cadence. */
  metacogEvalCount: number;

  // --- Strategy ---
  /** Active scheduling strategy ID (for outcome attribution). */
  activeStrategyId: string | null;
  /** Boot-time LLM-matched strategy IDs (cached for the run). */
  matchedStrategyIds: Set<string>;

  // --- Metacog coordination (replaces kernel flags) ---
  /** Whether a metacog evaluation is currently in flight. */
  metacogInflight: boolean;
  /** Wall-clock ms of last metacog wake. */
  lastMetacogWakeAt: number;
  /** Rolling history of metacog evaluations. */
  metacogHistory: MetacogHistoryEntry[];

  // --- Awareness state ---
  awarenessNotes: string[];
  oscillationWarnings: any[];
  blindSpots: any[];
  metacogFocus: string | null;

  // --- Drain tracking ---
  /** PIDs currently being drained (graceful shutdown). */
  drainingPids: Set<string>;

  // --- Kill calibration ---
  killThresholdAdjustment: number;
  killEvalHistory: any[];

  // --- Blueprint tracking ---
  selectedBlueprintInfo: any | null;

  // --- Telemetry ---
  ephemeralStats: {
    spawns: number;
    successes: number;
    failures: number;
    totalDurationMs: number;
  };
  heuristicApplicationLog: any[];

  // --- Halt logic ---
  halted: boolean;
  haltReason: string | null;
  /** Wall-clock ms when only daemons remained (grace period start). 0 = not started. */
  goalWorkDoneAt: number;
  startTime: number;
  consecutiveIdleTicks: number;
  lastProcessCompletionTime: number;
  housekeepCount: number;
};

/** Plain-data blackboard entry for state snapshots. */
export type BlackboardEntry = {
  value: unknown;
  writtenBy: string | null;
  version: number;
};

/** Create the initial kernel state before any events are processed. */
export function initialState(config: OsConfig, runId: string): KernelState {
  return {
    goal: "",
    runId,
    config,

    processes: new Map(),
    inflight: new Set(),
    activeEphemeralCount: 0,

    blackboard: new Map(),

    tickCount: 0,
    schedulerStrategy: config.scheduler.strategy,
    schedulerMaxConcurrent: config.scheduler.maxConcurrentProcesses,
    schedulerRoundRobinIndex: 0,
    schedulerHeuristics: [],
    currentStrategies: [],

    dagTopology: { nodes: [], edges: [] },

    deferrals: new Map(),

    pendingTriggers: [],
    lastMetacogTick: 0,
    metacogEvalCount: 0,

    activeStrategyId: null,
    matchedStrategyIds: new Set(),

    metacogInflight: false,
    lastMetacogWakeAt: 0,
    metacogHistory: [],

    awarenessNotes: [],
    oscillationWarnings: [],
    blindSpots: [],
    metacogFocus: null,

    drainingPids: new Set(),

    killThresholdAdjustment: 0,
    killEvalHistory: [],

    selectedBlueprintInfo: null,

    ephemeralStats: { spawns: 0, successes: 0, failures: 0, totalDurationMs: 0 },
    heuristicApplicationLog: [],

    halted: false,
    haltReason: null,
    goalWorkDoneAt: 0,
    startTime: 0,
    consecutiveIdleTicks: 0,
    lastProcessCompletionTime: 0,
    housekeepCount: 0,
  };
}
