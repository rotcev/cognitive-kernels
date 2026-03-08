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

  // --- DAG topology ---
  dagTopology: OsDagTopology;

  // --- Deferrals (conditional spawns) ---
  deferrals: Map<string, DeferEntry>;

  // --- Metacognition ---
  pendingTriggers: OsMetacogTrigger[];

  // --- Strategy ---
  /** Active scheduling strategy ID (for outcome attribution). */
  activeStrategyId: string | null;
  /** Boot-time LLM-matched strategy IDs (cached for the run). */
  matchedStrategyIds: Set<string>;

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

    dagTopology: { nodes: [], edges: [] },

    deferrals: new Map(),

    pendingTriggers: [],

    activeStrategyId: null,
    matchedStrategyIds: new Set(),

    halted: false,
    haltReason: null,
    goalWorkDoneAt: 0,
    startTime: 0,
    consecutiveIdleTicks: 0,
    lastProcessCompletionTime: 0,
    housekeepCount: 0,
  };
}
