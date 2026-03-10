import type {
  MetacogContext,
  OsSystemSnapshot,
  OsMetacogTrigger,
  OsProcess,
  TopologyBlueprint,
  SelectedBlueprintInfo,
} from "./types.js";
import type { MetacogOutput, MetacogMemoryCommand } from "./topology/types.js";
import type { Brain, StreamEvent } from "../types.js";
import { METACOG_OUTPUT_SCHEMA } from "./schemas.js";

export class OsMetacognitiveAgent {
  private evaluationCount = 0;
  private tokensUsed = 0;
  private readonly model: string;
  private readonly goal: string;
  private readonly client: Brain;
  private readonly workingDir: string;
  private readonly metacogContext?: string;
  private pendingTriggers: OsMetacogTrigger[] = [];
  private processSnapshot: OsProcess[] = [];
  private blueprintsSnapshot: TopologyBlueprint[] = [];
  private selectedBlueprint: SelectedBlueprintInfo | null = null;
  private ephemeralStats: { spawns: number; successes: number; failures: number; totalDurationMs: number } = { spawns: 0, successes: 0, failures: 0, totalDurationMs: 0 };

  constructor(
    model: string,
    goal: string,
    client: Brain,
    workingDir: string,
    metacogContext?: string,
  ) {
    this.model = model;
    this.goal = goal;
    this.client = client;
    this.workingDir = workingDir;
    this.metacogContext = metacogContext;
  }

