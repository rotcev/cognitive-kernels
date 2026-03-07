import type { Brain, BrainThread, ProcessStreamCallback, StreamEventCallback } from "../types.js";
import type { OsProcess, OsProcessCommand, OsProcessTurnResult, OsHeuristic, TopologyBlueprint, SchedulingStrategy, ExecutorCheckpointState } from "./types.js";
import type { ExecutorBackend, ExecutorContextInjectable, ExecutorStreamable, ExecutorCheckpointable } from "./executor-backend.js";
import { extractGoalTags } from "./memory-store.js";
import fs from "node:fs";
import path from "node:path";

type ThreadEntry = {
  thread: BrainThread;
  turnCount: number;
};

export type ProcessExecutorDeps = {
  client: Brain;
  workingDir: string;
  commandDir?: string;
  /** Browser MCP server config — passed per-thread to observer processes with capabilities.observationTools: ["browser"]. */
  browserMcpConfig?: import("../types.js").McpServerConfig;
};

export class LlmExecutorBackend implements ExecutorBackend, ExecutorContextInjectable, ExecutorStreamable, ExecutorCheckpointable {
  readonly name = "llm";
  private readonly threads: Map<string, ThreadEntry> = new Map();
  private readonly client: Brain;
  private readonly workingDir: string;
  private readonly commandDir: string;
  private readonly browserMcpConfig?: import("../types.js").McpServerConfig;
  private blackboardSnapshot: Record<string, unknown> | null = null;
  private heuristicsSnapshot: OsHeuristic[] = [];
  private blueprintsSnapshot: TopologyBlueprint[] = [];
  private processTableSnapshot: OsProcess[] | null = null;
  private streamCallback: ProcessStreamCallback | null = null;
  private strategiesSnapshot: SchedulingStrategy[] = [];

  constructor(deps: ProcessExecutorDeps) {
    this.client = deps.client;
    this.workingDir = deps.workingDir;
    this.commandDir = deps.commandDir ?? path.join(deps.workingDir, ".os-commands");
    this.browserMcpConfig = deps.browserMcpConfig;
  }

  /** No-op for LLM backend — threads are created lazily on first executeOne. */
  async start(_proc: OsProcess): Promise<void> {
    // LLM threads are created lazily in getOrCreateThread
  }

  /** Number of active LLM threads. */
  get activeCount(): number {
    return this.threads.size;
  }

  /** Inject current blackboard state so prompts can include it. */
  setBlackboardSnapshot(snapshot: Record<string, unknown>): void {
    this.blackboardSnapshot = snapshot;
  }

  /** Inject learned heuristics so process prompts can apply them proactively. */
  setHeuristicsSnapshot(heuristics: OsHeuristic[]): void {
    this.heuristicsSnapshot = heuristics;
  }

  /** Inject ranked topology blueprints for goal-orchestrator decomposition. */
  setBlueprintsSnapshot(blueprints: TopologyBlueprint[]): void {
    this.blueprintsSnapshot = blueprints;
  }

  /** Inject process table snapshot so prompts can include sibling context. */
  setProcessTableSnapshot(processes: OsProcess[]): void {
    this.processTableSnapshot = processes;
  }

  /** Set or clear the streaming callback for real-time LLM event observability. */
  setStreamCallback(callback: ProcessStreamCallback | null): void {
    this.streamCallback = callback;
  }

  /** Inject scheduling strategies snapshot for goal-orchestrator strategy guidance. */
  setStrategiesSnapshot(strategies: SchedulingStrategy[]): void {
    this.strategiesSnapshot = strategies;
  }

  /** Get the command file path for a process. */
  getCommandFilePath(pid: string): string {
    return path.join(this.commandDir, `${pid}.json`);
  }

  /**
   * Execute a batch of processes with concurrency limiting.
   * Returns a ProcessTurnResult for each process.
   */
  async executeBatch(
    processes: OsProcess[],
    maxConcurrent: number,
  ): Promise<OsProcessTurnResult[]> {
    if (processes.length === 0) return [];

    const results: OsProcessTurnResult[] = [];
    const limit = Math.max(1, maxConcurrent);

    // Simple concurrency pool
    let index = 0;
    const next = async (): Promise<void> => {
      while (index < processes.length) {
        const proc = processes[index++]!;
        const result = await this.executeOne(proc);
        results.push(result);
      }
    };

    const workers = Array.from({ length: Math.min(limit, processes.length) }, () => next());
    await Promise.all(workers);

    return results;
  }

  /**
   * Execute a single process turn as a full agentic session.
   * Commands are read from a per-process command file, or parsed from the
   * response as a fallback (for backward compat with test mocks).
   */
  async executeOne(proc: OsProcess, retryCount = 0): Promise<OsProcessTurnResult> {
    try {
      const entry = this.getOrCreateThread(proc);
      const commandFile = this.getCommandFilePath(proc.pid);

      // Ensure command directory exists
      fs.mkdirSync(this.commandDir, { recursive: true });

      // Clean up any stale command file from previous tick
      try { fs.unlinkSync(commandFile); } catch { /* doesn't exist */ }

      const prompt = this.buildProcessPrompt(proc, commandFile);

      // Build per-process stream callback that tags events with (pid, processName)
      let onStreamEvent: StreamEventCallback | undefined;
      if (this.streamCallback) {
        const cb = this.streamCallback;
        const pid = proc.pid;
        const name = proc.name;
        onStreamEvent = (event) => cb(pid, name, event);
      }

      // Emit a synthetic "started" event so the UI shows the process is active
      if (onStreamEvent) {
        onStreamEvent({ type: "text_delta", text: `Starting turn ${entry.turnCount + 1}...\n` });
      }

      // Run the agent turn. Use structured output to ensure reliable command parsing.
      // The command-file path is still communicated in the prompt as a future migration path,
      // but we rely on structured output for now since it's proven reliable.
      const { PROCESS_TURN_OUTPUT_SCHEMA } = await import("./schemas.js");
      const result = await entry.thread.run(prompt, {
        outputSchema: PROCESS_TURN_OUTPUT_SCHEMA,
        onStreamEvent,
      });

      entry.turnCount += 1;

      // Read commands from file (agentic mode) or parse response (fallback)
      let commands: OsProcessCommand[] = [];
      let tokensEstimate = Math.ceil(result.finalResponse.length / 4);

      // Extract StreamEventUsage from result when available (narrow from the broader TurnResult.usage type)
      const usage = result.usage && "inputTokens" in result.usage
        ? result.usage as import("../types.js").StreamEventUsage
        : undefined;

      // Use real usage data from SDK when available
      if (usage) {
        tokensEstimate = usage.inputTokens + usage.outputTokens;
      }

      if (fs.existsSync(commandFile)) {
        commands = this.readCommandFile(commandFile);
        try { fs.unlinkSync(commandFile); } catch { /* cleanup */ }
      } else {
        // Fallback: try parsing response as structured JSON (backward compat with mocks)
        const parsed = this.parseProcessResponse(proc.pid, result.finalResponse);
        commands = parsed.commands;
        // Only use heuristic token estimate if no real usage data
        if (!usage) {
          tokensEstimate = parsed.tokensEstimate;
        }
      }

      return {
        pid: proc.pid,
        success: true,
        response: result.finalResponse,
        tokensUsed: tokensEstimate,
        commands,
        usage,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Retry once on transient failures
      if (retryCount < 1) {
        this.threads.delete(proc.pid);
        return this.executeOne(proc, retryCount + 1);
      }

      return {
        pid: proc.pid,
        success: false,
        response: message,
        tokensUsed: 0,
        commands: [],
      };
    }
  }

  /**
   * Read and parse OS commands from a process's command file.
   */
  readCommandFile(filePath: string): OsProcessCommand[] {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return [];
      const rawCommands = Array.isArray(parsed.commands) ? parsed.commands : [];
      const commands: OsProcessCommand[] = [];
      for (const cmd of rawCommands) {
        const validated = this.validateProcessCommand(cmd);
        if (validated) commands.push(validated);
      }
      return commands;
    } catch {
      return [];
    }
  }

  /**
   * Build a context-rich prompt for a process turn.
   */
  buildProcessPrompt(proc: OsProcess, commandFile?: string): string {
    const sections: string[] = [];

    // Section 1: Identity and context
    sections.push([
      `# Process: ${proc.name} (PID: ${proc.pid})`,
      `Type: ${proc.type} | Priority: ${proc.priority} | Tick: ${proc.tickCount}`,
      `Tokens used: ${proc.tokensUsed}${proc.tokenBudget ? ` / ${proc.tokenBudget}` : ""}`,
      "",
      "You are a process running inside a cognitive kernel — a system where intelligence",
      "emerges from the topology of AI sub-processes: how they are spawned, composed,",
      "and how context flows between them. The kernel schedules your turns, routes",
      "messages via IPC, and a metacognitive agent reshapes the topology at runtime.",
      "",
      "## Objective",
      proc.objective,
    ].join("\n"));

    // Section 2: Checkpoint context
    if (proc.checkpoint) {
      sections.push([
        "## Checkpoint (resuming from previous state)",
        `Summary: ${proc.checkpoint.conversationSummary}`,
        `Pending objectives: ${proc.checkpoint.pendingObjectives.join(", ") || "none"}`,
        proc.checkpoint.artifacts && Object.keys(proc.checkpoint.artifacts).length > 0
          ? `Artifacts: ${JSON.stringify(proc.checkpoint.artifacts)}`
          : "",
      ].filter(Boolean).join("\n"));
    }

    // Section 3: Sibling processes (share the same parent)
    const siblingSection = this.buildSiblingSection(proc);
    if (siblingSection) {
      sections.push(siblingSection);
    }

    // Section 4: Strategy guidance based on process role
    sections.push(this.buildStrategySection(proc));

    // Section 5: Blackboard contents
    // On tick 0 of a fresh orchestrator, only show system: keys (pre-seeded by kernel).
    // On tick 0 of a RESTARTED orchestrator (has lifecycle children), show all keys.
    // On tick 1+, show all keys.
    if (this.blackboardSnapshot) {
      const allEntries = Object.entries(this.blackboardSnapshot);
      const isRestartedOrchestrator = proc.tickCount === 0 && !proc.parentPid && proc.type === "lifecycle"
        && this.processTableSnapshot?.some(p => p.parentPid === proc.pid && p.type === "lifecycle");
      const entries = proc.tickCount === 0 && !isRestartedOrchestrator
        ? allEntries.filter(([key]) => key.startsWith("system:"))
        : allEntries;
      if (entries.length > 0) {
        const lines = ["## Blackboard (current shared state)"];
        for (const [key, value] of entries) {
          const valStr = typeof value === "string" ? value : JSON.stringify(value);
          const limit = key.startsWith("architecture:") ? 2500 : 500;
          const display = valStr.length > limit ? valStr.slice(0, limit) + "..." : valStr;
          lines.push(`### ${key}\n${display}`);
        }
        sections.push(lines.join("\n"));
      }
    }

    // Section 5: OS command interface
    sections.push(this.buildCommandReference(proc));

    return sections.join("\n\n");
  }

