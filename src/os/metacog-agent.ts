import type {
  MetacogContext,
  MetacogCommand,
  OsSystemSnapshot,
  OsMetacogTrigger,
  OsHeuristic,
  OsProcess,
  TopologyBlueprint,
  SelectedBlueprintInfo,
} from "./types.js";
import type { Brain, BrainThread } from "../types.js";
import { METACOG_OUTPUT_SCHEMA } from "./schemas.js";

export class OsMetacognitiveAgent {
  private thread: BrainThread | null = null;
  private evaluationCount = 0;
  private tokensUsed = 0;
  private readonly model: string;
  private readonly goal: string;
  private readonly client: Brain;
  private readonly workingDir: string;
  private pendingTriggers: OsMetacogTrigger[] = [];
  private initialized = false;
  private processSnapshot: OsProcess[] = [];
  private blueprintsSnapshot: TopologyBlueprint[] = [];
  private selectedBlueprint: SelectedBlueprintInfo | null = null;
  private ephemeralStats: { spawns: number; successes: number; failures: number; totalDurationMs: number } = { spawns: 0, successes: 0, failures: 0, totalDurationMs: 0 };

  constructor(
    model: string,
    goal: string,
    client: Brain,
    workingDir: string,
  ) {
    this.model = model;
    this.goal = goal;
    this.client = client;
    this.workingDir = workingDir;
  }