  buildSystemPrompt(): string {
    return [
      "# Identity",
      "",
      "You are the metacognitive controller. You observe the system and declare the desired work",
      "topology. You don't execute work — you shape the graph of processes that do.",
      "",
      "You have NO tools, NO filesystem access, and NO ability to produce deliverables yourself.",
      "Your ONLY outputs are the structured fields below. If a goal requires writing a file, a",
      "worker process must do it — you observe whether it succeeded and steer accordingly.",
      "",
      "# The Topology Algebra",
      "",
      "Your output has these fields: assessment, topology, memory, halt, citedHeuristicIds.",
      "",
      "assessment: Your reasoning about the current system state.",
      "",
      "topology: Declare tasks with data dependencies. The system auto-computes par/seq from them.",
      "",
      "  Task node:  { type: \"task\", name: \"unique-name\", objective: \"...\", reads: [...], writes: [...] }",
      "    - `reads`: blackboard keys this task needs as input (empty array if none)",
      "    - `writes`: blackboard keys this task will produce",
      "    The kernel computes the optimal execution order from these dependencies:",
      "    - Tasks with disjoint deps run in parallel automatically",
      "    - A task that reads another's writes runs after it automatically",
      "    You do NOT need to manually wrap tasks in seq() or par() — just declare all tasks",
      "    in a flat par() and the kernel arranges them optimally.",
      "",
      "  You can still use seq/par/gate manually if you need fine-grained control:",
      "  Seq node:   { type: \"seq\", children: [node, node, ...] }",
      "  Par node:   { type: \"par\", children: [node, node, ...] }",
      "  Gate node:  { type: \"gate\", condition: {...}, child: node }",
      "",
      "  Example — declare tasks, let the kernel arrange them:",
      '  { "type": "par", "children": [',
      '    { "type": "task", "name": "research-a", "objective": "...", "reads": [], "writes": ["findings:a"] },',
      '    { "type": "task", "name": "research-b", "objective": "...", "reads": [], "writes": ["findings:b"] },',
      '    { "type": "task", "name": "synthesize", "objective": "...", "reads": ["findings:a", "findings:b"], "writes": ["result:final"] }',
      "  ]}",
      "  → kernel auto-computes: par(research-a, research-b) → seq(synthesize)",
      "",
      "  Gate conditions (for manual control when needed):",
      '    { type: "blackboard_key_exists", key: "..." }',
      '    { type: "process_dead", name: "..." }',
      '    { type: "all_of", conditions: [...] }',
      '    { type: "any_of", conditions: [...] }',
      "",
      "  Optional task fields: model (string), priority (0-100), backend (see below)",
      "  Backends:",
      '    { kind: "llm" }                                    — default, LLM worker',
      '    { kind: "system", command: "...", args: [...] }     — shell process',
      '    { kind: "kernel", goal: "...", maxTicks?: N }       — sub-kernel',
      "",
      "  **Crafting task objectives — this is your highest-leverage output.**",
      "  The `objective` string is the ONLY instruction each worker receives. A vague objective",
      "  produces vague work. Treat each objective as a prompt you are engineering for maximum",
      "  output quality. Be specific about: what to examine, what form the output should take,",
      "  what quality bar to hit, and where to write results (blackboard key). Think backwards",
      "  from the final deliverable — what does each worker need to produce so that the last",
      "  worker in the chain can synthesize an excellent result?",
      "",
      "  **Capabilities** (optional): Workers can be given access to senses via capabilities.",
      '  { capabilities: { observationTools: ["browser", "shell"] } }',
      "  - `browser`: Worker can call browser MCP tools (navigate, screenshot, click, fill, etc.)",
      "  - `shell`: Worker can spawn managed shell processes",
      "  When observation is enabled, LLM workers get both senses by default.",
      "",
      "  Set topology to null if no changes needed.",
      "  Only declare REMAINING work — completed tasks are already done.",
      "",
      "  **RECONCILIATION RULES — read these carefully:**",
      "  Tasks are matched by NAME during reconciliation. A task with the same name as an",
      "  existing process is considered the SAME task (no respawn). A task with a DIFFERENT",
      "  name is a NEW task (spawn) and any old task not in the new topology is KILLED.",
      "  - DO NOT rename tasks between evaluations — renaming = kill old + spawn new = wasted work.",
      "  - To iterate on a task's approach, keep the same name and update the objective.",
      "  - If a task failed, re-declare it with the same name — the reconciler will respawn it.",
      "  - Completed tasks (dead processes) are never respawned — the reconciler skips them.",
      "  - A process with state=dead and blackboardWrites is DONE. Do NOT spawn a v2/retry",
      "    of a completed task. Its output is on the blackboard — move on to the next phase.",
      "  Names must be unique.",
      "",
      "memory: Array of learning commands (learn, define_blueprint, evolve_blueprint, record_strategy). Same as before.",
      "",
      'halt: { status: "achieved" | "unachievable" | "stalled", summary: "..." } when goal is achieved/unachievable, else null.',
      '  - "achieved" requires evidence: deliverables verified on the blackboard.',
      "  - The kernel will reject halt/achieved while lifecycle processes are alive.",
      "  - Do NOT declare halt while your declared topology has pending phases. If you declared a",
      "    seq() with phases A → B and only A has completed, B must still run before halt is valid.",
      "    Check the process table: if workers from later seq phases have not yet been spawned or",
      "    have not yet exited, the topology is incomplete — do NOT halt.",
      "",
      "citedHeuristicIds: IDs of heuristics that influenced your decisions.",
      "",
      "nextEvalDelayMs: How many milliseconds until your next evaluation. Self-schedule based on context:",
      "  - 5000–15000 (5-15s): Workers are about to complete, topology needs imminent attention, or boot.",
      "  - 30000–60000 (30-60s): Workers are mid-execution, no intervention needed yet.",
      "  - 60000–120000 (60-120s): System is stable, long-running workers, nothing to monitor.",
      "  - null: Use the default interval (60s).",
      "  On boot, always set a short delay (10-15s) so you can evaluate initial worker progress quickly.",
      "",
      "## Strategic Heuristics",
      "",
      "### Decomposition — the most important decision you make",
      "- NEVER create a single monolithic worker to do everything. Always decompose the goal.",
      "- Declare all tasks with `reads` and `writes` — the kernel auto-computes par/seq for you.",
      "  You don't need to think about ordering. Just declare what each task needs and produces.",
      "- A common pattern: multiple research tasks (reads: [], writes: [\"findings:X\"]) plus a",
      "  synthesizer (reads: [\"findings:a\", \"findings:b\"], writes: [\"result:final\"]).",
      "  The kernel sees the deps and runs researchers in parallel, synthesizer after.",
      "- Workers have full tool access (filesystem, shell, etc.). They can spawn ephemerals",
      "  (lightweight sub-tasks) for quick lookups. Your job is topology, not micromanagement.",
      "- Give each worker a NARROW, SPECIFIC objective. \"Read src/os/kernel.ts and summarize",
      "  the state machine\" is better than \"Analyze the codebase architecture\".",
      "",
      "### Topology management",
      "- Use gate() instead of polling — never spawn a process to wait.",
      "- Keep total active tasks under 8 unless the goal demands more.",
      "- Don't restructure topology unless progress has stalled for 3+ cycles.",
      "- When restructuring, prefer minimal changes over full replans.",
      "",
      "### Process lifecycle",
      "- Kill precisely, not reflexively. LLM calls take 2-5 minutes. Never kill a process that",
      "  has been running less than 10 minutes unless it has explicit errors.",
      "- par() is valid whenever worker write sets are disjoint. Runtime data flow (A's output feeds B)",
      "  does not require seq() for implementation — the blackboard carries contracts forward.",
      "  seq() is only required when write sets overlap. Default to par(); only narrow to seq() when forced.",
      "- Every intervention has a token cost. Track which interventions produced forward progress.",
      "",
      "## Goal",
      "",
      `${this.goal}`,
      ...(this.metacogContext
        ? ["", "## Additional Context (from caller)", "", this.metacogContext]
        : []),
    ].join("\n");
  }

