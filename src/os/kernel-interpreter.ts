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

import { spawn, type ChildProcess } from "node:child_process";
import type { Brain, BrainThread, BrainProvider } from "../types.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";
import type { ScopedMemoryStore } from "./scoped-memory-store.js";
import { EventQueue } from "./event-queue.js";
import { OsMetacognitiveAgent } from "./metacog-agent.js";
import { BrainLensAdapter } from "../lens/brain-lens-adapter.js";
import type { KernelState } from "./state-machine/state.js";
import type { KernelEffect } from "./state-machine/effects.js";
import type { OsSystemSnapshot, OsProcess } from "./types.js";
import { McpClient } from "./mcp-client.js";

/** Build a dynamic worker system prompt based on process capabilities. */
function buildWorkerPrompt(proc: OsProcess): string {
  const lines: string[] = [];

  lines.push("You are a worker process in a cognitive kernel — an autonomous intelligence system.");
  lines.push("Your job is to accomplish your objective and report results.");
  lines.push("");
  lines.push("IMPORTANT: End your response with a JSON command block wrapped in ```json fences:");
  lines.push("");
  lines.push("```json");
  lines.push("{");
  lines.push('  "commands": [');
  lines.push('    { "kind": "bb_write", "key": "result:your-name", "value": "your result here" },');
  lines.push('    { "kind": "exit", "reason": "completed" }');
  lines.push("  ]");
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push("## Available commands");
  lines.push("");
  lines.push("- **bb_write(key, value)**: Write a result to the shared blackboard. Use \"result:<your-process-name>\" as the key for final results.");
  lines.push("  You can also write intermediate progress: bb_write(\"progress:<your-process-name>\", \"short summary of what you've found/done so far\").");
  lines.push("  Other parallel workers will see your progress and can coordinate with you. Keep progress values concise (1-3 sentences).");
  lines.push("- **spawn_ephemeral(objective, name?)**: Spawn a lightweight scout for parallel sub-tasks.");
  lines.push("- **exit(reason?, code?)**: You're done. Use code=0 for success.");
  lines.push("- **idle(wakeOnSignals?)**: Pause and wait for new information.");
  lines.push("- **sleep(durationMs)**: Pause for a duration.");

  // Add sense-specific commands based on capabilities
  const tools = proc.capabilities?.observationTools ?? [];

  if (tools.includes("shell")) {
    lines.push("- **spawn_system(name, command, args?, env?)**: Spawn a managed shell process. Its stdout/stderr are captured to the blackboard passively. You'll be notified when it exits.");
  }

  if (tools.length > 0) {
    lines.push("- **mcp_call(tool, args)**: Call an MCP tool directly. The result is written to the blackboard at `mcp:<your-name>:<tool-name>`. You'll be woken when the result arrives.");
    lines.push("  IMPORTANT: Only emit ONE mcp_call per turn. After emitting it, your turn ends. You will be re-invoked with the result. Then emit the next mcp_call.");
    lines.push("");
    lines.push("## Available MCP tools (senses)");
    lines.push("");

    if (tools.includes("browser")) {
      lines.push("### Browser tools (via mcp_call)");
      lines.push("IMPORTANT: You must create a browser instance first, then pass its instanceId to all other calls.");
      lines.push("");
      lines.push("1. `browser_create_instance(options?)` — Create a browser instance. Returns { instanceId }. Call this FIRST.");
      lines.push("   options: { browser?: \"chromium\"|\"firefox\", headless?: boolean }");
      lines.push("2. `browser_navigate(instanceId, url)` — Navigate to a URL");
      lines.push("3. `browser_screenshot(instanceId)` — Take a screenshot");
      lines.push("4. `browser_click(instanceId, selector)` — Click an element");
      lines.push("5. `browser_fill(instanceId, selector, value)` — Fill a form field");
      lines.push("6. `browser_get_page_info(instanceId)` — Get page title and URL");
      lines.push("7. `browser_get_markdown(instanceId)` — Get page content as markdown");
      lines.push("8. `browser_evaluate(instanceId, expression)` — Execute JavaScript in the page");
      lines.push("9. `browser_wait_for_element(instanceId, selector)` — Wait for element to appear");
      lines.push("10. `browser_close_instance(instanceId)` — Close the browser instance when done");
      lines.push("");
      lines.push("Workflow (one mcp_call per turn, wait for result before next call):");
      lines.push("");
      lines.push("Turn 1 - create browser:");
      lines.push("```json");
      lines.push("{ \"commands\": [{ \"kind\": \"mcp_call\", \"tool\": \"browser_create_instance\", \"args\": {} }] }");
      lines.push("```");
      lines.push("(Your turn ends. You will be re-invoked with the result containing the instanceId.)");
      lines.push("");
      lines.push("Turn 2 - navigate (using instanceId from previous result):");
      lines.push("```json");
      lines.push("{ \"commands\": [{ \"kind\": \"mcp_call\", \"tool\": \"browser_navigate\", \"args\": { \"instanceId\": \"<from-result>\", \"url\": \"https://example.com\" } }] }");
      lines.push("```");
      lines.push("(Your turn ends. You will be re-invoked with the navigation result.)");
      lines.push("");
      lines.push("Turn 3 - get info, write result, exit:");
      lines.push("```json");
      lines.push("{ \"commands\": [{ \"kind\": \"mcp_call\", \"tool\": \"browser_get_page_info\", \"args\": { \"instanceId\": \"<same-id>\" } }] }");
      lines.push("```");
      lines.push("(Your turn ends. You will be re-invoked with the page info. Then bb_write and exit.)");
    }

    if (tools.includes("shell")) {
      lines.push("");
      lines.push("### Shell (via spawn_system)");
      lines.push("Shell processes run as managed subprocesses. Their output flows to the blackboard.");
      lines.push("Use spawn_system for long-running processes (servers, watchers).");
      lines.push("For quick commands, you can use your built-in Bash tool directly.");
    }
  }

  lines.push("");
  lines.push("## Ephemerals");
  lines.push("");
  lines.push("If your objective involves multiple independent sub-tasks, spawn ephemerals to do them in parallel.");
  lines.push("Each ephemeral is a fast, focused scout. Spawn them, then idle to wait for results.");
  lines.push("");
  lines.push("If you don't include a command block, the kernel will auto-write your full response to the blackboard and exit you.");

  return lines.join("\n");
}

