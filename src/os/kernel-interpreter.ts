/**
 * KernelInterpreter — thin I/O shell that executes effects.
 *
 * Design principle: ZERO decision logic. The transition function already
 * decided what to do and expressed it as effects. The interpreter just
 * maps those effects to I/O calls (LLM, timers, protocol emitting) and
 * enqueues completion events back into the EventQueue.
 *
 * The interpreter:
 *   - Receives read-only state for context (e.g., process config)
 *   - NEVER mutates state
 *   - Executes I/O (LLM calls, timers, protocol emit)
 *   - Enqueues events into the EventQueue on async completion
 */

import type { Brain, BrainThread, BrainProvider } from "../types.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";
import type { ScopedMemoryStore } from "./scoped-memory-store.js";
import { EventQueue } from "./event-queue.js";
import { OsMetacognitiveAgent } from "./metacog-agent.js";
import { BrainLensAdapter } from "../lens/brain-lens-adapter.js";
import type { KernelState } from "./state-machine/state.js";
import type { KernelEffect } from "./state-machine/effects.js";
import type { OsSystemSnapshot } from "./types.js";

/** Worker system prompt — tells the LLM how to format its response. */
const WORKER_SYSTEM_PROMPT = `You are a worker process in a cognitive kernel. Your job is to accomplish your objective and report results.

IMPORTANT: End your response with a JSON command block wrapped in \`\`\`json fences:

\`\`\`json
{
  "commands": [
    { "kind": "bb_write", "key": "result:your-name", "value": "your result here" },
    { "kind": "exit", "reason": "completed" }
  ]
}
\`\`\`

Available commands:
- bb_write(key, value): Write a result to the shared blackboard. Use "result:<your-process-name>" as the key.
- spawn_ephemeral(objective, name?): Spawn a lightweight scout to explore or investigate something concurrently. The scout runs in parallel and its result is written to the blackboard at "ephemeral:<name>:<id>". You can spawn multiple ephemerals and then idle to wait for their results.
- exit(reason?, code?): You're done. Use code=0 for success. Always exit when your work is complete.
- idle(wakeOnSignals?): Pause and wait for new information (e.g. ephemeral results arriving on the blackboard).
- sleep(durationMs): Pause for a duration.

## When to use ephemerals

If your objective involves multiple independent sub-tasks — reading several files, researching different topics, exploring different approaches — spawn ephemerals to do them in parallel instead of doing everything sequentially yourself. Each ephemeral is a fast, focused scout. Example workflow:

1. Analyze your objective and identify independent sub-investigations
2. Spawn an ephemeral for each one: { "kind": "spawn_ephemeral", "objective": "Read and summarize src/foo.ts", "name": "scout-foo" }
3. Idle to wait: { "kind": "idle" }
4. When you wake, read ephemeral results from the blackboard and synthesize

This is significantly faster than doing everything yourself for tasks with 3+ independent parts.

If you don't include a command block, the kernel will auto-write your full response to the blackboard and exit you.
`;

export class KernelInterpreter {
  private readonly brain: Brain;
  private readonly emitter: OsProtocolEmitter | null;
  private readonly queue: EventQueue;
  private readonly memoryStore: ScopedMemoryStore | null;
  private readonly workingDir: string;
  private readonly lensAdapter: BrainLensAdapter | null;

  /** Active wall-clock timers (keyed by timer name). */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** Cached BrainThread per process pid (for multi-turn LLM conversations). */
  private readonly threads = new Map<string, BrainThread>();

  /** Cached metacognitive agent instance (created lazily). */
  private metacogAgent: OsMetacognitiveAgent | null = null;

  constructor(
    brain: Brain,
    emitter: OsProtocolEmitter | null,
    queue: EventQueue,
    memoryStore: ScopedMemoryStore | null,
    workingDir: string,
    provider?: BrainProvider,
  ) {
    this.brain = brain;
    this.emitter = emitter;
    this.queue = queue;
    this.memoryStore = memoryStore;
    this.workingDir = workingDir;
    this.lensAdapter = emitter && provider
      ? new BrainLensAdapter({ emitter, provider })
      : null;
  }