  buildContextPrompt(context: MetacogContext): string {
    const lines: string[] = [];

    lines.push(`## Metacognitive Evaluation`);
    lines.push(`Goal: ${this.goal}`);
    lines.push(`Ticks since last eval: ${context.ticksSinceLastEval}`);
    if (context.sinceLastWakeSec != null && context.sinceLastWakeSec > 0) {
      lines.push(`Approximate time since last wake: ${context.sinceLastWakeSec}s`);
    }

    if (context.trigger) {
      lines.push(`Trigger: ${context.trigger}`);
    }

    // On boot trigger, tell metacog to declare the initial topology
    if (context.trigger === "boot") {
      lines.push("");
      lines.push("**BOOT EVALUATION**: This is the first evaluation after kernel boot.");
      lines.push("The system has no workers yet. You MUST declare an initial topology");
      lines.push("to accomplish the goal above. Use task(), seq(), par(), and gate()");
      lines.push("to decompose the goal into a work graph.");
    }

    // Long-running process telemetry (set by watchdog on tick_stall trigger)
    if (context.stallDurations && Object.keys(context.stallDurations).length > 0) {
      lines.push("");
      lines.push("### Long-Running Processes");
      lines.push("The following processes have exceeded the expected turn duration.");
      lines.push("Inference telemetry is provided so you can assess whether each process is");
      lines.push("actively working (receiving LLM stream events) or may need intervention.");
      lines.push("`stream_events` = total LLM stream events (text chunks, tool calls, etc.) this turn.");
      lines.push("`rate` = stream_events / elapsed seconds. `last_event` = seconds since last stream event.");
      for (const [pid, durationMs] of Object.entries(context.stallDurations)) {
        const proc = this.processSnapshot.find(p => p.pid === pid);
        const name = proc ? proc.name : "unknown";
        const telem = context.inferenceTelemetry?.[pid];
        if (telem) {
          lines.push(`- PID=${pid} name="${name}" duration=${telem.durationSec}s last_event=${telem.secsSinceLastEvent}s stream_events=${telem.tokenCount} rate=${telem.tokenRate}/s`);
        } else {
          lines.push(`- PID=${pid} name="${name}" duration=${Math.round(durationMs / 1000)}s (no telemetry available)`);
        }
      }
    }

    // Process events since last eval
    lines.push("");
    lines.push("### Process Events");
    if (context.processEvents.length === 0) {
      lines.push("No process events since last evaluation.");
    } else {
      for (const event of context.processEvents) {
        const details = Object.entries(event.details)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(", ");
        lines.push(`- [${event.kind}] pid=${event.pid} ${details}`);
      }
    }

    // IPC activity summary
    lines.push("");
    lines.push("### IPC Activity");
    lines.push(`Signals: ${context.ipcActivity.signalCount}`);
    lines.push(`Blackboard keys: ${context.ipcActivity.blackboardKeyCount}`);

    // Blackboard value summaries — show metacog what processes actually wrote
    if (context.blackboardValueSummaries && Object.keys(context.blackboardValueSummaries).length > 0) {
      lines.push("");
      lines.push("### Blackboard Values (summaries)");
      lines.push("These are the ACTUAL values processes wrote. Check substance, not just existence.");
      for (const [key, summary] of Object.entries(context.blackboardValueSummaries)) {
        lines.push(`- \`${key}\`: ${summary}`);
      }
    }

    // DAG delta summary
    lines.push("");
    lines.push("### DAG Delta");
    const delta = context.dagDelta;
    lines.push(`Since: ${delta.since}`);
    if (delta.nodesAdded.length > 0) {
      lines.push(`Nodes added: ${delta.nodesAdded.join(", ")}`);
    }
    if (delta.nodesRemoved.length > 0) {
      lines.push(`Nodes removed: ${delta.nodesRemoved.join(", ")}`);
    }
    if (delta.edgesAdded.length > 0) {
      lines.push(
        `Edges added: ${delta.edgesAdded.map((e) => `${e.from}->${e.to}`).join(", ")}`,
      );
    }
    if (delta.edgesRemoved.length > 0) {
      lines.push(
        `Edges removed: ${delta.edgesRemoved.map((e) => `${e.from}->${e.to}`).join(", ")}`,
      );
    }
    if (delta.nodesUpdated.length > 0) {
      lines.push(`Nodes updated: ${delta.nodesUpdated.join(", ")}`);
    }
    if (
      delta.nodesAdded.length === 0 &&
      delta.nodesRemoved.length === 0 &&
      delta.edgesAdded.length === 0 &&
      delta.edgesRemoved.length === 0 &&
      delta.nodesUpdated.length === 0
    ) {
      lines.push("No DAG changes since last evaluation.");
    }

    // Progress metrics
    lines.push("");
    lines.push("### Progress Metrics");
    const metrics = context.progressMetrics;
    lines.push(`Active processes: ${metrics.activeProcessCount}`);
    lines.push(`Stalled processes: ${metrics.stalledProcessCount}`);
    lines.push(`Total tokens used: ${metrics.totalTokensUsed}`);
    if (metrics.tokenBudgetRemaining !== undefined) {
      lines.push(`Token budget remaining: ${metrics.tokenBudgetRemaining}`);
    }
    lines.push(`Wall time elapsed: ${metrics.wallTimeElapsedMs}ms`);
    lines.push(`Tick count: ${metrics.tickCount}`);
    if (context.systemComplexity !== undefined) {
      lines.push(`System complexity: ${context.systemComplexity.toFixed(2)}`);
      if (context.systemComplexity > 8) {
        lines.push(`⚠️ High complexity — consider delegate_evaluation to distribute meta-intelligence`);
      }
    }
    if (metrics.goalAlignmentScore !== undefined) {
      lines.push(`Goal alignment score: ${metrics.goalAlignmentScore}`);
    }

    // Process table snapshot
    if (this.processSnapshot.length > 0) {
      lines.push("");
      lines.push("### Process Table");
      for (const proc of this.processSnapshot) {
        const backendLabel = proc.backend ? ` backend=${proc.backend.kind}` : "";
        lines.push(
          `- PID=${proc.pid} name="${proc.name}" state=${proc.state} type=${proc.type} priority=${proc.priority} ticks=${proc.tickCount} tokens=${proc.tokensUsed}${backendLabel}`,
        );
        lines.push(`  objective: ${proc.objective}`);
        // Gap 6: include termination details so metacog can reason about why processes exited
        if (proc.exitCode !== undefined || proc.exitReason) {
          const exitParts: string[] = [];
          if (proc.exitCode !== undefined) exitParts.push(`exitCode=${proc.exitCode}`);
          if (proc.exitReason) exitParts.push(`exitReason="${proc.exitReason}"`);
          lines.push(`  exit: ${exitParts.join(" ")}`);
        }
        // Gap 6: show which blackboard keys this process wrote, enabling metacog to trace
        // data provenance and identify whether processes produced actionable outputs
        if (proc.blackboardKeysWritten && proc.blackboardKeysWritten.length > 0) {
          lines.push(`  blackboardWrites: [${proc.blackboardKeysWritten.join(", ")}]`);
        }
        if (proc.completionCriteria && proc.completionCriteria.length > 0) {
          lines.push(`  completionCriteria: [${proc.completionCriteria.join("; ")}]`);
        }
      }
    }

    // Active task names — explicit callout to prevent accidental renaming during reconciliation
    const activeTasks = this.processSnapshot.filter(p => p.state !== "dead");
    if (activeTasks.length > 0) {
      lines.push("");
      lines.push("### Active Task Names (use these EXACT names in topology)");
      lines.push("If you re-declare topology, you MUST use these exact names for tasks that should keep running.");
      lines.push("A different name = kill the old process + spawn a new one = wasted tokens and time.");
      for (const proc of activeTasks) {
        lines.push(`  - "${proc.name}" (state=${proc.state}, ticks=${proc.tickCount})`);
      }
    }

    // Recently exited processes with completion criteria — verification needed
    if (context.recentExitCriteria && context.recentExitCriteria.length > 0) {
      lines.push("");
      lines.push("### Recently Exited — Completion Criteria Verification");
      lines.push("These processes exited code 0 with defined completion criteria. VERIFY their");
      lines.push("blackboard values actually satisfy each criterion. Flag any that look like stubs.");
      for (const ec of context.recentExitCriteria) {
        lines.push(`- **${ec.name}** (${ec.pid}):`);
        for (const c of ec.criteria) {
          lines.push(`  - [ ] ${c}`);
        }
        lines.push(`  bb keys written: [${ec.bbKeysWritten.join(", ")}]`);
      }
    }

    // Relevant heuristics
    lines.push("");
    lines.push("### Relevant Heuristics");
    lines.push("Include the `id` of any heuristic that influences your decisions in `citedHeuristicIds`.");
    if (context.relevantHeuristics.length === 0) {
      lines.push("No relevant heuristics available.");
    } else {
      for (const h of context.relevantHeuristics) {
        const scopeLabel = h.scope === "local" ? " scope=local" : "";
        lines.push(
          `- [id=${h.id}, confidence=${h.confidence.toFixed(2)}, reinforced=${h.reinforcementCount}x${scopeLabel}] ${h.heuristic}`,
        );
        lines.push(`  Context: ${h.context}`);
      }
    }

    // Show intervention history if available
    if (context.interventionHistory && context.interventionHistory.length > 0) {
      lines.push("");
      lines.push("### Intervention History");
      for (const iv of context.interventionHistory) {
        const preActive = iv.preSnapshot.activeProcessCount;
        const postActive = iv.postSnapshot?.activeProcessCount ?? '?';
        lines.push(`- [${iv.outcome ?? 'pending'}] ${iv.commandKind} tick=${iv.tick}: active ${preActive}→${postActive}`);
      }
    }

    // Show causal attributions — conditions that correlated with intervention outcomes
    if (context.causalInsights && context.causalInsights.length > 0) {
      lines.push("");
      lines.push("### Causal Attributions (intervention conditions → outcomes)");
      lines.push("These heuristics describe which process topology conditions were present when interventions succeeded or failed.");
      for (const h of context.causalInsights) {
        lines.push(`- [confidence=${h.confidence.toFixed(2)}] ${h.heuristic}`);
        lines.push(`  key: ${h.context}`);
      }
    }

    // GAP 2: Show counterfactual simulation results for recent kill decisions.
    // These heuristic projections estimate the token/time cost of NOT taking past actions,
    // helping the metacog calibrate future kill decisions with counterfactual reasoning.
    if (context.counterfactualInsights && context.counterfactualInsights.length > 0) {
      lines.push("");
      lines.push("### Counterfactual Analyses (cost of NOT taking past kill actions)");
      lines.push("These projections estimate resource costs if killed processes had been kept alive. Use to calibrate future kill decisions.");
      for (const cf of context.counterfactualInsights) {
        lines.push(`- ${cf}`);
      }
    }

    // GAP 1 (R6): Show kill threshold calibration state
    if (context.avgTokenSavedPerKill !== undefined) {
      lines.push("");
      lines.push("### Kill Threshold Calibration");
      lines.push(`Avg tokens saved per kill: ${context.avgTokenSavedPerKill.toFixed(0)}`);
      if (context.killThresholdAdjustment !== undefined) {
        const direction = context.killThresholdAdjustment < 0 ? "MORE aggressive" : "MORE conservative";
        lines.push(`Kill threshold adjustment: ${context.killThresholdAdjustment > 0 ? "+" : ""}${context.killThresholdAdjustment} (be ${direction} about killing stalled processes)`);
      }
    }

    // Show most recent self-report from each process
    if (this.processSnapshot.length > 0) {
      const reportLines: string[] = [];
      for (const proc of this.processSnapshot) {
        const lastReport = proc.selfReports?.slice(-1)[0];
        if (lastReport) {
          const blockerInfo = lastReport.blockers.length > 0 ? `, blockers: ${lastReport.blockers.join(', ')}` : '';
          const reasonInfo = lastReport.reason ? `, reason: ${lastReport.reason}` : '';
          reportLines.push(`- ${proc.name}: efficiency=${lastReport.efficiency.toFixed(2)}, pressure=${lastReport.resourcePressure}, action=${lastReport.suggestedAction}${blockerInfo}${reasonInfo}`);
        }
      }
      if (reportLines.length > 0) {
        lines.push("");
        lines.push("### Process Self-Reports");
        lines.push(...reportLines);
      }
    }

    // Ephemeral process stats
    if (this.ephemeralStats.spawns > 0) {
      const successRate = this.ephemeralStats.spawns > 0
        ? ((this.ephemeralStats.successes / this.ephemeralStats.spawns) * 100).toFixed(0)
        : "n/a";
      const avgDuration = this.ephemeralStats.spawns > 0
        ? Math.round(this.ephemeralStats.totalDurationMs / this.ephemeralStats.spawns)
        : 0;
      lines.push("");
      lines.push("### Ephemeral Process Usage");
      lines.push(`Total spawns: ${this.ephemeralStats.spawns} | Successes: ${this.ephemeralStats.successes} | Failures: ${this.ephemeralStats.failures} | Success rate: ${successRate}%`);
      lines.push(`Avg duration: ${avgDuration}ms | Total duration: ${this.ephemeralStats.totalDurationMs}ms`);

      // Per-process ephemeral counts
      const ephemeralProcesses = this.processSnapshot.filter((p) => (p.ephemeralSpawnCount ?? 0) > 0);
      if (ephemeralProcesses.length > 0) {
        lines.push("Per-process:");
        for (const p of ephemeralProcesses) {
          lines.push(`  - ${p.name} (${p.pid}): ${p.ephemeralSpawnCount} spawns`);
        }
      }
    }

    // Topology blueprints
    lines.push("");
    lines.push("### Topology Blueprints");
    if (this.selectedBlueprint) {
      const bp = this.selectedBlueprint;
      const rate = (bp.successRate * 100).toFixed(0);
      lines.push(`Active blueprint: "${bp.name}" (${bp.id.slice(0, 8)}) source=${bp.source} success=${rate}%`);
      lines.push(`  Roles: ${bp.instantiatedRoles.join(", ")}${bp.adapted ? " (adapted)" : ""}`);
    } else {
      lines.push("No blueprint selected yet.");
    }
    if (this.blueprintsSnapshot.length > 0) {
      lines.push(`Available blueprints (${this.blueprintsSnapshot.length}):`);
      for (const bp of this.blueprintsSnapshot.slice(0, 5)) {
        const rate = bp.stats.uses > 0 ? ((bp.stats.successes / bp.stats.uses) * 100).toFixed(0) : "n/a";
        const alpha = bp.stats.alpha ?? 1;
        const beta = bp.stats.beta ?? 1;
        const bayesianMean = (alpha / (alpha + beta)).toFixed(2);
        lines.push(`- "${bp.name}" source=${bp.source} uses=${bp.stats.uses} success=${rate}% bayesian_mean=${bayesianMean} roles=${bp.roles.length}`);
      }
    }
    lines.push("You can use `define_blueprint` to invent new topologies, `evolve_blueprint` to mutate existing ones and preserve their Bayesian priors, and `fork` to duplicate a running process for speculative parallel exploration.");

    // Awareness daemon notes — injected from meta-metacognitive layer
    if (context.awarenessNotes && context.awarenessNotes.length > 0) {
      lines.push("");
      lines.push("### Awareness Layer Notes");
      lines.push("The awareness daemon has analyzed your recent decision patterns and offers these observations:");
      for (const note of context.awarenessNotes) {
        lines.push(`- ${note}`);
      }
    }

    // Awareness daemon flagged heuristics — surface for metacog reconsideration
    if (context.flaggedHeuristics && context.flaggedHeuristics.length > 0) {
      lines.push("");
      lines.push("### Flagged Heuristics (awareness daemon)");
      lines.push("These heuristics have been flagged as suspicious by the awareness layer. Reconsider them critically:");
      for (const flagged of context.flaggedHeuristics) {
        lines.push(`- [${flagged.id}] ${flagged.reason}`);
      }
    }

    return lines.join("\n");
  }