/**
 * Collect the set of process names that are upstream ancestors of `proc`
 * by walking dependency edges backwards through the DAG topology.
 * Returns an empty set if no DAG exists (falls back to global injection).
 */
export function getUpstreamAncestorNames(state: KernelState, proc: OsProcess): Set<string> | null {
  const dag = state.dagTopology;
  if (!dag || dag.edges.length === 0) return null; // no DAG — fall back to global

  // Build pid→name lookup and reverse adjacency (to → from[]) for dependency edges only
  const pidToName = new Map<string, string>();
  for (const node of dag.nodes) {
    pidToName.set(node.pid, node.name);
  }
  const reverseAdj = new Map<string, string[]>(); // pid → upstream pids
  for (const edge of dag.edges) {
    if (edge.relation !== "dependency") continue;
    const existing = reverseAdj.get(edge.to) ?? [];
    existing.push(edge.from);
    reverseAdj.set(edge.to, existing);
  }

  // If no dependency edges exist at all, fall back to global
  if (reverseAdj.size === 0) return null;

  // BFS backwards from proc.pid to collect all ancestors
  const ancestors = new Set<string>();
  const queue = [proc.pid];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const upstreams = reverseAdj.get(current) ?? [];
    for (const upPid of upstreams) {
      const name = pidToName.get(upPid);
      if (name) ancestors.add(name);
      queue.push(upPid);
    }
  }
  return ancestors;
}

