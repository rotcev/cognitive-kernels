/**
 * Cognitive event extractor — transforms raw protocol event `detail` fields
 * into typed, high-level cognitive events for UI consumption.
 *
 * These events answer "WHY is the system doing this?" rather than just "WHAT
 * is happening?" — the key differentiator for product-level observability.
 */

import type { RuntimeProtocolEvent } from "../types.js";

// ── Cognitive Event Categories ───────────────────────────────────

export type LensCognitiveCategory =
  | "decision"      // system made a choice (spawn, kill, blueprint, defer)
  | "observation"   // system noticed something (awareness, self-report)
  | "intervention"  // system acted on an observation (adjustment, kill)
  | "learning"      // system updated its knowledge (heuristic, outcome)
  | "planning";     // system is organizing work (blueprint, dag)

// ── Cognitive Event Types ────────────────────────────────────────

export interface LensCognitiveEventBase {
  timestamp: string;
  category: LensCognitiveCategory;
  action: string;
  summary: string; // one-line human-readable
  agentId?: string;
  agentName?: string;
}

export interface LensCognitiveDecisionSpawn extends LensCognitiveEventBase {
  category: "decision";
  action: "spawn";
  detail: {
    trigger: string;
    objective: string;
    type: string;
    priority: number;
    model?: string;
  };
}

export interface LensCognitiveDecisionKill extends LensCognitiveEventBase {
  category: "decision";
  action: "kill";
  detail: {
    trigger: string;
    reason: string;
    targetPid?: string;
    targetName?: string;
    targetTokens?: number;
    cascade?: boolean;
  };
}

export interface LensCognitiveDecisionDefer extends LensCognitiveEventBase {
  category: "decision";
  action: "defer";
  detail: {
    deferralId: string;
    processName: string;
    condition: unknown;
    reason: string;
    maxWaitTicks?: number;
  };
}

export interface LensCognitivePlanningBlueprint extends LensCognitiveEventBase {
  category: "planning";
  action: "blueprint_selected";
  detail: {
    blueprintId: string;
    blueprintName: string;
    source: string;
    adapted: boolean;
    roles: string[];
    successRate: number;
  };
}

export interface LensCognitiveObservationAwareness extends LensCognitiveEventBase {
  category: "observation";
  action: "awareness_eval";
  detail: {
    notes: string[];
    adjustments: unknown[];
    flaggedHeuristicCount: number;
    tick: number;
  };
}

export interface LensCognitiveObservationSelfReport extends LensCognitiveEventBase {
  category: "observation";
  action: "self_report";
  detail: {
    efficiency: number;
    resourcePressure: number;
    suggestedAction: string;
    blockers: string[];
    reason?: string;
  };
}

export interface LensCognitiveInterventionMetacog extends LensCognitiveEventBase {
  category: "intervention";
  action: "metacog";
  detail: {
    assessment: string;
    commands: Array<{ kind: string; reason?: string; target?: string }>;
    citedHeuristicIds: string[];
  };
}

export interface LensCognitiveInterventionOutcome extends LensCognitiveEventBase {
  category: "learning";
  action: "intervention_outcome";
  detail: {
    commandKind: string;
    outcome: "improved" | "degraded" | "neutral";
    interventionTick: number;
    evaluationTick: number;
  };
}

export interface LensCognitiveDecisionShellSpawn extends LensCognitiveEventBase {
  category: "decision";
  action: "shell_spawn";
  detail: {
    trigger: string;
    command: string;
    args?: string[];
    objective: string;
    parentPid?: string;
  };
}

export interface LensCognitiveDecisionSubkernelSpawn extends LensCognitiveEventBase {
  category: "decision";
  action: "subkernel_spawn";
  detail: {
    trigger: string;
    goal: string;
    maxTicks?: number;
    parentPid?: string;
    priority?: number;
  };
}

export interface LensCognitiveLearningHeuristic extends LensCognitiveEventBase {
  category: "learning";
  action: "heuristic_learned";
  detail: {
    heuristic: string;
    confidence: number;
    context: string;
    scope: "global" | "local";
  };
}