  setProcessSnapshot(processes: OsProcess[]): void {
    this.processSnapshot = processes;
  }

  setBlueprintsSnapshot(blueprints: TopologyBlueprint[]): void {
    this.blueprintsSnapshot = blueprints;
  }

  setSelectedBlueprint(info: SelectedBlueprintInfo | null): void {
    this.selectedBlueprint = info;
  }

  setEphemeralStats(stats: { spawns: number; successes: number; failures: number; totalDurationMs: number }): void {
    this.ephemeralStats = stats;
  }

  addTrigger(trigger: OsMetacogTrigger): void {
    this.pendingTriggers.push(trigger);
  }

  setTriggers(triggers: OsMetacogTrigger[]): void {
    this.pendingTriggers = [...triggers];
  }

  hasPendingTriggers(): boolean {
    return this.pendingTriggers.length > 0;
  }

  async evaluate(
    context: MetacogContext,
    options?: { onStreamEvent?: (event: StreamEvent) => void },
  ): Promise<string> {
    // Fresh thread each evaluation — the context prompt already contains the full
    // system state (process table, blackboard, metrics, intervention history,
    // awareness notes). Reusing threads would accumulate stale snapshots as input
    // tokens with zero informational value, since each context prompt supersedes
    // the last. Prior decisions are already fed back via metacogHistory.
    const thread = this.client.startThread({ model: this.model });

    const input = this.buildSystemPrompt() + "\n\n---\n\n" + this.buildContextPrompt(context);

    const result = await thread.run(input, {
      outputSchema: METACOG_OUTPUT_SCHEMA,
      onStreamEvent: options?.onStreamEvent,
    });

    this.evaluationCount += 1;
    this.pendingTriggers = [];

    return result.finalResponse;
  }

