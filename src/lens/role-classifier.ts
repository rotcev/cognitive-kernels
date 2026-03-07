/**
 * Classifies processes into Lens roles based on kernel process attributes.
 * Pure function — no LLM, no IO.
 *
 * Roles map directly from kernel concepts:
 * - kernel:     daemons (metacog, awareness, memory-consolidator) AND
 *               the root goal-orchestrator — the kernel's own process stack
 * - sub-kernel: backend.kind === "kernel" — a full nested kernel instance
 * - worker:     spawned lifecycle/event children doing actual goal work (LLM-backed, has parent)
 * - shell:      backend.kind === "system" — managed OS subprocess (e.g. dev server)
 */

import type { OsProcess } from "../os/types.js";
import type { LensProcessRole } from "./types.js";

export function classifyRole(
  proc: OsProcess,
  _allProcs: OsProcess[],
): LensProcessRole {
  // Daemons are kernel infrastructure
  if (proc.type === "daemon") return "kernel";

  // Root goal-orchestrator (no parent, lifecycle) is part of the kernel stack
  if (!proc.parentPid && proc.type === "lifecycle") return "kernel";

  // Nested kernel instances
  if (proc.backend?.kind === "kernel") return "sub-kernel";

  // Managed OS subprocesses (e.g. react dev server, shell commands)
  if (proc.backend?.kind === "system") return "shell";

  // Everything else: spawned LLM workers doing goal work
  return "worker";
}