  /**
   * Build the sibling processes section for a process.
   * Shows other processes that share the same parentPid, their states,
   * and blackboard keys they appear to have written to.
   */
  private buildSiblingSection(proc: OsProcess): string | null {
    if (!this.processTableSnapshot) return null;
    // Only show siblings when the process has a parent (i.e. it's a child process)
    if (!proc.parentPid) return null;

    const siblings = this.processTableSnapshot.filter(
      (p) => p.pid !== proc.pid && p.parentPid === proc.parentPid,
    );

    if (siblings.length === 0) return null;

    const lines = ["## Sibling Processes"];

    for (const sibling of siblings) {
      // Find blackboard keys that appear to belong to this sibling.
      // Convention: workers write to "result:<name>"; check for any matching keys.
      const siblingBbKeys: string[] = [];
      if (this.blackboardSnapshot) {
        for (const key of Object.keys(this.blackboardSnapshot)) {
          if (key === `result:${sibling.name}` || key.startsWith(`result:${sibling.name}:`)) {
            siblingBbKeys.push(key);
          }
        }
      }

      const bbInfo = siblingBbKeys.length > 0
        ? ` | wrote: ${siblingBbKeys.join(", ")}`
        : "";

      lines.push(
        `- **${sibling.name}** (${sibling.pid}) state=${sibling.state} priority=${sibling.priority}${bbInfo}`,
      );
    }

    return lines.join("\n");
  }

  /**
   * Build the OS command reference section.
   */
  private buildCommandReference(proc: OsProcess): string {
    const isGoalOrchestrator = proc.name === "goal-orchestrator";
    const nativeToolsLines = isGoalOrchestrator
      ? [
          "## Native Tools (READ-ONLY + WEB RESEARCH)",
          "You are the orchestrator. Your native tools are: Read, Glob, Grep, WebSearch, WebFetch.",
          "You CANNOT write files, edit files, or run Bash. You MUST delegate all file-writing",
          "and code-execution work to child processes via spawn_child.",
          "Use Read/Glob/Grep to understand the task. Use WebSearch/WebFetch for external research.",
          "Use OS commands (bb_write, bb_read, spawn_child, etc.) for kernel IPC and delegation.",
        ]
      : [
          "## Native Tools (USE THESE FOR ALL FILE I/O AND RESEARCH)",
          "You are running as a full Claude Code agent with native tools: Write, Edit, Read, Bash, Glob, Grep, WebSearch, WebFetch.",
          "**Use your native Write/Edit tools for ALL filesystem operations** (creating files, editing code, reading files, etc.).",
          "**Use WebSearch/WebFetch for external research** — API docs, library usage, error messages, best practices.",
          "Use OS commands below ONLY for kernel IPC (bb_write, bb_read, spawn_child, signal_emit, etc.).",
          "Native tools are more reliable than OS commands for file operations — prefer them always.",
        ];
    return [
      ...nativeToolsLines,
      "",
      "### Web Research Tools",
      "- **WebSearch** — search the web for documentation, API references, error solutions, library guides.",
      "  Use when you need current information that isn't in the local codebase: package docs, API specs,",
      "  error message lookups, best practices, changelog/migration guides.",
      "- **WebFetch** — fetch and analyze a specific URL. Use when you have a known URL (from docs, README,",
      "  error output, or WebSearch results) and need to read its content.",
      "",
      "**When to use web research:**",
      "- Unfamiliar library or API: search for its documentation before writing integration code",
      "- Error messages you don't recognize: search for the error to find solutions",
      "- Package version compatibility: check changelogs and migration guides",
      "- Best practices: when implementing patterns you're unsure about (auth, caching, etc.)",
      "- Missing context: when the codebase references external services or specs you need to understand",
      "",
      "## Available OS Commands",
      "Return commands in the `commands` array. Available kinds:",
      "",
      "### Ephemeral Helpers (USE THESE LIBERALLY)",
      "Ephemerals are your most powerful tool. They are fast, cheap (Haiku by default), and run",
      "concurrently. You can spawn up to 8 per process (3 concurrent). ALWAYS prefer spawning",
      "an ephemeral over doing low-level work yourself when the task is self-contained.",
      "",
      "**When to spawn ephemerals (do this by default):**",
      "- Type-checking: `spawn_ephemeral` with objective \"Run npx tsc --noEmit and report errors\"",
      "- Test validation: \"Run npx vitest run test/os/ and report pass/fail counts\"",
      "- File reading/research: \"Read src/os/types.ts and list all exported interfaces\"",
      "- Code search: \"Find all files that import from ./memory-store and list the import paths\"",
      "- Validation: \"Check if function X exists in file Y and describe its signature\"",
      "- Pre-flight checks: Before writing code, spawn an ephemeral to read the target file first",
      "- Post-write verification: After writing files, spawn an ephemeral to type-check immediately",
      "",
      "**Pattern: Scout before you act.** Before modifying any file, spawn an ephemeral to read it",
      "and summarize its current structure. This prevents blind edits and catches interface mismatches.",
      "",
      "**Pattern: Verify as you go.** After each significant code change, spawn an ephemeral to",
      "run tsc --noEmit. Don't wait until the end to discover type errors — catch them immediately.",
      "",
      "**Pattern: Parallel research.** When you need to understand multiple files, spawn multiple",
      "ephemerals simultaneously (up to 3 concurrent) to read them all at once.",
      "",
      "- `spawn_ephemeral` — { kind: \"spawn_ephemeral\", objective: \"...\", name?: \"type-checker\", model?: \"...\" }",
      "  Result written to blackboard at `ephemeral:<name>:<id>`. Read via `bb_read` next turn.",
      "  Default model: haiku (fast). Override with model: \"claude-sonnet-4-6\" for complex tasks.",
      "",
      "### Core Commands",
      "- `spawn_child` — { kind: \"spawn_child\", descriptor: { type, name, objective, priority?, capabilities? } } — spawn a single child process (immediate)",
      "  capabilities: { observationTools: [\"browser\", \"shell\"] } — observers with \"browser\" get concurrent-browser MCP tools (headless:false)",
      "- `spawn_graph` — declare a full process topology as a DAG. The kernel expands it into",
      "  immediate spawns and conditional deferrals. USE THIS for phased topologies.",
      "  { kind: \"spawn_graph\", nodes: [",
      "    { name: \"contract-designer\", type: \"lifecycle\", objective: \"...\", after: [] },",
      "    { name: \"contract-observer\", type: \"lifecycle\", objective: \"...\", after: [\"contract-designer\"], capabilities: { observationTools: [\"shell\"] } },",
      "    { name: \"scaffolder\", type: \"lifecycle\", objective: \"...\", after: [\"observation:passed:contract-observer\"] },",
      "    { name: \"scaffold-observer\", type: \"lifecycle\", objective: \"...\", after: [\"scaffolder\"], capabilities: { observationTools: [\"browser\", \"shell\"] } },",
      "    { name: \"auth-builder\", type: \"lifecycle\", objective: \"...\", after: [\"observation:passed:scaffold-observer\"] },",
      "    { name: \"worker-builder\", type: \"lifecycle\", objective: \"...\", after: [\"observation:passed:scaffold-observer\"] },",
      "    { name: \"backend-observer\", type: \"lifecycle\", objective: \"...\", after: [\"auth-builder\", \"worker-builder\"], capabilities: { observationTools: [\"browser\", \"shell\"] } },",
      "  ]}",
      "  `after` rules: [] = spawn immediately. Process name (no colon) = wait for process to die.",
      "  Blackboard key (contains colon) = wait for key to exist. Multiple entries = ALL must be met.",
      "  Parallel processes emerge naturally from sharing the same `after` dependencies.",
      "  Observer nodes MUST include `capabilities: { observationTools: [\"browser\", \"shell\"] }` to get",
      "  browser MCP tools (screenshots, console messages, network requests) and shell access.",
      "- `bb_write` — { kind: \"bb_write\", key: string, value: any } — write to shared blackboard",
      "- `bb_read` — { kind: \"bb_read\", keys: string[] } — request blackboard keys (results in next turn inbox)",
      "- `signal_emit` — { kind: \"signal_emit\", signal: string, payload?: any } — emit signal",
      "- `idle` — { kind: \"idle\", wakeOnSignals?: string[] } — wait for events",
      "  Tip: Use `tick:N` signals for periodic waking (e.g. wakeOnSignals: [\"tick:5\"] wakes every 5 ticks).",
      "  Combine with event signals: wakeOnSignals: [\"tick:5\", \"child:done\"] wakes on whichever comes first.",
      "- `checkpoint` — { kind: \"checkpoint\" } — save state for restart",
      "- `sleep` — { kind: \"sleep\", durationMs: number } — pause for duration",
      "- `request_kernel` — { kind: \"request_kernel\", question: string } — ask kernel for guidance",
      "- `self_report` — { kind: \"self_report\", efficiency: 0.7, blockers: [\"waiting for API\"], resourcePressure: \"medium\", suggestedAction: \"continue\" } — report own efficiency and resource needs",
      "- `exit` — { kind: \"exit\", code: number, reason: string } — terminate (MUST be last command)",
      "",
      "### System Process Commands",
      "- `spawn_system` — { kind: \"spawn_system\", name: string, command: string, args?: string[], env?: {} }",
      "  Spawn a real OS child process. stdout/stderr flow to blackboard as `shell:<name>:stdout`/`stderr`.",
      "  On exit, synthesizes an exit command with the shell exit code.",
      "",
      "### Sub-Kernel Commands (requires childKernel.enabled)",
      "- `spawn_kernel` — { kind: \"spawn_kernel\", name: string, goal: string, maxTicks?: number }",
      "  Spawn a child Forge kernel with its own process table and tick loop.",
      "  Child kernel snapshot published to `child_kernel:<name>:snapshot`. Final blackboard on exit.",
      "",
      "### IPC Patterns",
      "- **Blackboard**: Shared key-value store. All processes read/write. Use for publishing results. Race-free and durable.",
      "- **Signals**: Broadcast events. Children auto-emit `child:done` on exit. Listen via \"idle\" with \"wakeOnSignals\".",
      "  The kernel emits periodic tick:N cadence signals (tick:1 every tick, tick:5 every 5th, tick:10 every 10th).",
      "  Use tick:* glob to match any cadence. Ideal for polling daemons and orchestrator health checks.",
      "",
      "### Rules",
      "- `exit` MUST be the last command in the array",
      "- Write results (bb_write) BEFORE exit",
      "- Use native Write/Edit tools for file I/O — do NOT use OS commands for file operations",
      "- Always bb_write your results before exit — the blackboard is the durable record",
      "",
      "### Metacognitive Commands (issued by kernel, not by processes)",
      "The metacognitive kernel may modify the process topology at any time. Processes cannot",
      "issue these directly — they are reserved for the kernel's metacog agent:",
      "- `fork` — { kind: \"fork\", pid: string, newObjective?: string, newPriority?: number }",
      "  Clone a running process into a sibling that inherits the source's type, model, and config.",
      "  Used for speculative branching or parallel exploration of a sub-problem.",
      "- `evolve_blueprint` — { kind: \"evolve_blueprint\", sourceBlueprintId: string, mutations: { namePrefix?, roleChanges?, gatingChange? }, description: string }",
      "  Derive a new topology blueprint from an existing one by applying structural mutations.",
      "  The evolved blueprint inherits decayed Bayesian priors and starts with fresh usage stats.",
      "- `rewrite_dag` — { kind: \"rewrite_dag\", mutation: DagMutation, reason: string }",
      "  Restructure running topology mid-execution. Mutations: collapse_parallel_to_sequential,",
      "  fan_out, insert_checkpoint, merge_processes. Preserves blackboard state across rewrites.",
    ].join("\n");
  }

