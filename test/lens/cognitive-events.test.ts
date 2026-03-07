import { describe, it, expect } from "vitest";
import { extractCognitiveEvent } from "../../src/lens/cognitive-events.js";
import type { RuntimeProtocolEvent } from "../../src/types.js";

function makeEvent(overrides: Partial<RuntimeProtocolEvent>): RuntimeProtocolEvent {
  return {
    action: "os_metacog",
    status: "completed",
    timestamp: "2025-01-01T00:00:00.000Z",
    eventSource: "os",
    ...overrides,
  };
}

describe("extractCognitiveEvent", () => {
  it("returns null for events without detail", () => {
    const result = extractCognitiveEvent(makeEvent({ action: "os_tick" }));
    expect(result).toBeNull();
  });

  it("returns null for unknown actions with detail", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_unknown_thing",
      detail: { foo: "bar" },
    }));
    expect(result).toBeNull();
  });

  it("extracts metacog intervention", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_metacog",
      detail: {
        assessment: "System is stalling — two processes idle",
        commands: [{ kind: "kill", reason: "stalled", target: "proc-1" }],
        citedHeuristicIds: ["h-1"],
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.category).toBe("intervention");
    expect(result!.action).toBe("metacog");
    expect(result!.detail).toEqual({
      assessment: "System is stalling — two processes idle",
      commands: [{ kind: "kill", reason: "stalled", target: "proc-1" }],
      citedHeuristicIds: ["h-1"],
    });
  });

  it("extracts process kill decision", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_process_kill",
      agentId: "pid-1",
      agentName: "worker-1",
      detail: {
        trigger: "metacog",
        reason: "exceeded token budget",
        targetName: "worker-1",
        targetTokens: 50000,
        cascade: false,
      },
    }));
    expect(result!.category).toBe("decision");
    expect(result!.action).toBe("kill");
    expect(result!.summary).toContain("worker-1");
  });

  it("extracts spawn decision", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_process_spawn",
      agentName: "researcher",
      detail: {
        trigger: "metacog",
        objective: "Research the topic deeply",
        type: "lifecycle",
        priority: 7,
        model: "claude-sonnet-4-20250514",
      },
    }));
    expect(result!.category).toBe("decision");
    expect(result!.action).toBe("spawn");
    expect(result!.detail).toMatchObject({
      trigger: "metacog",
      objective: "Research the topic deeply",
      priority: 7,
    });
  });

  it("extracts blueprint selection", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_blueprint_selected",
      detail: {
        blueprintId: "bp-1",
        blueprintName: "parallel-research",
        source: "memory",
        adapted: false,
        roles: ["researcher", "synthesizer"],
        successRate: 0.85,
      },
    }));
    expect(result!.category).toBe("planning");
    expect(result!.action).toBe("blueprint_selected");
    expect(result!.summary).toContain("parallel-research");
    expect(result!.summary).toContain("85%");
  });

  it("extracts deferral", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_defer",
      detail: {
        deferralId: "def-1",
        processName: "validator",
        condition: { type: "blackboard_key", key: "results" },
        reason: "waiting for research results",
        maxWaitTicks: 10,
      },
    }));
    expect(result!.category).toBe("decision");
    expect(result!.action).toBe("defer");
    expect(result!.summary).toContain("validator");
  });

  it("extracts awareness evaluation", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_awareness_eval",
      agentName: "awareness-daemon",
      detail: {
        notes: ["System running smoothly", "Token usage is high"],
        adjustments: [{ type: "throttle", target: "worker-2" }],
        flaggedHeuristicCount: 1,
        tick: 5,
      },
    }));
    expect(result!.category).toBe("observation");
    expect(result!.action).toBe("awareness_eval");
    expect(result!.summary).toContain("2 notes");
    expect(result!.summary).toContain("1 adjustment");
  });

  it("extracts self-report", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_process_event",
      agentName: "researcher",
      detail: {
        kind: "self_report",
        efficiency: 0.7,
        resourcePressure: 0.3,
        suggestedAction: "continue",
        blockers: ["waiting on API"],
        reason: "making progress",
      },
    }));
    expect(result!.category).toBe("observation");
    expect(result!.action).toBe("self_report");
    expect(result!.summary).toContain("researcher");
    expect(result!.summary).toContain("efficiency=0.7");
  });

  it("skips non-self-report process events", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_process_event",
      detail: { kind: "something_else" },
    }));
    expect(result).toBeNull();
  });

  it("extracts intervention outcome", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_intervention_outcome",
      detail: {
        commandKind: "kill",
        outcome: "improved",
        interventionTick: 3,
        evaluationTick: 6,
      },
    }));
    expect(result!.category).toBe("learning");
    expect(result!.action).toBe("intervention_outcome");
    expect(result!.summary).toContain("improved");
  });

  it("extracts heuristic learned", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_heuristic_learned",
      detail: {
        heuristic: "Killing stalled processes early improves throughput",
        confidence: 0.7,
        context: "intervention:kill",
        scope: "local",
      },
    }));
    expect(result!.category).toBe("learning");
    expect(result!.action).toBe("heuristic_learned");
    expect(result!.summary).toContain("70%");
  });

  it("extracts shell spawn", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_system_spawn",
      agentName: "linter",
      detail: {
        trigger: "process",
        command: "eslint",
        args: ["--fix", "src/"],
        objective: "Lint and auto-fix source code",
        parentPid: "pid-parent",
      },
    }));
    expect(result!.category).toBe("decision");
    expect(result!.action).toBe("shell_spawn");
    expect(result!.summary).toContain("eslint");
    expect(result!.summary).toContain("linter");
    expect(result!.detail).toMatchObject({
      command: "eslint",
      args: ["--fix", "src/"],
      parentPid: "pid-parent",
    });
  });

  it("extracts sub-kernel spawn", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_subkernel_spawn",
      agentName: "research-kernel",
      detail: {
        trigger: "metacog",
        goal: "Deep dive into the codebase architecture",
        maxTicks: 20,
        priority: 8,
      },
    }));
    expect(result!.category).toBe("decision");
    expect(result!.action).toBe("subkernel_spawn");
    expect(result!.summary).toContain("research-kernel");
    expect(result!.summary).toContain("Deep dive");
    expect(result!.detail).toMatchObject({
      trigger: "metacog",
      goal: "Deep dive into the codebase architecture",
      maxTicks: 20,
    });
  });

  it("handles malformed detail gracefully", () => {
    const result = extractCognitiveEvent(makeEvent({
      action: "os_metacog",
      detail: { notTheRightFields: true },
    }));
    expect(result).toBeNull();
  });
});