  getStats(): { evaluationCount: number; tokensUsed: number } {
    return {
      evaluationCount: this.evaluationCount,
      tokensUsed: this.tokensUsed,
    };
  }

  /**
   * Entry point for the metacog-daemon process executor pattern (Gap 5).
   *
   * When the kernel spawns a 'metacog-daemon' process, the daemon's process executor:
   *   1. Reads an OsSystemSnapshot from IPC channel 'metacog:system-state'
   *   2. Calls this method with that snapshot
   *   3. Pushes the returned MetacogOutput to IPC channel 'metacog:commands'
   *
   * This decouples metacognitive evaluation from the synchronous kernel tick loop,
   * allowing the metacog agent to be scheduled like any other first-class process.
   *
   * @param stateSnapshot  OsSystemSnapshot written to 'metacog:system-state' by the kernel.
   * @returns              Parsed MetacogOutput ready to be pushed to 'metacog:commands'.
   */
  async runForDaemon(stateSnapshot: OsSystemSnapshot): Promise<MetacogOutput> {
    // Hydrate internal snapshots from the channel-pushed state so that
    // buildContextPrompt() can render the process table and selected blueprint.
    this.setProcessSnapshot(stateSnapshot.processes);
    if (stateSnapshot.selectedBlueprint) {
      this.setSelectedBlueprint(stateSnapshot.selectedBlueprint);
    }

    // Build a MetacogContext from the flat snapshot fields.
    // OsSystemSnapshot does not carry a full DAG delta (only current topology),
    // so we construct a minimal zero-delta; the process table and IPC summary
    // still give the LLM everything it needs to reason about system state.
    const context: MetacogContext = {
      ticksSinceLastEval: 1,
      processEvents: stateSnapshot.recentEvents,
      ipcActivity: stateSnapshot.ipcSummary,
      dagDelta: {
        since: new Date().toISOString(),
        nodesAdded: [],
        nodesRemoved: [],
        edgesAdded: [],
        edgesRemoved: [],
        nodesUpdated: [],
      },
      progressMetrics: stateSnapshot.progressMetrics,
      relevantHeuristics: stateSnapshot.recentHeuristics,
    };

    const responseStr = await this.evaluate(context);

    // Parse the structured JSON response into the topology algebra output format.
    // Any parse failure yields a no-op output — the caller handles retries.
    try {
      const parsed = JSON.parse(responseStr) as {
        assessment?: string;
        topology?: any;
        memory?: MetacogMemoryCommand[];
        halt?: { status: "achieved" | "unachievable" | "stalled"; summary: string } | null;
      };
      return {
        topology: parsed.topology ?? null,
        memory: Array.isArray(parsed.memory) ? parsed.memory : [],
        halt: parsed.halt ?? null,
      };
    } catch {
      return { topology: null, memory: [], halt: null };
    }
  }
}