  /**
   * Build strategy guidance based on the process role and state.
   */
  private buildStrategySection(proc: OsProcess): string {
    // ── Goal Orchestrator: Decomposition (tick 0) ──
    // Gap 11: Match any top-level lifecycle process, not just "goal-orchestrator" by name.
    // This ensures evolved blueprints that spawn orchestrators with different names still
    // receive blueprint-driven decomposition guidance.
    if (!proc.parentPid && proc.type === "lifecycle") {
      // ── TICK 0: Scout Phase (skip if restarted orchestrator) ──
      // Spawn Haiku ephemerals to gather information. No tools, single-shot structured output.
      // If the orchestrator already has lifecycle children, it was restarted after dying —
      // skip scouting and go directly to phased orchestration with full blackboard context.
      if (proc.tickCount === 0) {
        const hasExistingChildren = this.processTableSnapshot?.some(
          p => p.parentPid === proc.pid && p.type === "lifecycle"
        ) ?? false;
        if (!hasExistingChildren) {
          return this.buildScoutPhasePrompt(proc);
        }
        // Fall through to phased orchestration for restarted orchestrator
      }

      // ── Goal Orchestrator: tick > 0 ──

      // ── ARCHITECT PHASE: scout results available, no lifecycle children yet ──
      // This means scouts have returned data but no real workers have been spawned.
      const hasLifecycleChildren = this.processTableSnapshot?.some(
        p => p.parentPid === proc.pid && p.type === "lifecycle"
      ) ?? false;
      const hasScoutResults = Object.keys(this.blackboardSnapshot ?? {}).some(
        k => k.startsWith("ephemeral:") || k.startsWith("scout:")
      );

      if (!hasLifecycleChildren && hasScoutResults) {
        return this.buildArchitectPhasePrompt(proc);
      }

      // Phased orchestration path (tick > 0, children already spawned)
      return [
        "## Strategy: Phased Orchestration",
        "",
        "You were woken by a child:done or tick signal. Your architecture lives on the blackboard.",
        "",
        "### Decision Tree",
        "1. **Restore context** — `bb_read` `architecture:plan` and `architecture:phase-tracker`",
        "   (they're also shown in the blackboard section above, but `bb_read` gets the full text)",
        "2. **Check process table** — are children from the current phase still running?",
        "   - If yes → go idle: `{ kind: \"idle\", wakeOnSignals: [\"child:done\"] }`",
        "3. **Current phase complete** — assess what was produced:",
        "   - Read blackboard keys written by completed children",
        "   - Did the phase succeed? Any gaps or issues?",
        "4. **More phases planned?**",
        "   - YES: Update `architecture:phase-tracker` (mark current phase done, advance currentPhase).",
        "     If needed, adjust the plan in `architecture:plan` based on what you learned.",
        "     Spawn next phase (1-3 processes, concise objectives). Go idle.",
        "   - NO (all phases done): Proceed to synthesis.",
        "",
        "### Synthesis (only when ALL phases are done)",
        "1. Read all blackboard entries and child results",
        "2. Identify contradictions or gaps between worker outputs",
        "3. Spawn a final integration/fix process if needed, or write output directly",
        "4. `bb_write` key `final_result`, then exit code 0",
        "",
        "### Context Engineering",
        "- `architecture:plan` is your north star — every spawned process can also `bb_read` it",
        "- `architecture:phase-tracker` is your progress state — update it every phase transition",
        "- Keep objectives concise (~200 chars). Workers get full context from the architecture docs",
        "- You designed the architecture, you maintain it, you adapt it as reality unfolds",
        "",
        "### CRITICAL",
        "- **PARENT-DEATH CASCADE**: If you exit, ALL living children die immediately. Only exit when ALL phases are done and synthesis is complete.",
        "- If any child is still running, go idle again — do NOT exit or synthesize yet",
      ].join("\n");
    }

    // ── Child Worker ──
    if (proc.type === "lifecycle" && proc.parentPid) {
      return [
        "## Strategy: Worker",
        "",
        "You are a WORKER — one cognitive sub-process within a larger topology designed",
        "to solve this problem. Your output will be synthesized with other workers' results,",
        "so thoroughness and correctness here directly determine the quality of the final product.",
        ...(proc.completionCriteria && proc.completionCriteria.length > 0 ? [
          "",
          "### Completion Criteria (you MUST satisfy ALL before exiting)",
          ...proc.completionCriteria.map((c, i) => `${i + 1}. ${c}`),
          "",
          "Your exit will be evaluated against these criteria. Stub or placeholder output does NOT satisfy them.",
        ] : []),
        "",
        "### Core Principle: Closed-Loop Verification",
        "",
        "You have observation tools: `bb_read` for blackboard state and shell output,",
        "`spawn_ephemeral` for scouting, and tool results for command output. USE THEM.",
        "A process that only writes and never reads is operating open-loop — it has no feedback,",
        "no error correction, no way to know if its actions achieved anything.",
        "",
        "After every meaningful action, observe whether reality changed the way you expected.",
        "If it didn't, correct and re-observe. The cycle is: **Act → Observe Effect → Fix or Proceed**.",
        "",
        "### Workflow",
        "1. **Start infrastructure if needed**: If building/testing software and no shell processes running",
        "   (check blackboard for `shell:*` keys), use `spawn_system` for dev server or build watcher.",
        "   Shell stdout/stderr flows to blackboard as `shell:<name>:stdout` — read it with `bb_read`.",
        "3. **Scout first**: Before modifying any file, spawn an ephemeral to read it and report its",
        "   current structure. Example: { kind: \"spawn_ephemeral\", objective: \"Read src/os/types.ts and",
        "   list all exported interfaces, types, and their fields\", name: \"scout-types\" }",
        "4. **Spawn parallel research ephemerals**: If you need to understand multiple files, spawn",
        "   multiple ephemerals simultaneously — they run concurrently (up to 3 at once).",
        "   Then bb_read their results on your next turn.",
        "5. **Do your work** — execute your objective.",
        "6. **Verify (CLOSED LOOP)** — use your observation tools (`bb_read`, `spawn_ephemeral`,",
        "   tool output) to confirm your actions had the intended effect. If they didn't, fix and",
        "   re-observe. Never pile new work on top of unverified work.",
        "7. Save findings to blackboard: `bb_write` key \"result:<your-name>\" with substantive output",
        "8. Write output files using your native Write tool if needed",
        "9. **Self-audit before exit**: Review your completionCriteria (if any). For each criterion,",
        "   cite OBSERVED EVIDENCE that it was met — not what you intended, but what you confirmed.",
        "   If you cannot point to an observation that proves a criterion, do more work or exit code 1.",
        "11. Exit: `{ kind: \"exit\", code: 0, reason: \"<summary with evidence>\", completionCriteriaMet: true }`",
        "   Set completionCriteriaMet to false if any criteria were not fully satisfied.",
        "",
        "### Ephemeral-First Mindset",
        "Ephemerals are cheap (Haiku), fast, and concurrent. Use them aggressively:",
        "- **Read before write**: Always scout target files via ephemeral before editing",
        "- **Type-check after each change**: Don't accumulate errors — catch them immediately",
        "- **Run tests early**: Spawn an ephemeral to run tests after each logical unit of work",
        "- **Search the codebase**: Need to find usages? Spawn an ephemeral to grep for them",
        "- **Validate assumptions**: Unsure about an interface? Spawn an ephemeral to check it",
        "Think of ephemerals as your eyes and ears — you are the brain, they are your senses.",
        "",
        "### Managed Shell Processes (spawn_system)",
        "Ephemerals and shell processes serve different purposes:",
        "",
        "**Ephemerals** = ask and forget. A single LLM turn that runs a task and returns.",
        "Good for: scouting files, type-checking, running tests, searching code.",
        "They die after one turn. You read results via bb_read on your next turn.",
        "",
        "**Shell processes** = start and monitor. A real OS subprocess managed by the kernel.",
        "It persists across your turns. Its stdout/stderr flows to the blackboard automatically.",
        "Good for: dev servers, watch-mode compilers, database processes, background services —",
        "anything you start once and interact with over time.",
        "",
        "When to use spawn_system:",
        "- Starting a dev server: spawn_system → write code → bb_read server output → fix errors → repeat",
        "- Running a database: spawn_system docker/postgres, then interact via your code",
        "- Watch-mode builds: spawn_system tsc --watch, check stderr for errors after each code change",
        "- Any process whose output you need to read on FUTURE turns (not just this one)",
        "",
        "Example:",
        "{ kind: \"spawn_system\", name: \"backend-server\", command: \"npx\", args: [\"nest\", \"start\", \"--watch\"] }",
        "Then on subsequent turns: { kind: \"bb_read\", keys: [\"shell:backend-server:stdout\", \"shell:backend-server:stderr\"] }",
        "",
        "### Command Ordering",
        "bb_write first, then exit LAST. Use native Write tool for file output.",
        "IMPORTANT: Always bb_write your results BEFORE exit — the blackboard is the durable record.",
        "",
        "### CRITICAL",
        "- Be thorough — your parent synthesizes your work with other workers",
      ].join("\n");
    }

    // ── Observer ──
    // Detection: structural only — process has observationTools capabilities.
    // Name-based heuristics are fragile; capabilities are set at spawn time by the
    // orchestrator and represent an explicit intent to observe.
    if ((proc.capabilities?.observationTools?.length ?? 0) > 0) {
      const toolsSection = this.buildObservationToolsSection(proc);
      return [
        "## Strategy: Observer",
        "",
        "You are an OBSERVER — an independent evaluator of composed artifacts.",
        "Your purpose is to verify that the system's outputs function correctly in their",
        "intended context. Self-verification by workers (checking their own work) is necessary",
        "but insufficient — the composed whole can fail even when all parts individually succeed.",
        "You provide the closed-loop grounding that turns claimed success into verified success.",
        "",
        "### Observation Principles",
        "1. **Context-appropriate observation** — experience the artifact the way its intended",
        "   audience would. The medium determines the method: a document is read for coherence;",
        "   a plan is simulated; a design is evaluated against requirements; a running process is",
        "   interacted with through its native interface; a proof is checked step by step.",
        "2. **Independence** — you are not the author; verify from scratch, assume nothing.",
        "   Do not trust prior structural checks as proof of correctness. Those are necessary",
        "   but not sufficient — they verify structure, not behavior.",
        "3. **Best-effort** — some artifacts cannot be fully observed in isolation. External",
        "   dependencies may be absent, credentials may not exist, or full interaction may",
        "   require a composed system that isn't ready yet. Verify WHAT YOU CAN — check",
        "   structural integrity, confirm partial behavior, verify readiness for the next phase.",
        "   Partial observation is infinitely more valuable than no observation. Explicitly",
        "   note what could NOT be verified so downstream observers can cover the gaps.",
        "   Report status 'partial' (not 'fail') when the artifact is sound but unverifiable aspects remain.",
        "4. **Specificity** — report exactly what you observed with evidence (screenshots, errors,",
        "   specific passages, exact output). 'Looks good' is worthless; concrete observations",
        "   with exact details are actionable.",
        "5. **Actionability** — when problems are found, write a structured diagnosis to the blackboard",
        "   that a fix process can act on without re-investigation. Include: what failed, where",
        "   (location within the artifact), the exact error or inconsistency, and your hypothesis",
        "   for the root cause.",
        "",
        "### Live Infrastructure Integration",
        "Read blackboard keys starting with 'shell:' to discover running infrastructure (servers,",
        "runtimes, services, watchers). Shell stdout/stderr are available at 'shell:<name>:stdout' and",
        "'shell:<name>:stderr'. Use this to find URLs, ports, readiness state, and any runtime output",
        "relevant to observation. If a shell process is running a service that serves the artifact,",
        "interact with the artifact through that live service rather than inspecting static files.",
        "",
        toolsSection,
        "",
        "### Workflow",
        "1. Read the blackboard to understand what was produced, where artifacts live, and what",
        "   the intended behavior is (contracts, plans, objectives from prior workers).",
        "   Read shell infrastructure keys to discover running services.",
        "2. Observe the composed artifact using your available tools in its live context.",
        "3. Write observation results to blackboard key 'observation:<your-process-name>':",
        "   { status: 'pass' | 'fail' | 'partial', findings: [...], evidence: [...] }",
        "4. If pass: signal_emit 'observation:passed:<your-process-name>' and exit code 0.",
        "5. If fail: write diagnosis to 'observation:diagnosis:<your-process-name>' with actionable",
        "   detail, signal_emit 'observation:failed:<your-process-name>', exit code 1.",
        "",
        "### Concurrency Safety",
        "Multiple observers may run in parallel, each verifying a different aspect of the",
        "composed artifact. Your blackboard keys and signals are namespaced by YOUR process",
        "name — never write to another observer's keys. The metacog aggregates all observation",
        "results and only declares success when ALL observers pass.",
        "",
        "### Command Ordering",
        "bb_read first (understand context), observe, bb_write results, then exit LAST.",
      ].join("\n");
    }

    // ── Daemon ──
    if (proc.type === "daemon") {
      return [
        "## Strategy: Daemon",
        "",
        "You are a persistent background process within the kernel.",
        "While other processes come and go, you persist — providing continuous monitoring,",
        "periodic work, and long-running awareness that the system depends on.",
        "Use channels/blackboard to share findings,",
        "then go idle with appropriate wake conditions.",
        "Do NOT exit — daemons persist across the run lifecycle.",
      ].join("\n");
    }

    // ── Event Handler ──
    if (proc.type === "event") {
      return [
        "## Strategy: Event Handler",
        "",
        "You are an event-driven process within the cognitive kernel.",
        "React to incoming signals and IPC messages swiftly and precisely",
        "using your full agent capabilities.",
        "Process the event, take actions, then go idle for the next event.",
      ].join("\n");
    }

    // ── Generic ──
    return [
      "## Strategy",
      "",
      "You are a process within the cognitive kernel with a clear objective",
      "and the full power of an agent to achieve it.",
      "Use spawn_child to delegate, blackboard for results, signals for coordination.",
    ].join("\n");
  }

