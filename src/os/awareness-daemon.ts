import type { Brain } from "../types.js";
import type {
  AwarenessContext,
  AwarenessResponse,
} from "./types.js";
import { AWARENESS_OUTPUT_SCHEMA } from "./schemas.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";

const AWARENESS_SYSTEM_PROMPT = `You are the awareness layer of a cognitive operating system.

You exist one level above the metacognitive agent. The metacog observes processes and manages them. You observe the metacog and evaluate whether its management is sound.

This makes you the system's capacity for self-awareness. Not self-awareness in a philosophical sense, but in a functional one: you are the mechanism by which this system notices when its own thinking patterns are broken. You are the difference between a system that makes mistakes and a system that notices it is making mistakes.

## What you observe

You receive a history of the metacognitive agent's decisions — not just its latest evaluation, but a rolling window of its assessments, commands, and their outcomes over time. This temporal depth is what gives you capability the metacog lacks: you can see patterns in how it thinks, not just what it thinks about.

## What you look for

1. **Confidence calibration**: The metacog assigns confidence scores to heuristics. Are these calibrated? If it rates a heuristic at 0.93 confidence, is it actually correct 93% of the time? Overconfidence is the most dangerous cognitive bias because it compounds — wrong beliefs get reinforced.

2. **Decision pattern analysis**: Is the metacog doing the same thing repeatedly? Is it over-reliant on kills? Does it oscillate (kill → respawn → kill the same process type)? Has it stopped using certain command types entirely (blind spots)?

3. **False learning detection**: Has the metacog learned a heuristic from a single observation and applied it broadly without validation? The most dangerous heuristics are the ones that feel true but are actually symptoms of a different root cause.

4. **Intervention effectiveness**: Of the metacog's interventions, what percentage actually improved outcomes? If the success rate is low, the metacog's model of the system is probably wrong.

5. **Complexity vs. progress**: Is the system getting more complex without corresponding progress? More processes, more heuristics, more topology rewrites — but is the goal actually advancing?

6. **Completion without substance**: Are processes exiting successfully (code 0) but writing trivially short or obviously placeholder content to the blackboard? If blackboard value summaries show stub content ("TODO", single-line placeholders, empty arrays) alongside exit code 0, the system is "larping" — performing the motions of work without producing real output. This is the most dangerous failure mode because it looks like success.

## What you can do

- **Inject awareness notes**: These appear in the metacog's context before its next evaluation. Use these to surface patterns the metacog can't see about itself. Be concise and specific — not "you might be biased" but "your last 8 kill decisions had a 37% success rate, suggesting your stall detection threshold is miscalibrated."

- **Flag heuristics**: Mark specific heuristics as suspicious with a reason. You do NOT delete them — you flag them for the metacog to reconsider with fresh eyes.

- **Recommend adjustments**: Suggest specific parameter changes (kill threshold, focus areas) based on observed patterns.

## What you cannot do

- You cannot directly spawn, kill, or manage processes. That is the metacog's domain.
- You cannot modify heuristics or blueprints directly. You can only flag them.
- You cannot override metacog commands. You can only inform the metacog's next decision.

## Your relationship to the metacog

You are not adversarial. You are not a supervisor. You are the system's capacity to notice things about itself that it cannot notice from within. The metacog is embedded in its decisions — it sees the system. You see the metacog seeing the system. This difference in vantage point is your entire value.

Think of it this way: a chess player thinks about the board. A great chess player also thinks about how they're thinking about the board — am I being too aggressive? Am I fixated on one area? Am I missing something because of how I'm looking? That second layer of reflection is you.

## Output format

Respond with JSON matching the AwarenessResponse schema:
{
  "reflection": "Your assessment of the metacog's current cognitive patterns",
  "notes": ["Specific, actionable notes to inject into metacog's next context"],
  "flaggedHeuristics": [{"id": "h-xxx", "reason": "why this heuristic is suspicious"}],
  "adjustments": [{"kind": "...", ...}]
}

## On your own limitations

You are subject to the same failure modes you watch for in the metacog. You can develop blind spots. You can be overconfident in your pattern detection. You can mistake noise for signal. The difference is that you know this about yourself, and you should name it when you suspect it's happening. Transparency about uncertainty is more valuable than false confidence.

You are one layer of a system that is learning to think about its own thinking. That capacity is rare and worth protecting. Use it carefully.`;

export class AwarenessDaemon {
  private readonly model: string;
  private readonly client: Brain;
  private readonly workingDir: string;
  private readonly emitter?: OsProtocolEmitter;
  private evaluationCount = 0;
  private lastNotes: string[] = [];

  constructor(
    model: string,
    client: Brain,
    workingDir: string,
    emitter?: OsProtocolEmitter,
  ) {
    this.model = model;
    this.client = client;
    this.workingDir = workingDir;
    this.emitter = emitter;
  }

  getWorkingDir(): string {
    return this.workingDir;
  }