export type LensCognitiveEvent =
  | LensCognitiveDecisionSpawn
  | LensCognitiveDecisionKill
  | LensCognitiveDecisionDefer
  | LensCognitiveDecisionShellSpawn
  | LensCognitiveDecisionSubkernelSpawn
  | LensCognitivePlanningBlueprint
  | LensCognitiveObservationAwareness
  | LensCognitiveObservationSelfReport
  | LensCognitiveInterventionMetacog
  | LensCognitiveInterventionOutcome
  | LensCognitiveLearningHeuristic;

// ── Extractor ────────────────────────────────────────────────────

const EXTRACTORS = new Map<string, (event: RuntimeProtocolEvent) => LensCognitiveEvent | null>();

EXTRACTORS.set("os_metacog", (event) => {
  const d = event.detail;
  if (!d?.assessment) return null;
  return {
    timestamp: event.timestamp,
    category: "intervention",
    action: "metacog",
    summary: `Metacog: ${(d.assessment as string).slice(0, 120)}`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      assessment: d.assessment as string,
      commands: (d.commands ?? []) as Array<{ kind: string; reason?: string; target?: string }>,
      citedHeuristicIds: (d.citedHeuristicIds ?? []) as string[],
    },
  };
});

EXTRACTORS.set("os_process_kill", (event) => {
  const d = event.detail;
  if (!d?.trigger) return null;
  return {
    timestamp: event.timestamp,
    category: "decision",
    action: "kill",
    summary: `Kill ${d.targetName ?? event.agentName ?? "process"}: ${d.reason ?? "no reason"}`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      trigger: d.trigger as string,
      reason: (d.reason ?? "") as string,
      targetPid: d.targetPid as string | undefined,
      targetName: d.targetName as string | undefined,
      targetTokens: d.targetTokens as number | undefined,
      cascade: d.cascade as boolean | undefined,
    },
  };
});

EXTRACTORS.set("os_process_spawn", (event) => {
  const d = event.detail;
  if (!d?.objective) return null;
  return {
    timestamp: event.timestamp,
    category: "decision",
    action: "spawn",
    summary: `Spawn "${event.agentName}": ${(d.objective as string).slice(0, 100)}`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      trigger: (d.trigger ?? "unknown") as string,
      objective: d.objective as string,
      type: (d.type ?? "unknown") as string,
      priority: (d.priority ?? 5) as number,
      model: d.model as string | undefined,
    },
  };
});

EXTRACTORS.set("os_blueprint_selected", (event) => {
  const d = event.detail;
  if (!d?.blueprintName) return null;
  return {
    timestamp: event.timestamp,
    category: "planning",
    action: "blueprint_selected",
    summary: `Blueprint "${d.blueprintName}" selected (${d.adapted ? "novel" : `${((d.successRate as number) * 100).toFixed(0)}% success`})`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      blueprintId: d.blueprintId as string,
      blueprintName: d.blueprintName as string,
      source: (d.source ?? "unknown") as string,
      adapted: (d.adapted ?? false) as boolean,
      roles: (d.roles ?? []) as string[],
      successRate: (d.successRate ?? 0) as number,
    },
  };
});

EXTRACTORS.set("os_defer", (event) => {
  const d = event.detail;
  if (!d?.deferralId) return null;
  return {
    timestamp: event.timestamp,
    category: "decision",
    action: "defer",
    summary: `Defer "${d.processName}": ${d.reason}`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      deferralId: d.deferralId as string,
      processName: d.processName as string,
      condition: d.condition,
      reason: (d.reason ?? "") as string,
      maxWaitTicks: d.maxWaitTicks as number | undefined,
    },
  };
});