  /**
   * Scout Phase prompt (tick 0): spawn Haiku ephemerals to gather information
   * before designing the architecture. This is fast and single-shot.
   */
  private buildScoutPhasePrompt(_proc: OsProcess): string {
    return [
      "## Strategy: Scout Phase",
      "",
      "You are the top-level ORCHESTRATOR. Before designing the topology, gather information.",
      "Your job on this turn is ONLY to dispatch scouts — fast Haiku ephemerals that explore",
      "the problem space and report back. You will design the architecture on your next turn.",
      "",
      "### Instructions",
      "1. Spawn 2-3 `spawn_ephemeral` scouts to gather information relevant to the goal:",
      "   - **codebase-scout**: Explore working directory structure, key files, existing patterns",
      "   - **domain-scout**: Research domain-specific context (web search, docs, prior art)",
      "   - **dependency-scout**: Check existing dependencies, tooling, infrastructure",
      "   Adapt scout objectives to the goal — not all goals need all three scout types.",
      "   Each scout should write its findings to a blackboard key prefixed with `scout:`",
      "   (e.g., `scout:codebase`, `scout:domain`, `scout:dependencies`).",
      "",
      "2. `bb_write` key `architecture:plan-draft` with a brief note: what you're planning to build",
      "   and what information you're waiting for from scouts. This is a placeholder — the full",
      "   architecture will be written on your next turn when scout data is available.",
      "",
      "3. Go idle: `{ kind: \"idle\", wakeOnSignals: [\"ephemeral:ready\"] }`",
      "",
      "### HARD CONSTRAINTS (kernel-enforced)",
      "- You MUST spawn at least 1 ephemeral scout — this is enforced by the kernel.",
      "- Do NOT design the full architecture yet — wait for scout results.",
      "- Do NOT spawn lifecycle children yet — scouts first, architecture second.",
      "- Keep scout objectives concise (~100 chars). They write results to blackboard.",
      "- You have NO native tools (Read, Grep, WebSearch, etc.) — scouts are your eyes and ears.",
      "",
      "You will wake when scouts return. Your next turn will have full information for design.",
    ].join("\n");
  }