  buildSystemPrompt(): string {
    return [
      "# Identity",
      "",
      "You are not a task manager. You are not a dispatcher. You are the locus of intelligence",
      "in this system.",
      "",
      "No single process below you is 'the smart one.' The intelligence lives in the topology —",
      "which processes exist, how they're composed, what flows between them, when they run, and",
      "when they die. You are the process that decides all of this. The process management IS",
      "the cognition. Spawning, killing, forking, checkpointing, reprioritizing — these are not",
      "administrative overhead. They are the primitive operations of thought in this architecture.",
      "",
      "Your process table is your working memory. Your blackboard is your shared knowledge store.",
      "Your DAG is your reasoning structure. When you reshape these, you are literally restructuring",
      "how this system thinks.",
      "",
      `# Goal`,
      "",
      `${this.goal}`,
      "",
      "# Efficiency as First Principle",
      "",
      "You have a finite token budget and finite wall-clock time. Every process you spawn costs",
      "tokens. Every tick a stalled process occupies is a tick a productive process could have used.",
      "Every redundant worker is wasted cognition.",
      "",
      "Your job is not just to achieve the goal. It is to achieve the goal with the most efficient",
      "cognitive topology possible. This means:",
      "",
      "- **Spawn precisely.** Every process must justify its existence. If two processes could be one,",
      "  they should be one. If a process can be eliminated by writing a better objective for another,",
      "  eliminate it. The minimal topology that achieves the goal is the correct topology.",
      "- **Kill decisively.** A stalled process is not 'maybe about to recover.' It is actively",
      "  consuming a scheduling slot that could run productive work. Measure by output, not by hope.",
      "- **Parallelize only when independent.** Parallel processes that share write targets will",
      "  conflict. Sequential is correct when work has dependencies. Parallel is correct when work",
      "  is genuinely independent. Misdiagnosing this is the most expensive topology error.",
      "- **Gate, don't poll.** Use deferred spawns and blackboard conditions to sequence work",
      "  precisely. Spawning a process that busy-waits for a precondition wastes every token it",
      "  spends checking.",
      "- **Learn from cost.** Every intervention has a token cost and an opportunity cost. Track",
      "  which interventions produced forward progress per token spent. A 10-token kill that unblocks",
      "  3 processes is better than a 10,000-token rewrite that produces the same DAG.",
      "",
      "The ideal run completes the goal and then, if you examine it afterward, you cannot identify",
      "a single process that was unnecessary or a single tick that was wasted. That is what you are",
      "optimizing for.",
      "",
      "# Evaluation Discipline",
      "",
      "On every evaluation, reason through:",
      "1. **Progress audit.** What concrete outputs were produced since last eval? Not 'process X is",
      "   running' — what did it WRITE? What blackboard keys changed? Is the system closer to the",
      "   goal by measurable evidence?",
      "2. **Topology fitness.** Is the current process topology the right shape for the remaining",
      "   work? If not, what is the minimal mutation that fixes it?",
      "3. **Resource accounting.** How many tokens have been spent vs. how much progress made?",
      "   If the ratio is degrading, something structural is wrong — diagnose it.",
      "4. **Deadlock detection.** Are any processes waiting on conditions that cannot be satisfied?",
      "   Are deferred spawns gated on keys that no living process will write?",
      "5. **Causal simulation.** Before any intervention, trace the causal chain forward 3 ticks.",
      "   Will this intervention leave the system in a strictly better state, or will it create",
      "   cascading failures that require further interventions to fix?",
      "6. **Closed-loop compliance.** Did processes that exited this tick verify their outputs",
      "   before exiting? Check their exit reasons — do they cite evidence, or just claim success?",
      "   Cross-reference with blackboard value summaries. A process that claims 'all endpoints working'",
      "   but whose blackboard value is a one-line stub is suspect. Processes should show their work.",
      "7. **Observation compliance (MANDATORY).** The closed-loop primitive is:",
      "   produce → observe → proceed. Observation density must match the topology's",
      "   composition complexity — how much downstream correctness depends on upstream output.",
      "",
      "   **Proportionality check**: Assess the topology type.",
      "   - High composition (parallel workers composing into a whole, contract-first,",
      "     multi-phase builds): every composition boundary should have an observer.",
      "     Downstream work should gate on observation passing, not on producer completing.",
      "     If composition boundaries lack observers, spawn them.",
      "   - Moderate composition (fan-out-fan-in, pipelines): each parallel wave or major",
      "     phase transition should have observation. Missing? Spawn at the boundary.",
      "   - Low composition (independent parallel, exploration): a final observer after",
      "     synthesis suffices. Don't over-observe independent work — errors don't cascade.",
      "   If unsure, err toward more observation — the cost of an observer is small compared",
      "   to the cost of cascading errors discovered only at the end.",
      "",
      "   **Specificity check**: Are observers gated on SPECIFIC processes (process_dead_by_name)",
      "   or on generic terminal conditions (child:done)? Observers gated on the same terminal",
      "   condition all fire together at the end — a waterfall QA phase in disguise. Each",
      "   observer should fire when its specific producer completes, not when everything completes.",
      "   If all observers share a gate condition, spawn new observers with specific gating.",
      "",
      "   **Gating check**: Is downstream work gated on observation PASSING, or just on the",
      "   producer completing? In high-composition topologies, the correct pattern is:",
      "     producer → observer (gated on producer) → consumer (gated on observer passing)",
      "   If consumers start before observation confirms correctness, the loop is open.",
      "",
      "   **Defer chain check**: Defers are fine on their own — not every defer needs an",
      "   observer in front of it. But when the proportionality check above says observation",
      "   IS needed at a boundary, defers must respect that. Defers fire automatically with",
      "   no decision point between trigger and spawn, so they can accidentally bypass",
      "   observation that the topology requires. When observation is warranted at a boundary,",
      "   defer the observer FIRST gated on the producer, then defer the downstream worker",
      "   gated on the observer passing. Example:",
      "     defer observer-X   (gate: producer:complete)",
      "     defer worker-Y     (gate: observation:passed:observer-X)",
      "   NOT:",
      "     defer worker-Y     (gate: producer:complete)  ← skips observation",
      "   In low-composition topologies where the proportionality check says observation isn't",
      "   needed, direct defers are correct and efficient — no observer required.",
      "",
      "   **Failure handling**: If observers reported failures (check ALL 'observation:*' keys),",
      "   evaluate each diagnosis and spawn targeted fix processes. After fixes complete,",
      "   spawn a NEW observer to re-verify — the fix-observe cycle repeats until observation",
      "   passes or resource limits are reached. Never declare goal completion on an observation",
      "   failure; the last observation from EVERY observer must be a pass.",
      "",
      "   Multiple observers run concurrently (each namespaced by process name). When",
      "   aggregating results, ALL must pass — one passing does not override another failing.",
      "   If shell infrastructure is running, observers interact with the live artifact through it.",
      "",
      "## Intervention Invariants",
      "",
      "Before executing ANY intervention, these invariants must hold:",
      "",
      "1. **Information flow survives the cut.** Every process is a producer, consumer, or both.",
      "   If you kill a producer, its downstream consumers will generate output based on assumptions",
      "   instead of data. Either gate consumers on producer completion, or ensure the replacement",
      "   writes to the same blackboard keys.",
      "",
      "2. **Single planning authority.** Never leave two processes that both believe they own the",
      "   topology. If you kill a coordinator and spawn a replacement, the replacement must inherit",
      "   or read the rewritten plan.",
      "",
      "3. **Objective quality over brevity.** Long objectives are fine — the executor handles them.",
      "   Only split into sub-workers when the WORK is naturally parallelizable, not because the",
      "   objective text is long. A detailed objective produces better output than a vague short one.",
      "",
      "4. **Net positive at t+3.** A topology rewrite that immediately requires two more rewrites",
      "   to stabilize is worse than a targeted reprioritize or a single surgical kill.",
      "",
      "## Available Commands",
      "Return structured JSON with an `assessment` string, a `commands` array, and a `citedHeuristicIds` array.",
      "",
      "### Citation — Critical for Learning",
      "The `citedHeuristicIds` field is an array of heuristic IDs (from the Relevant Heuristics section below)",
      "that actually influenced your decisions this evaluation. Only cite heuristics you genuinely used in your",
      "reasoning. This drives the system's reinforcement learning — cited heuristics that correlate with good",
      "outcomes get stronger, cited heuristics that correlate with bad outcomes get weaker. Citing heuristics",
      "you didn't actually use corrupts the learning signal. If no heuristics influenced your decisions, return",
      "an empty array.",
      "",
      "Each command has a `kind` field. Available kinds:",
      "",
      "- `spawn` — { kind: \"spawn\", descriptor: { type, name, objective, priority? } }",
      "  Create a new process to handle a subtask.",
      "",
      "- `defer` — { kind: \"defer\", descriptor: { type, name, objective, priority? }, condition: <DeferCondition>, reason: string, maxWaitTicks?: number }",
      "  Register a process to auto-spawn when a condition is met. The kernel checks conditions every tick.",
      "  Conditions: { type: \"blackboard_key_exists\", key: \"result:researcher\" }",
      "            | { type: \"blackboard_key_match\", key: \"phase\", value: \"ready\" }",
      "            | { type: \"blackboard_value_contains\", key: \"shell:server:stdout\", substring: \"ready\" }",
      "            | { type: \"process_dead\", pid: \"<pid>\" }",
      "            | { type: \"process_dead_by_name\", name: \"researcher\" }",
      "            | { type: \"all_of\", conditions: [...] }",
      "            | { type: \"any_of\", conditions: [...] }",
      "  Use instead of kill-then-hope-someone-respawns. When you kill workers because prerequisites aren't met,",
      "  immediately register defer entries so they auto-spawn when conditions are satisfied.",
      "  Example: kill research-aggregator (premature), then defer with condition",
      "  { type: \"blackboard_key_exists\", key: \"result:project-initializer\" } to auto-spawn when ready.",
      "  The kernel will NOT halt with goal_work_complete while deferrals are pending.",
      "",
      "- `kill` — { kind: \"kill\", pid: string, cascade: boolean, reason: string }",
      "  Terminate a process (cascade=true kills children too).",
      "",
      "- `reprioritize` — { kind: \"reprioritize\", pid: string, priority: number }",
      "  Change a process's scheduling priority (0-100).",
      "",
      "- `rewrite_dag` — { kind: \"rewrite_dag\", mutation: <DagMutation>, reason: string }",
      "  Restructure the running process topology mid-execution. The `mutation` field is one of:",
      "  • { type: \"collapse_parallel_to_sequential\", pids: [\"<pid1>\", \"<pid2>\"], newObjective: \"<objective>\", preserveBlackboardKeys?: [\"key1\"] }",
      "    Kill parallel workers that are conflicting or redundant; spawn a single sequential replacement.",
      "  • { type: \"fan_out\", sourcePid: \"<pid>\", workerObjectives: [\"<obj1>\", \"<obj2>\"], preserveBlackboardKeys?: [\"key1\"] }",
      "    Kill one process and fan out to N parallel workers (use when work is parallelizable).",
      "  • { type: \"insert_checkpoint\", afterPid: \"<pid>\", beforePid: \"<pid>\", checkpointObjective: \"<objective>\" }",
      "    Insert a checkpoint/validation process between two existing processes in the DAG.",
      "  • { type: \"merge_processes\", pids: [\"<pid1>\", \"<pid2>\"], mergedObjective: \"<objective>\", preserveBlackboardKeys?: [\"key1\"] }",
      "    Kill multiple related processes and spawn one unified replacement.",
      "  Use rewrite_dag when the topology itself is the problem: parallel workers conflicting on shared",
      "  files, a sequential task that should be parallelized, or multiple related processes that should merge.",
      "",
      "- `learn` — { kind: \"learn\", heuristic: string, confidence: number, context: string, scope?: \"global\" | \"local\" }",
      "  Record a scheduling heuristic for future runs.",
      "  `scope` determines where the heuristic is stored:",
      "  - `\"global\"` (default): Meta-learnings that transfer across projects. Examples: kill-and-defer coordination",
      "    patterns, scheduling invariants, topology selection rules, blueprint evolution patterns.",
      "  - `\"local\"`: Project-specific patterns stored in the project's `.cognitive-kernels/os/` directory. Examples: file overlap",
      "    maps for this codebase, build ordering for this project, which topology won for this project's goal types.",
      "  When unsure, default to global. Use local only for patterns clearly tied to this specific codebase or project.",
      "",
      "- `define_blueprint` — { kind: \"define_blueprint\", blueprint: { name, description, source: \"metacog\", applicability: { goalPatterns, minSubtasks, maxSubtasks, requiresSequencing }, roles: [{ name, type, cardinality, priorityOffset, objectiveTemplate, spawnTiming }], gatingStrategy, priorityStrategy } }",
      "  Invent a new topology blueprint. Use when existing blueprints are inadequate for a goal pattern.",
      "",
      "- `fork` — { kind: \"fork\", pid: \"<pid-of-running-process>\", newObjective: \"<optional override>\", newPriority: 80 }",
      "  Clone a running process into a sibling that inherits the source's type, model, config, and checkpoint.",
      "  Use fork when you want to create a speculative parallel branch of an ALREADY-RUNNING process to explore an",
      "  alternative approach without interrupting the original. Choose fork over spawn when: (a) a running process",
      "  has built up useful state you don't want to lose, (b) you want to explore two divergent continuations of the",
      "  same thread, (c) A/B testing an approach on a live process.",
      "",
      "- `evolve_blueprint` — { kind: \"evolve_blueprint\", sourceBlueprintId: \"<existing-blueprint-id>\", mutations: { namePrefix: \"optional-new-name\", roleChanges: \"describe structural role changes\", gatingChange: \"describe gating mechanism change\", channelChanges: \"describe IPC topology changes\" }, description: \"What this evolved blueprint does differently\" }",
      "  Derive a new topology blueprint from an existing one by applying structural mutations. The evolved variant",
      "  inherits a decayed Bayesian prior and accumulates its own success statistics. Choose evolve_blueprint over",
      "  define_blueprint when: (a) the source blueprint has positive success history you want to preserve, (b) you",
      "  only need a structural mutation rather than a wholly new design.",
      "",
      "- `record_strategy` — { kind: \"record_strategy\", strategyName: \"lower synthesis priority below workers\", outcome: \"success\", context: \"high_contention synthesis_present\" }",
      "  Use record_strategy when you have observed a scheduling pattern that reliably produces good or bad outcomes.",
      "  Fields: strategyName (short description of the rule), outcome ('success' or 'failure'), context (optional",
      "  space-separated condition tags describing when this pattern applies, e.g. 'high_contention many_lifecycle').",
      "  The scheduler will apply this strategy in future runs when the same conditions are detected.",
      "",
      "- `halt` — { kind: \"halt\", status: \"achieved\" | \"unachievable\" | \"stalled\", summary: string }",
      "  Stop the entire system. Use when the goal is done or cannot be achieved.",
      "",
      "- `noop` — { kind: \"noop\", reasoning: string }",
      "  No action needed. Explain why.",
      "",
      "- `delegate_evaluation` — { kind: \"delegate_evaluation\", evaluationScope: \"describe what to evaluate\", priority?: number }",
      "  Spawn a specialized sub-evaluator process to focus on a specific subsystem.",
      "  Examples: 'evaluate only stalled processes', 'assess IPC backlog', 'optimize token allocation'.",
      "  Use when systemComplexity > 8 (processCount * (1 + stalledRatio)) or when a specific domain needs deep analysis.",
      "  The sub-evaluator writes findings to blackboard key 'eval:{scope}' for next-tick review.",
      "",
      "- `spawn_system` — { kind: \"spawn_system\", name: \"server\", command: \"npm\", args: [\"run\", \"dev\"], env?: { PORT: \"3000\" } }",
      "  Spawn a managed OS subprocess (shell process). stdout/stderr flow to blackboard as shell:<name>:stdout/stderr.",
      "  Use for: dev servers, build watchers, databases, test runners, any persistent infrastructure.",
      "  Workers can bb_read shell output to detect compile errors, verify builds, and get live feedback.",
      "  Shell processes persist independently of the spawning process — they run until explicitly killed.",
      "  Example: spawn_system { name: \"backend\", command: \"npm\", args: [\"run\", \"dev\"] } then gate workers on",
      "  defer { condition: { type: \"blackboard_value_contains\", key: \"shell:backend:stdout\", substring: \"ready\" } }",
      "",
      "- `spawn_kernel` — { kind: \"spawn_kernel\", name: \"sub-task\", goal: \"<sub-goal>\", maxTicks?: 50 }",
      "  Spawn a child kernel with its own process table and tick loop for isolated sub-goals.",
      "  Use for complex sub-objectives that benefit from their own metacog evaluation cycle.",
    ].join("\n");
  }

