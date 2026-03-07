/**
 * Re-export all Lens types from the kernel package.
 * UI components import from here — single source of truth.
 */

// Core lens types — re-exported from kernel's lens subpath
export type {
  LensProcess,
  LensProcessRole,
  LensSelfReport,
  LensBBIOEntry,
  LensBBEntry,
  LensDagNode,
  LensEdge,
  LensMetrics,
  LensHeuristic,
  LensDeferral,
  LensTerminalLine,
  LensTerminalLevel,
  LensSnapshot,
  LensSnapshotDelta,
  LensProcessDelta,
  LensTerminalFilter,
  LensServerMessage,
  LensClientMessage,
} from "cognitive-kernels/lens";

// Cognitive events
export type {
  LensCognitiveEvent,
  LensCognitiveCategory,
} from "cognitive-kernels/lens";

// Client
export { LensClient } from "cognitive-kernels/lens";
export type {
  LensClientEventMap,
  LensClientOptions,
} from "cognitive-kernels/lens";

// ── UI-only types (not in kernel) ───────────────────────────────

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
export type RunStatus = "running" | "completed" | "failed" | "paused" | "canceled";

/** Simplified event for the event feed (derived from protocol events). */
export interface LensEvent {
  action: string;
  status: string;
  timestamp: string;
  agentName?: string;
  message: string;
}

/** Run summary for the sidebar. */
export interface LensRun {
  id: string;
  status: RunStatus;
  goal: string;
  createdAt: string;
  elapsed: number;
}

/** DAG edge as used by UI components (simplified from OsDagEdge). */
export interface LensDagEdge {
  from: string;
  to: string;
  relation: "parent-child" | "dependency";
  label?: string;
}