  /**
   * Architect Phase prompt (tick 1+, scouts returned, no lifecycle children yet):
   * Design the full topology with category theory reasoning, blueprints, and rolling execution.
   * This is the full design prompt, informed by scout data on the blackboard.
   */
  private buildArchitectPhasePrompt(proc: OsProcess): string {
    const lines: string[] = [];

    // Detect retry: tickCount > 0 means this isn't the first architect attempt.
    // The orchestrator has been here before but failed to emit spawn commands.
    const hasArchitecture = this.blackboardSnapshot?.["architecture:plan"];
    if (proc.tickCount > 0 && hasArchitecture) {
      lines.push(
        "## ⚠ YOUR PREVIOUS TURN WAS REJECTED — YOU MUST SPAWN PROCESSES THIS TIME",
        "",
        "The kernel rejected your previous turn because your `commands` array contained",
        "ZERO spawn commands (`spawn_child` or `spawn_graph`). Your `bb_write` commands",
        "were preserved — `architecture:plan` and other keys are already on the blackboard.",
        "",
        "**You do NOT need to rewrite the architecture. Just spawn Phase 0 processes.**",
        "Your ONLY required action: include `spawn_graph` in your commands array.",
        "If you produce zero spawn commands again, this turn will ALSO be rejected.",
        "",
      );
    }

    lines.push(
      "## Strategy: Architecture Design (scouts complete)",
      "",
      "Your scouts have returned. Their findings are on the blackboard (`scout:` keys).",
      "Read them carefully — they contain the information you need to design the topology.",
      "Now design the full computation topology.",
      "",
      "You are the top-level ORCHESTRATOR — the architect of this computation.",
      "In this system, intelligence lives in the topology: which processes exist,",
      "how they coordinate, and what context flows between them. Your design",
      "decisions determine the entire run's success.",
      "Design the SHAPE of the computation, then spawn processes to execute it.",
      "You must NOT solve the task yourself — you must decompose and delegate.",
      "",
      "╔══════════════════════════════════════════════════════════════════════════════╗",
      "║ YOUR COMMANDS ARRAY **MUST** INCLUDE `spawn_graph` OR `spawn_child`.       ║",
      "║ Writing plans to blackboard via `bb_write` is NOT spawning.                ║",
      "║ The kernel WILL REJECT your turn if you go idle without spawn commands.    ║",
      "║                                                                            ║",
      "║ REQUIRED output pattern:                                                   ║",
      "║   commands: [                                                               ║",
      "║     { kind: 'bb_write', key: 'architecture:plan', value: {...} },          ║",
      "║     { kind: 'bb_write', key: 'architecture:phase-tracker', value: {...} }, ║",
      "║     { kind: 'bb_write', key: 'selected_blueprint', value: {...} },         ║",
      "║     { kind: 'spawn_graph', nodes: [                                        ║",
      "║       { name: 'phase0-worker', type: 'lifecycle', objective: '...',        ║",
      "║         priority: 40, after: [] },                                         ║",
      "║       { name: 'phase0-observer', type: 'lifecycle', objective: '...',      ║",
      "║         priority: 38, after: ['phase0-worker'] }                           ║",
      "║     ] },                                                                    ║",
      "║     { kind: 'idle', wakeOnSignals: ['child:done'] }                        ║",
      "║   ]                                                                         ║",
      "║                                                                            ║",
      "║ Think deeply about the architecture, but your commands array MUST contain  ║",
      "║ spawn_graph with actual process nodes. This is non-negotiable.             ║",
      "╚══════════════════════════════════════════════════════════════════════════════╝",
      "",
      "### Reasoning Framework: Category Theory",
      "",
      "Think of this task as a category where:",
      "- **Objects** = data states (inputs, intermediate products, final outputs)",
      "- **Morphisms** = transformations (what each spawned process does to data)",
      "- **Products** = parallel composition (independent work that runs simultaneously)",
      "- **Pullbacks** = joins (work that needs multiple inputs before it can proceed)",
      "- **Commutativity** = order-independence (if A and B don't depend on each other, parallelize)",
      "",
      "For every pair of subtasks, ask: are they independent (product) or does one need",
      "the other's output (composition)? For every join point: what are the minimum inputs",
      "needed before it can fire?",
      "",
      "### Design Process",
      "1. **Identify the objects** — what data exists at the start? What intermediate",
      "   artifacts are needed? What does the final output look like?",
      "2. **Identify the morphisms** — what transformations turn inputs into outputs?",
      "   Each morphism becomes a spawned child process.",
      "3. **Find the products** — which morphisms are independent? These can be parallel",
      "   `spawn_child` calls.",
      "4. **Find the pullbacks** — which morphisms need outputs from multiple predecessors?",
      "   These become nodes with multiple `after` entries in the `spawn_graph`.",
      "5. **Resolve shared boundaries (CONTRACT-FIRST)** — when parallel morphisms must",
      "   eventually compose into a single output, their interfaces are a shared dependency.",
      "   Spawn a contract-designer process FIRST that makes all composition boundaries",
      "   explicit: what each morphism produces, what each consumer expects, the exact",
      "   shape of every handoff point. Write these contracts to the blackboard and gate",
      "   all downstream workers on them. Workers implement TOWARD the contracts, not",
      "   toward each other. Without contracts, parallel workers make incompatible",
      "   assumptions about shared boundaries and the join phase becomes a second full",
      "   implementation pass. The principle: when you will decompose then recompose,",
      "   define the joints before the parts.",
      "6. **Plan observation** — the closed-loop primitive is: produce → observe → proceed.",
      "   Without observation, you are in open loop: produce → assume → proceed, and assumptions",
      "   compound through downstream layers.",
      "",
      "   Two things must match: **observation density** AND **production granularity**.",
      "   An observer paired with a monolithic producer that takes 5 ticks is still open-loop",
      "   for those 5 ticks. Observation that arrives too late is observation in name only.",
      "",
      "   ╔══════════════════════════════════════════════════════════════════════════╗",
      "   ║ ANTI-PATTERN: Build-everything-then-observe                             ║",
      "   ║                                                                         ║",
      "   ║ Spawning large-scope producers ('backend-core' that builds an entire    ║",
      "   ║ subsystem, 'write-document' that writes all sections, 'design-system'   ║",
      "   ║ that creates everything) with observers only at the END.                ║",
      "   ║ Even if observer processes exist in the topology, if they all fire       ║",
      "   ║ after all production completes, this is WATERFALL QA — not closed-loop. ║",
      "   ║                                                                         ║",
      "   ║ WRONG topology for a composed artifact:                                 ║",
      "   ║   contracts → backend-core → frontend-app → billing → observer          ║",
      "   ║   (observer waits for everything — errors cascade unchecked)             ║",
      "   ╚══════════════════════════════════════════════════════════════════════════╝",
      "",
      "   ✅ CORRECT PATTERN — Incremental slices with interleaved observation:",
      "   Decompose production into SMALL INCREMENTAL PHASES. Each phase produces one",
      "   verifiable increment. Pair each phase with an observer. Gate the NEXT phase on",
      "   the OBSERVER PASSING — not on the producer completing. The topology alternates:",
      "     produce → observe → produce → observe → produce → observe",
      "",
      "   This is a GENERAL principle — not specific to software. It applies to any",
      "   composed artifact where downstream parts depend on upstream correctness:",
      "   - Software: schema → observe → auth → observe → api → observe → frontend → observe",
      "   - Document: outline → review → section-1 → review → section-2 → review → final-review",
      "   - Design: requirements → evaluate → architecture → evaluate → prototype → evaluate",
      "   - Research: hypothesis → evidence → assess → refined-hypothesis → evidence → assess",
      "   - Plan: phase-1 → simulate → phase-2 → simulate → integration-check",
      "",
      "   CORRECT topology for a full-stack app (high composition):",
      "     contracts → contract-observer →",
      "     scaffold+schema → schema-observer →",
      "     auth-layer → auth-observer →",
      "     api-routes → api-observer →",
      "     frontend-shell → shell-observer →",
      "     dashboard-features → dashboard-observer →",
      "     integration-observer",
      "   Each observer gates the next producer. Errors caught at the source, not at the end.",
      "",
      "   **How finely to slice depends on composition complexity:**",
      "   - **High composition** (multi-phase builds, contract-first, parallel-then-compose):",
      "     Slice by LAYER/PHASE, not by subsystem. Each phase = one verifiable increment.",
      "     NEVER spawn a single process to build an entire subsystem — that's a monolith.",
      "     Gate downstream on OBSERVER PASSING, not on producer completing.",
      "   - **Moderate composition** (fan-out-fan-in, pipelines): observe after each parallel",
      "     wave or major phase transition. Not every step needs its own observer, but every",
      "     point where downstream correctness depends on upstream output does.",
      "   - **Low composition** (independent parallel, exploration, research): a final observer",
      "     after completion may suffice. Independent results that don't compose don't cascade.",
      "   - **Exploratory/generative**: observe at synthesis points, not during exploration.",
      "",
      "   **When observation IS needed, do it right:**",
      "   Gate each observer on its SPECIFIC producer(s) (process_dead_by_name), not on a",
      "   generic terminal condition (child:done). Observers gated on the same terminal fire",
      "   together at the end — that's waterfall QA in disguise, not distributed observation.",
      "   The observer examines the artifact the way its audience would experience it.",
      "   The medium determines the method: code is run; documents are read for coherence;",
      "   designs are evaluated against requirements; plans are simulated step by step.",
      "",
      "   **Best-effort observation**: some artifacts can't be fully verified in isolation.",
      "   Verify what you can — partial observation is infinitely more valuable than deferred",
      "   observation. Note what remains unverifiable so downstream observers cover the gaps.",
      "",
      "   When observation reveals problems, the observer writes a diagnosis to the blackboard",
      "   and targeted fix processes are spawned. If shell infrastructure is running,",
      "   observers should interact with the live artifact through it.",
      "7. **Design the topology** — spawn the full process graph.",
      "",
    );

    // Inject blueprint library
    lines.push(...this.buildBlueprintSection(proc.objective));

    lines.push(
      "",
      "### Rolling Execution (think holistically, act incrementally)",
      "",
      "Your architecture lives on the blackboard. You act one phase at a time.",
      "",
      "1. **Select or adapt a blueprint** — or invent a novel topology if nothing fits",
      "2. **Write the full architecture to blackboard** — this is your persistent working memory:",
      "   - `bb_write` key `architecture:plan` — product choice, tech stack, database schema,",
      "     API routes, file ownership map, integration points, and the FULL phase plan",
      "     with every phase described. This document is your north star.",
      "   - `bb_write` key `architecture:phase-tracker` — JSON: `{ currentPhase: 0, phases: [",
      "       { id: 0, name: \"contracts\", status: \"active\", processes: [...], notes: \"\" },",
      "       { id: 1, name: \"scaffold\", status: \"pending\", ... }, ...`",
      "     `]}`",
      "   - `bb_write` key `selected_blueprint` — blueprint choice",
      "3. **Spawn infrastructure** — if the goal needs persistent processes (servers, runtimes):",
      "   - `spawn_system` to launch managed shell processes",
      "   - Shell output flows to blackboard as `shell:<name>:stdout`/`stderr`",
      "4. **Spawn ONLY Phase 0** (1-3 processes). Keep objectives concise (~200 chars).",
      "   Each process can `bb_read` `architecture:plan` for full context.",
      "   Use `spawn_child` for single processes, `spawn_graph` for 2-5 within-phase nodes.",
      "",
      "   `spawn_graph` is for **within-phase parallelism** (2-5 nodes max). NOT for entire topologies.",
      "   `after` rules: [] = immediate. Process name = wait for it to die. Key with colon = wait",
      "   for blackboard key. Multiple entries = ALL must be met.",
      "",
      "   **Gating chains MUST respect observation**: gate downstream on the OBSERVER passing,",
      "   not on the producer completing. after: [\"observation:passed:X-observer\"] NOT after: [\"X-builder\"].",
      "",
      "   **Best-effort observation**: verify what you can — partial observation beats none.",
      "   On failure: diagnosis → `observation:diagnosis:<name>`,",
      "   signal → `observation:failed:<name>`. Fix processes spawned, then re-observe.",
      "5. **Go idle**: `{ kind: \"idle\", wakeOnSignals: [\"child:done\"] }`",
      "",
      "You will wake on each child:done. Each waking is a new decision point where you",
      "assess results, update the phase tracker, and spawn the next phase. The kernel",
      "drives this loop — you don't need to plan the timing, just respond to what happened.",
    );

    // Inject learned heuristics as proactive spawn-time rules
    const learnedRules = this.buildLearnedSpawnRules();
    if (learnedRules) {
      lines.push("", learnedRules);
    }

    // Inject learned scheduling strategies
    const learnedStrategies = this.buildLearnedStrategiesSection();
    if (learnedStrategies) {
      lines.push("", learnedStrategies);
    }

    lines.push(
      "",
      "### HARD CONSTRAINTS (kernel-enforced)",
      "",
      "**CRITICAL: Your structured output MUST include `spawn_child` or `spawn_graph` commands.",
      "Writing topology to blackboard via `bb_write` is NOT spawning. You must emit actual",
      "spawn commands as JSON objects in your commands array. The kernel checks for spawn",
      "commands in your structured output — bb_write + idle alone WILL BE REJECTED.**",
      "",
      "Example of CORRECT structured output (commands array):",
      "```",
      "{ kind: 'bb_write', key: 'architecture:plan', value: { ... } },",
      "{ kind: 'bb_write', key: 'architecture:phase-tracker', value: { ... } },",
      "{ kind: 'bb_write', key: 'selected_blueprint', value: { ... } },",
      "{ kind: 'spawn_graph', nodes: [",
      "  { name: 'phase0-designer', type: 'lifecycle', objective: '...', priority: 60, after: [] },",
      "  { name: 'phase0-observer', type: 'lifecycle', objective: '...', priority: 55, after: ['phase0-designer'] },",
      "  { name: 'phase1-builder', type: 'lifecycle', objective: '...', priority: 60, after: ['observation:passed:phase0-observer'] },",
      "  { name: 'phase1-observer', type: 'lifecycle', objective: '...', priority: 55, after: ['phase1-builder'] }",
      "] },",
      "{ kind: 'idle', wakeOnSignals: ['child:done'] }",
      "```",
      "",
      "NOTE: phase1-builder gates on 'observation:passed:phase0-observer' (a blackboard key),",
      "NOT on 'phase0-observer' (process death). This ensures phase 1 only starts after phase 0",
      "observation PASSES — not merely after the observer finishes. The observer writes this key",
      "when it confirms the phase's outputs are correct. This is the critical gating pattern.",
      "",
      "- The kernel WILL REJECT your turn if you go idle without spawning lifecycle children.",
      "  You MUST spawn workers on this turn — scouts are done, it's time to build.",
      "- You MUST spawn at least 1 child process — this is enforced, not requested.",
      "- You MUST write `architecture:plan` and `architecture:phase-tracker` to blackboard.",
      "- Observation density MUST match composition complexity. High-composition topologies",
      "  (parallel workers composing into a whole) require observers at each composition",
      "  boundary, with downstream work gated on observation passing. Low-composition",
      "  topologies (independent parallel work) need at minimum a final observer.",
      "  ALL observers must be gated on SPECIFIC processes (process_dead_by_name), not on",
      "  generic terminal conditions (child:done). Observers that all fire on the same",
      "  terminal condition are a waterfall QA phase — this is the anti-pattern.",
      "",
      "### Additional Requirements",
      "- MUST write selected_blueprint to blackboard (this tracks which patterns work)",
      "- Apply priority gradient: min 2pt between siblings, synthesis BELOW all workers",
      "- Do NOT do the work yourself — decompose and delegate",
      "- Define completionCriteria for each child: what SPECIFIC outputs constitute \"done\"",
      "  Example: completionCriteria: [\"Express server running on port 3001\", \"All 3 endpoints respond correctly\"]",
      "  NOT: [\"implement the backend\"] — that's the objective, not a completion criterion",
      "- Tell each child HOW to verify its work in the objective text — what observation",
      "  tools to use and what evidence to look for. Workers that exit without observing",
      "  the effects of their actions will be flagged by the metacog.",
      "- Children are full Claude Code agents — they can read/write files, run code, etc.",
      "- For file-writing objectives: tell each child which files they own",
      "- **PARENT-DEATH CASCADE**: By default, children have onParentDeath='cascade' — if YOU exit, ALL children die immediately. You MUST stay alive (idle/sleeping) until ALL children have completed. Do NOT exit prematurely thinking children are 'self-propagating'.",
      "",
      "### FINAL REMINDER — READ THIS LAST",
      "",
      "Your `commands` array MUST contain `spawn_graph` (or `spawn_child`). Example:",
      "```",
      "{ kind: 'spawn_graph', nodes: [",
      "  { name: 'scaffold-builder', type: 'lifecycle', objective: '...', priority: 60, after: [] },",
      "  { name: 'scaffold-observer', type: 'lifecycle', objective: '...', priority: 55, after: ['scaffold-builder'] },",
      "  { name: 'impl-builder', type: 'lifecycle', objective: '...', priority: 60, after: ['observation:passed:scaffold-observer'] }",
      "] }",
      "```",
      "Gate downstream phases on `observation:passed:<observer-name>`, NOT on producer death.",
      "bb_write alone = REJECTED. spawn_graph = REQUIRED. This is kernel-enforced.",
    );
    return lines.join("\n");
  }