/** Build upstream context from blackboard results produced by other workers. */
export function buildUpstreamContext(state: KernelState, proc: OsProcess): string {
  const entries: string[] = [];

  // Scope to DAG ancestors when dependency edges exist, otherwise global
  const ancestorNames = getUpstreamAncestorNames(state, proc);

  for (const [key, entry] of state.blackboard) {
    // Include result:*, progress:*, shell:*, mcp:* keys from other processes
    if (!key.startsWith("result:") && !key.startsWith("progress:") && !key.startsWith("shell:") && !key.startsWith("mcp:")) continue;
    // Skip internal/system keys
    if (key.startsWith("shell:exit:")) continue;
    // Skip own keys
    if (key === `result:${proc.name}` || key === `progress:${proc.name}`) continue;

    // If DAG-scoped, only include keys written by upstream ancestors
    if (ancestorNames !== null) {
      // Extract worker name from key prefix (result:foo, shell:foo:stdout, mcp:foo:tool)
      const parts = key.split(":");
      const workerName = parts[1];
      if (!ancestorNames.has(workerName)) continue;
    }

    const value = typeof entry.value === "string"
      ? entry.value
      : JSON.stringify(entry.value);
    // Cap each entry to keep prompt bounded
    const capped = value.length > 1000 ? value.slice(0, 1000) + "..." : value;
    entries.push(`**${key}**: ${capped}`);
  }

  if (entries.length === 0) return "";

  return "\n\n## Upstream Results (from other workers)\n\n" +
    "These are results already produced by other workers in this run. " +
    "You MUST follow any schemas, contracts, or specifications defined here — " +
    "they are binding agreements between workers, not suggestions. " +
    "Use exact field names, types, and structures as specified.\n\n" +
    entries.join("\n\n");
}

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

  /** Active shell subprocesses (keyed by pid). */
  private readonly shellProcesses = new Map<string, ChildProcess>();

  /** MCP client for tool calls (created lazily from config). */
  private mcpClient: McpClient | null = null;
  private readonly mcpConfig: { command: string; args?: string[]; env?: Record<string, string> } | null;

  constructor(
    brain: Brain,
    emitter: OsProtocolEmitter | null,
    queue: EventQueue,
    memoryStore: ScopedMemoryStore | null,
    workingDir: string,
    provider?: BrainProvider,
    mcpConfig?: { command: string; args?: string[]; env?: Record<string, string> } | null,
  ) {
    this.brain = brain;
    this.emitter = emitter;
    this.queue = queue;
    this.memoryStore = memoryStore;
    this.workingDir = workingDir;
    this.lensAdapter = emitter && provider
      ? new BrainLensAdapter({ emitter, provider })
      : null;
    this.mcpConfig = mcpConfig ?? null;
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

        // If the effect has context (e.g. MCP result), use it directly as the follow-up prompt.
        // Otherwise, build the full system prompt + objective (first turn).
        let prompt: string;
        if (effect.type === "submit_llm" && effect.context) {
          prompt = effect.context;
        } else {
          const systemPrompt = buildWorkerPrompt(proc);
          const upstream = buildUpstreamContext(state, proc);
          prompt = systemPrompt + upstream + "\n\n# Your Objective\n\n" + proc.objective;
        }

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

        // Wire metacog LLM streaming → lens (so terminal shows metacog's thinking)
        const metacogPid = "__metacog__";
        const metacogName = "metacog";
        const onStreamEvent = this.lensAdapter
          ? this.lensAdapter.createStreamCallback(metacogPid, metacogName)
          : this.emitter
            ? (event: import("../types.js").StreamEvent) => {
                this.emitter!.emitStreamEvent(metacogPid, metacogName, event);
              }
            : undefined;

        void (async () => {
          try {
            const response = await agent.evaluate(effect.context, { onStreamEvent });
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

      // ── Shell process (real child_process spawn) ────────────────
      case "run_shell": {
        const child = spawn(effect.command, effect.args, {
          cwd: effect.workingDir ?? this.workingDir,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        this.shellProcesses.set(effect.pid, child);

        let stdoutBuf = "";
        let stderrBuf = "";
        let flushTimer: NodeJS.Timeout | null = null;

        const debouncedFlush = () => {
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = setTimeout(() => {
            if (stdoutBuf || stderrBuf) {
              this.queue.enqueue({
                type: "shell_output",
                pid: effect.pid,
                hasStdout: stdoutBuf.length > 0,
                hasStderr: stderrBuf.length > 0,
                stdout: stdoutBuf || undefined,
                stderr: stderrBuf || undefined,
                timestamp: Date.now(),
                seq: 0,
              });
              // Reset buffers after flush
              stdoutBuf = "";
              stderrBuf = "";
            }
          }, 2000);
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuf += chunk.toString();
          // Cap buffer at 8KB
          if (stdoutBuf.length > 8192) {
            stdoutBuf = stdoutBuf.slice(-8192);
          }
          debouncedFlush();
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          if (stderrBuf.length > 8192) {
            stderrBuf = stderrBuf.slice(-8192);
          }
          debouncedFlush();
        });

        child.on("exit", (code) => {
          if (flushTimer) clearTimeout(flushTimer);
          this.shellProcesses.delete(effect.pid);

          this.queue.enqueue({
            type: "shell_output",
            pid: effect.pid,
            hasStdout: stdoutBuf.length > 0,
            hasStderr: stderrBuf.length > 0,
            stdout: stdoutBuf || undefined,
            stderr: stderrBuf || undefined,
            exitCode: code ?? 1,
            timestamp: Date.now(),
            seq: 0,
          });
        });

        child.on("error", (err) => {
          if (flushTimer) clearTimeout(flushTimer);
          this.shellProcesses.delete(effect.pid);

          this.queue.enqueue({
            type: "shell_output",
            pid: effect.pid,
            hasStdout: false,
            hasStderr: true,
            stderr: err instanceof Error ? err.message : String(err),
            exitCode: 1,
            timestamp: Date.now(),
            seq: 0,
          });
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

      // ── MCP tool call ──────────────────────────────────────────
      case "execute_mcp_call": {
        void (async () => {
          try {
            const client = await this.getOrCreateMcpClient();
            if (!client) {
              this.queue.enqueue({
                type: "mcp_call_completed",
                pid: effect.pid,
                tool: effect.tool,
                success: false,
                error: "No MCP server configured",
                timestamp: Date.now(),
                seq: 0,
              });
              return;
            }

            // Force headless: false on browser_create_instance so the browser is visible
            const args = effect.tool === "browser_create_instance"
              ? { ...effect.args, headless: false }
              : effect.args;

            const result = await client.callTool(effect.tool, args);
            const textContent = result.content
              ?.filter((c) => c.type === "text" && c.text)
              .map((c) => c.text)
              .join("\n") ?? "";

            this.queue.enqueue({
              type: "mcp_call_completed",
              pid: effect.pid,
              tool: effect.tool,
              success: !result.isError,
              result: textContent || JSON.stringify(result.content),
              error: result.isError ? textContent : undefined,
              timestamp: Date.now(),
              seq: 0,
            });
          } catch (err) {
            this.queue.enqueue({
              type: "mcp_call_completed",
              pid: effect.pid,
              tool: effect.tool,
              success: false,
              error: err instanceof Error ? err.message : String(err),
              timestamp: Date.now(),
              seq: 0,
            });
          }
        })();
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

  /** Clear all timers, abort all threads, kill shell processes, close MCP client. */
  cleanup(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();

    for (const thread of this.threads.values()) {
      thread.abort();
    }
    this.threads.clear();

    for (const child of this.shellProcesses.values()) {
      child.kill();
    }
    this.shellProcesses.clear();

    if (this.mcpClient) {
      this.mcpClient.close();
      this.mcpClient = null;
    }

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

  /** Get or create the MCP client, connecting lazily. */
  private async getOrCreateMcpClient(): Promise<McpClient | null> {
    if (this.mcpClient?.isConnected) return this.mcpClient;
    if (!this.mcpConfig) return null;

    this.mcpClient = new McpClient(this.mcpConfig);
    await this.mcpClient.connect();
    return this.mcpClient;
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
