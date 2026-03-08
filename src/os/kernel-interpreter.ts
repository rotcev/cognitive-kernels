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

import type { Brain, BrainThread } from "../types.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";
import type { ScopedMemoryStore } from "./scoped-memory-store.js";
import { EventQueue } from "./event-queue.js";
import { OsMetacognitiveAgent } from "./metacog-agent.js";
import type { KernelState } from "./state-machine/state.js";
import type { KernelEffect } from "./state-machine/effects.js";
import type { OsSystemSnapshot, OsProcess } from "./types.js";

export class KernelInterpreter {
  private readonly brain: Brain;
  private readonly emitter: OsProtocolEmitter | null;
  private readonly queue: EventQueue;
  private readonly memoryStore: ScopedMemoryStore | null;
  private readonly workingDir: string;

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
  ) {
    this.brain = brain;
    this.emitter = emitter;
    this.queue = queue;
    this.memoryStore = memoryStore;
    this.workingDir = workingDir;
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
        });
        break;
      }

      // ── Timers ────────────────────────────────────────────────
      case "schedule_timer": {
        // Clear existing timer with same name (replace semantics)
        const existing = this.timers.get(effect.timer);
        if (existing) {
          clearTimeout(existing);
        }

        const timer = setTimeout(() => {
          this.timers.delete(effect.timer);
          this.queue.enqueue({
            type: "timer_fired",
            timer: effect.timer as "housekeep" | "metacog" | "watchdog" | "snapshot",
            timestamp: Date.now(),
            seq: 0, // The event loop will re-sequence
          });
        }, effect.delayMs);

        // Don't prevent Node from exiting
        if (typeof timer.unref === "function") {
          timer.unref();
        }

        this.timers.set(effect.timer, timer);
        break;
      }

      case "cancel_timer": {
        const timer = this.timers.get(effect.timer);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(effect.timer);
        }
        break;
      }

      // ── LLM process execution ────────────────────────────────
      case "run_llm": {
        const proc = state.processes.get(effect.pid);
        if (!proc) break;

        const thread = this.getOrCreateThread(effect.pid, proc.model ?? state.config.kernel.processModel);

        // Fire-and-forget: enqueue completion event when done
        void thread
          .run(proc.objective)
          .then((result) => {
            this.queue.enqueue({
              type: "llm_turn_completed",
              pid: effect.pid,
              success: true,
              response: result.finalResponse,
              tokensUsed: 0,
              commands: [],
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
            // On error, enqueue a no-op response so the kernel doesn't stall
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
        // For now: enqueue empty response so the kernel loop continues
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
        // For now: enqueue placeholder response
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
        // For now: enqueue placeholder response
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
        // For now this is a no-op until we wire memory operations
        break;
      }

      // ── Halt ──────────────────────────────────────────────────
      case "halt": {
        this.cleanup();
        break;
      }

      // ── Legacy effects ────────────────────────────────────────
      // These are state changes now handled inside the transition function,
      // or legacy effects from the old kernel. The new interpreter doesn't
      // need to execute them — transition modifies state directly.
      case "submit_llm":
      case "submit_ephemeral":
      case "submit_metacog":
      case "submit_awareness":
      case "activate_process":
      case "idle_process":
      case "signal_emit":
      case "child_done_signal":
      case "flush_ipc":
      case "rebuild_dag":
      case "schedule_pass":
      case "apply_strategies":
      case "spawn_topology_process":
      case "kill_process":
      case "drain_process":
      case "start_shell":
      case "start_subkernel":
        // No-op — handled by transition or superseded by run_* effects
        break;
    }
  }

  /** Clear all timers and abort all threads. */
  cleanup(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const thread of this.threads.values()) {
      thread.abort();
    }
    this.threads.clear();

    this.metacogAgent = null;
  }

  // ── Private helpers ─────────────────────────────────────────

  /** Get or create a BrainThread for a process. */
  private getOrCreateThread(pid: string, model: string): BrainThread {
    let thread = this.threads.get(pid);
    if (!thread) {
      thread = this.brain.startThread({ model });
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

    return {
      runId: state.runId,
      tickCount: state.tickCount,
      goal: state.goal,
      processes: allProcesses,
      dagTopology: state.dagTopology,
      dagMetrics: { nodeCount: state.dagTopology.nodes.length, edgeCount: state.dagTopology.edges.length, maxDepth: 0, runningCount: activeProcessCount, stalledCount: stalledProcessCount, deadCount: 0 },
      ipcSummary: { signalCount: 0, blackboardKeyCount: state.blackboard.size },
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