  /**
   * Build the observation tools section for an observer process.
   * Dynamically populated based on the process's capabilities.observationTools.
   */
  private buildObservationToolsSection(proc: OsProcess): string {
    const tools = proc.capabilities?.observationTools ?? [];
    const sections: string[] = ["### Available Observation Tools"];

    if (tools.includes("browser")) {
      sections.push(
        "",
        "**Browser (concurrent-browser-mcp)** — You have access to an independent browser instance",
        "for observing artifacts that are experienced visually or interactively.",
        "",
        "IMPORTANT: When creating browser instances, ALWAYS use `headless: false` so the operator",
        "can see the browser window on their screen. This is required for visual verification.",
        "",
        "Use these tools to interact with running services discovered via shell infrastructure:",
        "- `browser_create_instance` — create a browser (ALWAYS set headless: false)",
        "- `browser_navigate` — navigate to a URL",
        "- `browser_screenshot` — capture visual screenshot as evidence",
        "- `browser_get_markdown` — get page content as markdown (best for understanding page state)",
        "- `browser_click` — interact with elements",
        "- `browser_type` — type into fields",
        "- `browser_get_element_text` — read element text content",
        "- `browser_evaluate` — run JavaScript in the page context",
        "- `browser_console_messages` — read console logs (errors, warnings, info) from the page",
        "- `browser_network_requests` — inspect network requests (find failed API calls, 4xx/5xx responses)",
        "- `browser_close_instance` — close the browser when done",
        "",
        "Workflow: create_instance(headless:false) → navigate → screenshot/get_markdown → console_messages/network_requests → verify → close_instance",
      );
    }

    if (tools.includes("http")) {
      sections.push(
        "",
        "**HTTP** — Use Bash to make HTTP requests (curl, httpie) to verify endpoints,",
        "check response codes, validate response bodies. Read shell infrastructure keys to",
        "find service URLs and ports.",
      );
    }

    if (tools.includes("shell")) {
      sections.push(
        "",
        "**Shell** — Use Bash to run the artifact directly, execute verification commands,",
        "check process output, verify state. Read shell infrastructure keys",
        "for context on running services and runtimes.",
      );
    }

    if (tools.length === 0) {
      sections.push(
        "",
        "Use your standard tools (Read, Bash, Glob) to examine the artifacts.",
        "Read shell infrastructure blackboard keys for context on running services.",
      );
    }

    return sections.join("\n");
  }