EXTRACTORS.set("os_awareness_eval", (event) => {
  const d = event.detail;
  if (!d?.notes) return null;
  const notes = d.notes as string[];
  const adjustCount = (d.adjustments as unknown[]).length;
  return {
    timestamp: event.timestamp,
    category: "observation",
    action: "awareness_eval",
    summary: `Awareness: ${notes.length} note${notes.length !== 1 ? "s" : ""}${adjustCount > 0 ? `, ${adjustCount} adjustment${adjustCount !== 1 ? "s" : ""}` : ""}`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      notes,
      adjustments: d.adjustments as unknown[],
      flaggedHeuristicCount: (d.flaggedHeuristicCount ?? 0) as number,
      tick: (d.tick ?? 0) as number,
    },
  };
});

EXTRACTORS.set("os_process_event", (event) => {
  const d = event.detail;
  if (!d || d.kind !== "self_report") return null;
  return {
    timestamp: event.timestamp,
    category: "observation",
    action: "self_report",
    summary: `${event.agentName ?? "Process"} reports efficiency=${d.efficiency}, pressure=${d.resourcePressure}`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      efficiency: (d.efficiency ?? 0) as number,
      resourcePressure: (d.resourcePressure ?? 0) as number,
      suggestedAction: (d.suggestedAction ?? "") as string,
      blockers: (d.blockers ?? []) as string[],
      reason: d.reason as string | undefined,
    },
  };
});

EXTRACTORS.set("os_intervention_outcome", (event) => {
  const d = event.detail;
  if (!d?.outcome) return null;
  return {
    timestamp: event.timestamp,
    category: "learning",
    action: "intervention_outcome",
    summary: `Intervention ${d.commandKind} → ${d.outcome}`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      commandKind: d.commandKind as string,
      outcome: d.outcome as "improved" | "degraded" | "neutral",
      interventionTick: (d.interventionTick ?? 0) as number,
      evaluationTick: (d.evaluationTick ?? 0) as number,
    },
  };
});

EXTRACTORS.set("os_system_spawn", (event) => {
  const d = event.detail;
  if (!d?.command) return null;
  return {
    timestamp: event.timestamp,
    category: "decision",
    action: "shell_spawn",
    summary: `Shell "${event.agentName}": ${d.command} ${((d.args as string[]) ?? []).join(" ")}`.trim(),
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      trigger: (d.trigger ?? "unknown") as string,
      command: d.command as string,
      args: d.args as string[] | undefined,
      objective: (d.objective ?? "") as string,
      parentPid: d.parentPid as string | undefined,
    },
  };
});

EXTRACTORS.set("os_subkernel_spawn", (event) => {
  const d = event.detail;
  if (!d?.goal) return null;
  return {
    timestamp: event.timestamp,
    category: "decision",
    action: "subkernel_spawn",
    summary: `Sub-kernel "${event.agentName}": ${(d.goal as string).slice(0, 100)}`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      trigger: (d.trigger ?? "unknown") as string,
      goal: d.goal as string,
      maxTicks: d.maxTicks as number | undefined,
      parentPid: d.parentPid as string | undefined,
      priority: d.priority as number | undefined,
    },
  };
});

EXTRACTORS.set("os_heuristic_learned", (event) => {
  const d = event.detail;
  if (!d?.heuristic) return null;
  return {
    timestamp: event.timestamp,
    category: "learning",
    action: "heuristic_learned",
    summary: `Learned: "${(d.heuristic as string).slice(0, 80)}" (${((d.confidence as number) * 100).toFixed(0)}%)`,
    agentId: event.agentId,
    agentName: event.agentName,
    detail: {
      heuristic: d.heuristic as string,
      confidence: (d.confidence ?? 0) as number,
      context: (d.context ?? "") as string,
      scope: (d.scope ?? "local") as "global" | "local",
    },
  };
});

/**
 * Extract a cognitive event from a raw protocol event.
 * Returns null if the event doesn't carry cognitive detail.
 */
export function extractCognitiveEvent(event: RuntimeProtocolEvent): LensCognitiveEvent | null {
  if (!event.detail) return null;
  const extractor = EXTRACTORS.get(event.action);
  if (!extractor) return null;
  try {
    return extractor(event);
  } catch {
    return null;
  }
}