  /**
   * Execute a single effect. Fire-and-forget for async I/O — completion
   * events are enqueued into the EventQueue when the I/O resolves.
   */
  async interpret(effect: KernelEffect, state: KernelState): Promise<void> {
    switch (effect.type) {
      // ── Protocol observability ────────────────────────────────
      case "emit_protocol": {
        this.emitter?.emit({
          action: effect.action as any,
          status: "started",
          message: effect.message,
          detail: effect.detail,
        });
        break;
      }

      // ── Timers ────────────────────────────────────────────────
      case "schedule_timer": {
        const existing = this.timers.get(effect.timer);
        if (existing) {
          clearInterval(existing);
        }
        const timer = setInterval(() => {
          this.queue.enqueue({
            type: "timer_fired",
            timer: effect.timer as "housekeep" | "metacog" | "watchdog" | "snapshot",
            timestamp: Date.now(),
            seq: 0,
          });
        }, effect.delayMs);
        this.timers.set(effect.timer, timer);
        break;
      }

      case "cancel_timer": {
        const timer = this.timers.get(effect.timer);
        if (timer) {
          clearInterval(timer);
          this.timers.delete(effect.timer);
        }
        break;
      }

      // ── LLM worker execution ──────────────────────────────────
      // run_llm and submit_llm are the same: start an LLM thread for a worker process.
      case "run_llm":
      case "submit_llm": {
        const proc = state.processes.get(effect.pid);
        if (!proc) break;

        const thread = this.getOrCreateThread(effect.pid, proc.model ?? state.config.kernel.processModel);
        const prompt = WORKER_SYSTEM_PROMPT + "\n\n# Your Objective\n\n" + proc.objective;
        const processName = proc.name;
        const pid = effect.pid;

        // Wire LLM streaming → lens adapter → protocol emitter → lens bus (real-time terminal)
        const onStreamEvent = this.lensAdapter
          ? this.lensAdapter.createStreamCallback(pid, processName)
          : this.emitter
            ? (event: import("../types.js").StreamEvent) => {
                this.emitter!.emitStreamEvent(pid, processName, event);
              }
            : undefined;

        void thread
          .run(prompt, { onStreamEvent })
          .then((result) => {
            const parsed = parseWorkerCommands(result.finalResponse, processName);
            this.queue.enqueue({
              type: "llm_turn_completed",
              pid: effect.pid,
              success: true,
              response: result.finalResponse,
              tokensUsed: 0,
              commands: parsed,
              usage: result.usage as any,
              timestamp: Date.now(),
              seq: 0,
            });
          })
          .catch((err) => {
            this.queue.enqueue({
              type: "llm_turn_completed",
              pid: effect.pid,
              success: false,
              response: err instanceof Error ? err.message : String(err),
              tokensUsed: 0,
              commands: [],
              timestamp: Date.now(),
              seq: 0,
            });
          });
        break;
      }

      // ── Metacognitive evaluation ──────────────────────────────
      case "run_metacog": {
        const agent = this.getOrCreateMetacog(state);

        void (async () => {
          try {
            const response = await agent.evaluate(effect.context);
            this.queue.enqueue({
              type: "metacog_response_received",
              response,
              timestamp: Date.now(),
              seq: 0,
            });
          } catch (_err) {
            this.queue.enqueue({
              type: "metacog_response_received",
              response: JSON.stringify({ topology: null, memory: [], halt: null }),
              timestamp: Date.now(),
              seq: 0,
            });
          }
        })();
        break;
      }

      // ── Awareness daemon ──────────────────────────────────────
      case "run_awareness": {
        // TODO: Wire awareness daemon LLM call
        this.queue.enqueue({
          type: "awareness_response_received",
          adjustments: [],
          notes: [],
          flaggedHeuristics: [],
          timestamp: Date.now(),
          seq: 0,
        });
        break;
      }

      // ── Ephemeral (fire-and-forget scout) ─────────────────────
      case "run_ephemeral": {
        const model = effect.model ?? state.config.kernel.processModel;
        const thread = this.brain.startThread({ model });
        const startMs = Date.now();

        void thread
          .run(effect.objective)
          .then((result) => {
            this.queue.enqueue({
              type: "ephemeral_completed",
              id: effect.pid,
              name: `ephemeral-${effect.pid}`,
              tablePid: effect.pid,
              success: true,
              parentPid: effect.parentPid,
              response: result.finalResponse,
              durationMs: Date.now() - startMs,
              model,
              timestamp: Date.now(),
              seq: 0,
            });
          })
          .catch((err) => {
            this.queue.enqueue({
              type: "ephemeral_completed",
              id: effect.pid,
              name: `ephemeral-${effect.pid}`,
              tablePid: effect.pid,
              success: false,
              parentPid: effect.parentPid,
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - startMs,
              model,
              timestamp: Date.now(),
              seq: 0,
            });
          });
        break;
      }

      // ── Shell process ─────────────────────────────────────────
      case "run_shell": {
        // TODO: Wire shell process execution (spawn child_process)
        this.queue.enqueue({
          type: "shell_output_received",
          pid: effect.pid,
          output: "",
          exitCode: 0,
          timestamp: Date.now(),
          seq: 0,
        });
        break;
      }

      // ── Sub-kernel ────────────────────────────────────────────
      case "run_subkernel": {
        // TODO: Wire sub-kernel execution
        this.queue.enqueue({
          type: "subkernel_completed",
          pid: effect.pid,
          success: true,
          response: "",
          tokensUsed: 0,
          timestamp: Date.now(),
          seq: 0,
        });
        break;
      }

      // ── Persistence ───────────────────────────────────────────
      case "persist_snapshot": {
        const snapshot = this.buildSnapshotFromState(state);
        this.emitter?.saveSnapshot(snapshot);
        break;
      }

      case "persist_memory": {
        // TODO: Route to memoryStore based on operation kind
        break;
      }

      // ── Halt ──────────────────────────────────────────────────
      case "halt": {
        this.cleanup();
        break;
      }

      // ── State-only effects (no I/O needed) ─────────────────────
      // These effects represent state changes already applied by the transition function.
      // The interpreter has nothing to do — they exist only for effect logging/replay.
      default:
        break;
    }
  }