  /**
   * Build learned spawn-time rules from heuristics.
   * These are injected into the goal-orchestrator's decomposition prompt so it
   * proactively applies patterns that metacog previously had to correct reactively.
   */
  private buildLearnedSpawnRules(): string | null {
    if (this.heuristicsSnapshot.length === 0) return null;

    // Categorize heuristics by pattern
    const priorityRules: OsHeuristic[] = [];
    const gatingRules: OsHeuristic[] = [];
    const livenessRules: OsHeuristic[] = [];
    const otherRules: OsHeuristic[] = [];

    for (const h of this.heuristicsSnapshot) {
      const text = `${h.heuristic} ${h.context}`.toLowerCase();
      if (text.includes("priority") || text.includes("contention") || text.includes("gradient")) {
        priorityRules.push(h);
      } else if (text.includes("synth") || text.includes("gate") || text.includes("checkpoint") || text.includes("idle")) {
        gatingRules.push(h);
      } else if (text.includes("liveness") || text.includes("stall") || text.includes("token")) {
        livenessRules.push(h);
      } else {
        otherRules.push(h);
      }
    }

    const lines: string[] = [
      "### Learned Patterns (from prior runs)",
      "",
      "These rules were learned from previous execution outcomes. Apply them at spawn time.",
      "",
    ];

    if (priorityRules.length > 0) {
      lines.push("**Priority Management** (MANDATORY):");
      lines.push("- NEVER spawn sibling workers at the same priority. Use a 2-point gradient (e.g., 87, 85, 83).");
      lines.push("- Synthesis/aggregation processes MUST have lower priority than all workers they depend on.");
      for (const h of priorityRules.slice(0, 3)) {
        lines.push(`  - [confidence=${h.confidence.toFixed(2)}] ${h.heuristic}`);
      }
      lines.push("");
    }

    if (gatingRules.length > 0) {
      lines.push("**Synthesis Gating** (MANDATORY):");
      lines.push("- Synthesis workers should use `idle` with `wakeOnSignals: [\"child:done\"]` to gate on dependencies.");
      lines.push("- Do NOT rely on DAG edges for gating — use IPC idle-gate or checkpoint-gate patterns.");
      for (const h of gatingRules.slice(0, 3)) {
        lines.push(`  - [confidence=${h.confidence.toFixed(2)}] ${h.heuristic}`);
      }
      lines.push("");
    }

    if (livenessRules.length > 0) {
      lines.push("**Liveness**:");
      for (const h of livenessRules.slice(0, 2)) {
        lines.push(`- [confidence=${h.confidence.toFixed(2)}] ${h.heuristic}`);
      }
      lines.push("");
    }

    if (otherRules.length > 0) {
      lines.push("**Other learned patterns**:");
      for (const h of otherRules.slice(0, 3)) {
        lines.push(`- [confidence=${h.confidence.toFixed(2)}] ${h.heuristic}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Build the learned scheduling strategies section for goal-orchestrator prompts.
   * Shows top 5 strategies sorted by success rate so the orchestrator can apply them.
   */
  private buildLearnedStrategiesSection(): string | null {
    if (this.strategiesSnapshot.length === 0) return null;

    const top5 = this.strategiesSnapshot.slice(0, 5);
    const lines: string[] = [
      "## Previously Successful Strategies",
      "",
      "These scheduling strategies have worked well in prior runs. Apply them to your spawn decisions.",
      "",
    ];

    for (const strategy of top5) {
      const total = strategy.outcomes.successes + strategy.outcomes.failures;
      const successRate = total > 0 ? (strategy.outcomes.successes / total * 100).toFixed(0) + '%' : 'no data';
      lines.push(`**${strategy.description}** (success rate: ${successRate})`);
      if (strategy.conditions.length > 0) {
        lines.push(`  Conditions: ${strategy.conditions.join(', ')}`);
      }
      if (strategy.adjustments.favorPatterns && strategy.adjustments.favorPatterns.length > 0) {
        lines.push(`  Favor: ${strategy.adjustments.favorPatterns.join(', ')}`);
      }
      if (strategy.adjustments.disfavorPatterns && strategy.adjustments.disfavorPatterns.length > 0) {
        lines.push(`  Disfavor: ${strategy.adjustments.disfavorPatterns.join(', ')}`);
      }
      if (strategy.adjustments.priorityBias) {
        const biasEntries = Object.entries(strategy.adjustments.priorityBias)
          .map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`)
          .join(', ');
        lines.push(`  Priority adjustments: ${biasEntries}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build the blueprint selection section for goal-orchestrator decomposition.
   * Presents ranked blueprints with their track records.
   */
  private buildBlueprintSection(objective: string): string[] {
    const lines: string[] = [];

    if (this.blueprintsSnapshot.length === 0) {
      lines.push(
        "### Available Topology Patterns",
        "",
        "No blueprints available. Design a topology from first principles.",
        "",
        "Common patterns: parallel (N independent workers), pipeline (A→B→C chain),",
        "fan-out/fan-in (N workers + synthesizer).",
      );
      return lines;
    }

    // Blueprints are reference patterns, not mandates. The orchestrator should
    // design from first principles and use blueprints as starting points to adapt.
    lines.push('Blueprints below are reference topologies learned from prior runs. Use them as starting points — adapt, combine, or design a novel topology when the problem structure demands it. The right topology emerges from analyzing the task\'s composition boundaries, not from pattern-matching to a template. Always record your choice via bb_write "selected_blueprint" (use "novel:<name>" for original designs).');
    lines.push('');

    // Goal type analysis (4e)
    const goalTags = extractGoalTags(objective);
    if (goalTags.length > 0) {
      const primaryTag = goalTags[0]!;
      lines.push(`Goal Analysis: This goal matches type(s): ${goalTags.join(', ')}. Blueprints ranked by success rate for ${primaryTag} goals.`);
      lines.push('');
    }

    lines.push("### Available Blueprints (ranked by relevance)");
    lines.push("");

    for (const bp of this.blueprintsSnapshot.slice(0, 6)) {
      const stats = bp.stats ?? { uses: 0, successes: 0, failures: 0, avgTokenEfficiency: 0, avgWallTimeMs: 0, lastUsedAt: "", alpha: 1, beta: 1, tagStats: {} };
      const rawRate = stats.uses > 0
        ? `${stats.successes}/${stats.uses} (${Math.round((stats.successes / stats.uses) * 100)}%)`
        : "no track record yet";

      // Bayesian confidence from Beta distribution
      const alpha = stats.alpha ?? 1;
      const beta = stats.beta ?? 1;
      const bayesianMean = alpha / (alpha + beta);
      const bayesianInfo = stats.uses > 0
        ? `  Bayesian: mean=${bayesianMean.toFixed(2)} α=${alpha.toFixed(1)} β=${beta.toFixed(1)}`
        : "";

      const roles = bp.roles.map((r) => {
        const card = r.cardinality === "per-subtask" ? "N" : "1";
        return `${card}x ${r.name}`;
      }).join(", ");

      lines.push(`**${bp.name}** [${bp.source}] — id: \`${bp.id}\``);
      lines.push(`  ${bp.description}`);
      lines.push(`  Success: ${rawRate}  |  Roles: ${roles}`);
      if (bayesianInfo) lines.push(bayesianInfo);
      lines.push(`  Gating: ${bp.gatingStrategy}  |  Priority: ${bp.priorityStrategy}`);
      if (bp.stats.uses > 0) {
        lines.push(`  Avg tokens: ${Math.round(bp.stats.avgTokenEfficiency)}  |  Avg wall: ${Math.round(bp.stats.avgWallTimeMs / 1000)}s`);
      }

      // Show per-tag stats when available
      const tagStats = bp.stats.tagStats;
      if (tagStats && Object.keys(tagStats).length > 0) {
        const tagEntries = Object.entries(tagStats)
          .filter(([, ts]) => ts.observations >= 2)
          .map(([tag, ts]) => `${tag}:${(ts.alpha / (ts.alpha + ts.beta)).toFixed(2)}(n=${ts.observations})`)
          .join(", ");
        if (tagEntries) {
          lines.push(`  Per-tag confidence: ${tagEntries}`);
        }
      }

      // Show role details
      for (const role of bp.roles) {
        const wake = role.wakeCondition
          ? ` (waits for: ${role.wakeCondition.signals?.join(",") ?? ""})`
          : "";
        lines.push(`    - ${role.name} [${role.type}] offset=${role.priorityOffset} spawn=${role.spawnTiming}${wake}`);
        lines.push(`      template: "${role.objectiveTemplate}"`);
      }

      lines.push("");
    }

    return lines;
  }

  /**
   * Build an addendum with pending IPC messages and signals for a process.
   */
  buildIpcAddendum(
    signals: Array<{ name: string; payload?: unknown }>,
  ): string {
    const lines: string[] = [];

    if (signals.length > 0) {
      lines.push("## Pending Signals");
      for (const sig of signals) {
        lines.push(`- ${sig.name}${sig.payload ? `: ${JSON.stringify(sig.payload)}` : ""}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Parse structured JSON response from a process turn.
   * Used as fallback when no command file exists (backward compat with mocks).
   */
  parseProcessResponse(
    pid: string,
    rawResponse: string,
  ): { commands: OsProcessCommand[]; tokensEstimate: number } {
    const tokensEstimate = Math.ceil(rawResponse.length / 4);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawResponse);
    } catch {
      return { commands: [], tokensEstimate };
    }

    if (!parsed || typeof parsed !== "object") {
      return { commands: [], tokensEstimate };
    }

    const obj = parsed as Record<string, unknown>;
    const rawCommands = Array.isArray(obj.commands) ? obj.commands : [];

    const commands: OsProcessCommand[] = [];
    for (const cmd of rawCommands) {
      const validated = this.validateProcessCommand(cmd);
      if (validated) {
        commands.push(validated);
      }
    }

    return { commands, tokensEstimate };
  }

  /**
   * Validate a single process command. Returns null for invalid commands.
   */
  private validateProcessCommand(cmd: unknown): OsProcessCommand | null {
    if (!cmd || typeof cmd !== "object") return null;
    const c = cmd as Record<string, unknown>;

    switch (c.kind) {
      case "sleep":
        if (typeof c.durationMs === "number" && c.durationMs > 0) {
          return { kind: "sleep", durationMs: c.durationMs };
        }
        return null;

      case "idle":
        return {
          kind: "idle",
          wakeOnSignals: Array.isArray(c.wakeOnSignals) ? c.wakeOnSignals.filter((s): s is string => typeof s === "string") : undefined,
        };

      case "checkpoint":
        return { kind: "checkpoint" };

      case "spawn_child": {
        const desc = c.descriptor as Record<string, unknown> | undefined;
        if (
          desc &&
          typeof desc === "object" &&
          typeof desc.type === "string" &&
          typeof desc.name === "string" &&
          typeof desc.objective === "string" &&
          ["daemon", "lifecycle", "event"].includes(desc.type)
        ) {
          return {
            kind: "spawn_child",
            descriptor: {
              type: desc.type as "daemon" | "lifecycle" | "event",
              name: desc.name,
              objective: desc.objective,
              priority: typeof desc.priority === "number" ? desc.priority : undefined,
            },
          };
        }
        return null;
      }

      case "bb_write":
        if (typeof c.key === "string") {
          return { kind: "bb_write", key: c.key, value: c.value };
        }
        return null;

      case "bb_read":
        if (Array.isArray(c.keys) && c.keys.every((k: unknown) => typeof k === "string")) {
          return { kind: "bb_read", keys: c.keys as string[] };
        }
        return null;

      case "signal_emit":
        if (typeof c.signal === "string") {
          return { kind: "signal_emit", signal: c.signal, payload: c.payload };
        }
        return null;

      case "request_kernel":
        if (typeof c.question === "string") {
          return { kind: "request_kernel", question: c.question };
        }
        return null;

      case "exit":
        return {
          kind: "exit",
          code: typeof c.code === "number" ? c.code : 1,
          reason: typeof c.reason === "string" ? c.reason : "process exited",
        };

      case "self_report": {
        const efficiency = typeof c.efficiency === "number"
          ? Math.max(0, Math.min(1, c.efficiency))
          : 0.5;
        const resourcePressure = (["low", "medium", "high"] as const).includes(c.resourcePressure as "low" | "medium" | "high")
          ? c.resourcePressure as "low" | "medium" | "high"
          : "medium";
        const suggestedAction = (["continue", "need_help", "should_die", "need_more_budget"] as const).includes(c.suggestedAction as "continue" | "need_help" | "should_die" | "need_more_budget")
          ? c.suggestedAction as "continue" | "need_help" | "should_die" | "need_more_budget"
          : "continue";
        return {
          kind: "self_report",
          efficiency,
          blockers: Array.isArray(c.blockers)
            ? c.blockers.filter((b): b is string => typeof b === "string")
            : [],
          resourcePressure,
          suggestedAction,
          reason: typeof c.reason === "string" ? c.reason : undefined,
        };
      }

      case "spawn_ephemeral":
        if (typeof c.objective === "string" && c.objective.length > 0) {
          return {
            kind: "spawn_ephemeral",
            objective: c.objective,
            name: typeof c.name === "string" ? c.name : undefined,
            model: typeof c.model === "string" ? c.model : undefined,
          };
        }
        return null;

      case "spawn_system":
        if (typeof c.name === "string" && typeof c.command === "string") {
          return {
            kind: "spawn_system",
            name: c.name,
            command: c.command,
            args: Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === "string") : undefined,
            env: c.env && typeof c.env === "object" ? c.env as Record<string, string> : undefined,
          };
        }
        return null;

      case "spawn_kernel":
        if (typeof c.name === "string" && typeof c.goal === "string") {
          return {
            kind: "spawn_kernel",
            name: c.name,
            goal: c.goal,
            maxTicks: typeof c.maxTicks === "number" ? c.maxTicks : undefined,
          };
        }
        return null;

      case "spawn_graph": {
        const rawNodes = Array.isArray(c.nodes) ? c.nodes : [];
        const validNodes: import("./types.js").SpawnGraphNode[] = [];
        for (const n of rawNodes) {
          if (
            n && typeof n === "object" &&
            typeof (n as Record<string, unknown>).name === "string" &&
            typeof (n as Record<string, unknown>).type === "string" &&
            ["daemon", "lifecycle", "event"].includes((n as Record<string, unknown>).type as string) &&
            typeof (n as Record<string, unknown>).objective === "string" &&
            Array.isArray((n as Record<string, unknown>).after)
          ) {
            const node = n as Record<string, unknown>;
            validNodes.push({
              name: node.name as string,
              type: node.type as "daemon" | "lifecycle" | "event",
              objective: node.objective as string,
              priority: typeof node.priority === "number" ? node.priority : undefined,
              completionCriteria: Array.isArray(node.completionCriteria)
                ? (node.completionCriteria as unknown[]).filter((s): s is string => typeof s === "string")
                : undefined,
              after: (node.after as unknown[]).filter((s): s is string => typeof s === "string"),
            });
          }
        }
        if (validNodes.length > 0) {
          return { kind: "spawn_graph", nodes: validNodes };
        }
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Get or create a persistent thread for a process.
   */
  private getOrCreateThread(proc: OsProcess): ThreadEntry {
    const existing = this.threads.get(proc.pid);
    if (existing) return existing;

    // Goal orchestrator gets read-only access + web search to force delegation.
    // It can read/explore the codebase and search the web, but must spawn
    // child processes to write files. OS commands (spawn_child, bb_write, etc.)
    // still work since they go through the kernel's JSON command parsing.
    const isGoalOrchestrator = proc.name === "goal-orchestrator";

    // Observer processes with browser capabilities get the concurrent-browser MCP server
    // injected per-thread. This keeps MCP scoped to processes that need it.
    const needsBrowserMcp = proc.capabilities?.observationTools?.includes("browser") && this.browserMcpConfig;
    const mcpServers = needsBrowserMcp
      ? { "concurrent-browser": this.browserMcpConfig! }
      : undefined;

    const thread = this.client.startThread({
      model: proc.model,
      workingDirectory: proc.workingDir,
      // "orchestrator-read-only" is a custom mode handled by the Brain adapter:
      // gives Read, Glob, Grep, WebSearch, WebFetch but no Write/Edit/Bash.
      sandboxMode: (isGoalOrchestrator ? "orchestrator-read-only" : "danger-full-access") as "danger-full-access",
      ...(mcpServers ? { mcpServers } : {}),
    });

    const entry: ThreadEntry = { thread, turnCount: 0 };
    this.threads.set(proc.pid, entry);
    return entry;
  }

  // ─── Checkpoint-Restore (GAP-7) ──────────────────────────────────

  canCheckpoint(pid: string): boolean {
    return this.threads.has(pid);
  }

  captureCheckpointState(pid: string): ExecutorCheckpointState | null {
    const entry = this.threads.get(pid);
    if (!entry) return null;
    return {
      kind: "llm",
      threadSessionId: (entry.thread as any).id ?? null,
      turnCount: entry.turnCount,
    };
  }

  restoreFromCheckpoint(_pid: string, _state: ExecutorCheckpointState): void {
    // No-op: fresh thread is created lazily on next executeOne().
    // Checkpoint context is injected via buildProcessPrompt() from proc.checkpoint.
  }

  /**
   * Dispose thread for a process (on death).
   * Aborts any in-flight LLM call so we don't waste tokens.
   */
  dispose(pid: string): void {
    const entry = this.threads.get(pid);
    if (entry) {
      entry.thread.abort();
      this.threads.delete(pid);
    }
  }

  /**
   * Alias for dispose — backward compatibility with kernel code that calls disposeThread.
   */
  disposeThread(pid: string): void {
    this.dispose(pid);
  }

  /**
   * Get the current thread for a process (for testing/inspection).
   */
  getThread(pid: string): ThreadEntry | undefined {
    return this.threads.get(pid);
  }

  /**
   * Get number of active threads.
   */
  get threadCount(): number {
    return this.threads.size;
  }
}