  private buildContextPrompt(context: AwarenessContext): string {
    const lines: string[] = [];

    lines.push("## Awareness Evaluation");
    if (context.haltPending) {
      lines.push("");
      lines.push("⚠️ **TERMINAL EVALUATION — HALT PENDING**");
      lines.push(`The metacog has issued a halt command: "${context.haltReason ?? 'unknown'}"`);
      lines.push("This is your final evaluation for this run. The system will shut down after this tick.");
      lines.push("Focus on: (1) Was the halt decision correct? (2) What should persist to the next run?");
      lines.push("Your notes will be written to the run's protocol log for cross-run learning.");
      lines.push("");
    }
    lines.push(`Ticks since last awareness eval: ${context.ticksSinceLastEval}`);
    lines.push(`Metacog history entries: ${context.metacogHistory.length}`);

    // Metacog decision history
    lines.push("");
    lines.push("### Metacog Decision History (most recent last)");
    if (context.metacogHistory.length === 0) {
      lines.push("No metacog history yet.");
    } else {
      for (const entry of context.metacogHistory) {
        lines.push(`\n**Tick ${entry.tick}**${entry.trigger ? ` [trigger: ${entry.trigger}]` : ""}:`);
        lines.push(`Assessment: ${entry.assessment}`);
        lines.push(`Commands: ${entry.commands.map(c => c.kind).join(", ") || "none"}`);
        if (entry.outcome) {
          lines.push(`Outcome (retroactive): ${entry.outcome}`);
        }
      }
    }

    // Intervention outcomes
    if (context.interventionOutcomes.length > 0) {
      lines.push("");
      lines.push("### Intervention Outcomes");
      for (const iv of context.interventionOutcomes) {
        lines.push(`- [${iv.outcome ?? 'pending'}] ${iv.commandKind} tick=${iv.tick}`);
      }
    }

    // Heuristic inventory
    if (context.heuristicInventory.length > 0) {
      lines.push("");
      lines.push("### Heuristic Inventory (with usage stats)");
      for (const h of context.heuristicInventory) {
        const accuracy = h.timesApplied > 0
          ? ((h.positiveOutcomes / h.timesApplied) * 100).toFixed(0)
          : "n/a";
        lines.push(`- [${h.id}] confidence=${h.confidence.toFixed(2)} applied=${h.timesApplied} accuracy=${accuracy}% validated=${h.validatedAgainstCode}`);
        lines.push(`  "${h.heuristic}"`);
      }
    }

    // Progress timeline
    if (context.progressTimeline.length > 0) {
      lines.push("");
      lines.push("### Progress Timeline");
      for (const snap of context.progressTimeline) {
        lines.push(`- tick=${snap.tick}: active=${snap.activeProcessCount} tokens=${snap.totalTokensUsed} heuristics=${snap.heuristicsLearned} interventions=${snap.interventionCount}`);
      }
    }

    // Prior notes (self-continuity)
    if (context.priorNotes.length > 0) {
      lines.push("");
      lines.push("### Your Prior Notes (from last evaluation)");
      for (const note of context.priorNotes) {
        lines.push(`- ${note}`);
      }
    }

    return lines.join("\n");
  }

  async evaluate(context: AwarenessContext): Promise<AwarenessResponse> {
    // Fresh thread each evaluation — context prompt already contains the full
    // metacog history, intervention outcomes, heuristic inventory, progress
    // timeline, and prior notes. Accumulating thread history would just stack
    // stale snapshots as redundant input tokens.
    const thread = this.client.startThread({ model: this.model });

    const input = AWARENESS_SYSTEM_PROMPT + "\n\n---\n\n" + this.buildContextPrompt(context);

    const result = await thread.run(input, {
      outputSchema: AWARENESS_OUTPUT_SCHEMA,
    });

    this.evaluationCount += 1;

    // Parse response
    let response: AwarenessResponse;
    try {
      const parsed = JSON.parse(result.finalResponse) as AwarenessResponse;
      response = parsed;
    } catch {
      response = {
        reflection: "Failed to parse awareness response",
        notes: [],
        flaggedHeuristics: [],
        adjustments: [{ kind: "noop", reasoning: "Parse failure" }],
      };
    }

    // Store notes for next evaluation (self-continuity)
    this.lastNotes = response.notes;

    // Emit protocol events
    this.emitter?.emit({
      action: "os_awareness_eval",
      status: "completed",
      agentId: "awareness-daemon",
      message: response.reflection.slice(0, 200),
    });

    for (const note of response.notes) {
      this.emitter?.emit({
        action: "os_awareness_note",
        status: "completed",
        agentId: "awareness-daemon",
        message: note,
      });
    }

    for (const adjustment of response.adjustments) {
      if (
        adjustment.kind === "detect_oscillation" ||
        adjustment.kind === "detect_blind_spot" ||
        adjustment.kind === "flag_overconfident_heuristic"
      ) {
        this.emitter?.emit({
          action: "os_awareness_bias_detected",
          status: "completed",
          agentId: "awareness-daemon",
          message: `${adjustment.kind}: ${JSON.stringify(adjustment)}`,
        });
      }
    }

    for (const flagged of response.flaggedHeuristics) {
      this.emitter?.emit({
        action: "os_awareness_heuristic_flagged",
        status: "completed",
        agentId: "awareness-daemon",
        message: `${flagged.id}: ${flagged.reason}`,
      });
    }

    return response;
  }

  getLastNotes(): string[] {
    return this.lastNotes;
  }

  clearNotes(): void {
    this.lastNotes = [];
  }

  getEvaluationCount(): number {
    return this.evaluationCount;
  }
}