  /** Clear all timers and abort all threads. */
  cleanup(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();

    for (const thread of this.threads.values()) {
      thread.abort();
    }
    this.threads.clear();

    this.metacogAgent = null;
  }

  // ── Private helpers ─────────────────────────────────────────

  /** Get or create a BrainThread for a process with full tool access. */
  private getOrCreateThread(pid: string, model: string): BrainThread {
    let thread = this.threads.get(pid);
    if (!thread) {
      thread = this.brain.startThread({
        model,
        workingDirectory: this.workingDir,
        sandboxMode: "danger-full-access" as any,
        skipGitRepoCheck: true,
      });
      this.threads.set(pid, thread);
    }
    return thread;
  }

  /** Get or create the metacognitive agent. */
  private getOrCreateMetacog(state: KernelState): OsMetacognitiveAgent {
    if (!this.metacogAgent) {
      this.metacogAgent = new OsMetacognitiveAgent(
        state.config.kernel.metacogModel,
        state.goal,
        this.brain,
        this.workingDir,
      );
    }
    return this.metacogAgent;
  }

  /**
   * Build an OsSystemSnapshot from KernelState.
   * Minimal implementation — just enough for persist_snapshot to work.
   */
  private buildSnapshotFromState(state: KernelState): OsSystemSnapshot {
    const allProcesses = Array.from(state.processes.values());
    const totalTokensUsed = allProcesses.reduce((sum, p) => sum + p.tokensUsed, 0);
    const activeProcessCount = allProcesses.filter((p) => p.state === "running").length;
    const stalledProcessCount = allProcesses.filter(
      (p) => p.state === "sleeping" || p.state === "idle",
    ).length;

    const blackboard: Record<string, unknown> = {};
    for (const [key, entry] of state.blackboard) {
      if (!key.startsWith("_inbox:")) {
        blackboard[key] = entry.value;
      }
    }

    const deferrals = Array.from(state.deferrals?.values() ?? []).map(d => ({
      id: d.id,
      name: d.descriptor.name,
      condition: d.condition,
      waitedTicks: state.tickCount - d.registeredByTick,
      reason: d.reason,
    }));

    // Include metacog as a virtual kernel-level node in the DAG for rendering
    const dagTopology = { ...state.dagTopology, nodes: [...state.dagTopology.nodes], edges: [...state.dagTopology.edges] };
    const metacogPid = "__metacog__";
    dagTopology.nodes.push({
      pid: metacogPid,
      name: "metacog",
      type: "daemon" as any,
      state: state.metacogInflight ? "running" : "idle",
      priority: 100,
      parentPid: null,
    });
    // Connect metacog to all top-level worker processes (no parentPid)
    for (const node of state.dagTopology.nodes) {
      if (!node.parentPid && node.type !== "daemon") {
        dagTopology.edges.push({ from: metacogPid, to: node.pid, relation: "orchestrates" });
      }
    }

    return {
      runId: state.runId,
      tickCount: state.tickCount,
      goal: state.goal,
      processes: allProcesses,
      dagTopology,
      dagMetrics: { nodeCount: dagTopology.nodes.length, edgeCount: dagTopology.edges.length, maxDepth: 0, runningCount: activeProcessCount, stalledCount: stalledProcessCount, deadCount: 0 },
      ipcSummary: { signalCount: 0, blackboardKeyCount: state.blackboard.size },
      deferrals,
      progressMetrics: {
        activeProcessCount,
        stalledProcessCount,
        totalTokensUsed,
        tokenBudgetRemaining: state.config.kernel.tokenBudget - totalTokensUsed,
        wallTimeElapsedMs: Date.now() - state.startTime,
        tickCount: state.tickCount,
      },
      recentEvents: [],
      recentHeuristics: state.schedulerHeuristics.slice(0, 10),
      blackboard,
    };
  }
}

// ── Worker response parser ──────────────────────────────────────

/**
 * Parse worker LLM response for commands. Looks for a JSON block in ```json fences.
 * If no valid command block found, auto-generates bb_write + exit commands.
 */
function parseWorkerCommands(response: string, processName: string): any[] {
  // Try to extract JSON from ```json ... ``` fences
  const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]!);
      if (parsed && Array.isArray(parsed.commands) && parsed.commands.length > 0) {
        return parsed.commands;
      }
    } catch {
      // Fall through to auto-wrap
    }
  }

  // No valid command block — auto-wrap the response as a bb_write + exit
  // Truncate response for blackboard (keep first 4000 chars)
  const truncated = response.length > 4000 ? response.slice(0, 4000) + "..." : response;
  return [
    { kind: "bb_write", key: `result:${processName}`, value: truncated },
    { kind: "exit", reason: "completed", code: 0 },
  ];
}