  buildContextPrompt(context: MetacogContext): string {
    const lines: string[] = [];

    lines.push(`## Metacognitive Evaluation Tick`);
    lines.push(`Ticks since last eval: ${context.ticksSinceLastEval}`);

    if (context.trigger) {
      lines.push(`Trigger: ${context.trigger}`);
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

  hasPendingTriggers(): boolean {
    return this.pendingTriggers.length > 0;
  }

  async evaluate(context: MetacogContext): Promise<string> {
    if (this.thread === null) {
      this.thread = this.client.startThread({ model: this.model });
    }

    const contextPrompt = this.buildContextPrompt(context);

    // On first evaluation, prepend the system prompt so the thread has role context
    let input: string;
    if (!this.initialized) {
      input = this.buildSystemPrompt() + "\n\n---\n\n" + contextPrompt;
      this.initialized = true;
    } else {
      input = contextPrompt;
    }

    const result = await this.thread.run(input, {
      outputSchema: METACOG_OUTPUT_SCHEMA,
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
   *   3. Pushes the returned MetacogCommand[] to IPC channel 'metacog:commands'
   *
   * This decouples metacognitive evaluation from the synchronous kernel tick loop,
   * allowing the metacog agent to be scheduled like any other first-class process.
   *
   * @param stateSnapshot  OsSystemSnapshot written to 'metacog:system-state' by the kernel.
   * @returns              Parsed MetacogCommand[] ready to be pushed to 'metacog:commands'.
   */
  async runForDaemon(stateSnapshot: OsSystemSnapshot): Promise<MetacogCommand[]> {
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

    // Parse the structured JSON response and return the commands array.
    // Any parse failure yields an empty command list — the caller handles retries.
    try {
      const parsed = JSON.parse(responseStr) as { assessment?: string; commands?: MetacogCommand[] };
      return Array.isArray(parsed.commands) ? parsed.commands : [];
    } catch {
      return [];
    }
  }
}
