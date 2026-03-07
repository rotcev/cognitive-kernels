/**
 * cognitive-lens client — framework-agnostic TypeScript client for Lens WebSocket.
 *
 * Designed for white-label embedding. Zero framework dependencies.
 * Works in browsers and Node.js (with `ws` polyfill).
 *
 * Usage:
 *   const lens = new LensClient("ws://localhost:3200");
 *   lens.on("snapshot", (snap) => renderDashboard(snap));
 *   lens.on("narrative", (text) => showStatus(text));
 *   await lens.connect();
 *   lens.subscribe("run-abc123");
 */

import type {
  LensSnapshot,
  LensSnapshotDelta,
  LensTerminalLine,
  LensTerminalFilter,
  LensProcess,
  LensDagNode,
  LensEdge,
  LensBBEntry,
  LensMetrics,
  LensHeuristic,
  LensDeferral,
  LensProcessDelta,
  LensServerMessage,
  LensClientMessage,
} from "./types.js";
import type { LensCognitiveEvent } from "./cognitive-events.js";

// ── Event types the client emits ─────────────────────────────────

export type LensClientEventMap = {
  /** Full snapshot received (first snapshot or reconnect). */
  snapshot: { runId: string; snapshot: LensSnapshot };
  /** Incremental delta received. */
  delta: { runId: string; delta: LensSnapshotDelta };
  /** Protocol event from the kernel. */
  event: { runId: string; event: Record<string, unknown> };
  /** High-level cognitive event (decision, observation, intervention, learning). */
  cognitive_event: { runId: string; cognitiveEvent: LensCognitiveEvent };
  /** Terminal line for a subscribed process. */
  terminal_line: { runId: string; pid: string; line: LensTerminalLine };
  /** Run completed. */
  run_end: { runId: string; reason: string };
  /** Narrative status update (human-readable). */
  narrative: { runId: string; text: string };
  /** Command response (from NL query). */
  command_response: { runId: string; text: string; done: boolean };
  /** Message delivery acknowledgement. */
  message_ack: { runId: string; pid: string; text: string; deliveredAt: string | null };
  /** Server error. */
  error: { message: string };
  /** Connection state changed. */
  connection: { state: "connecting" | "connected" | "disconnected" };
  /** Merged state updated (after applying snapshot or delta). */
  state: { runId: string; snapshot: LensSnapshot };
};

type EventHandler<K extends keyof LensClientEventMap> = (data: LensClientEventMap[K]) => void;

// ── Options ──────────────────────────────────────────────────────

export interface LensClientOptions {
  /** WebSocket URL, e.g. "ws://localhost:3200". */
  url: string;
  /** Auto-reconnect on disconnect. Default: true. */
  reconnect?: boolean;
  /** Reconnect delay in ms. Default: 2000. */
  reconnectDelayMs?: number;
  /** Max reconnect attempts. Default: Infinity. */
  maxReconnectAttempts?: number;
  /** Custom WebSocket constructor (for Node.js). If omitted, uses globalThis.WebSocket. */
  WebSocket?: new (url: string) => WebSocket;
}

// ── Client ───────────────────────────────────────────────────────

export class LensClient {
  private readonly url: string;
  private readonly shouldReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly WS: new (url: string) => WebSocket;

  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Function>>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribedRuns = new Set<string>();
  private subscribedProcesses = new Map<string, Set<string>>(); // runId → pids
  private destroyed = false;

  /** Merged snapshot state per run (snapshot + applied deltas). */
  readonly state = new Map<string, LensSnapshot>();

  constructor(options: LensClientOptions | string) {
    const opts = typeof options === "string" ? { url: options } : options;
    this.url = opts.url;
    this.shouldReconnect = opts.reconnect ?? true;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 2000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? Infinity;
    this.WS = opts.WebSocket ?? globalThis.WebSocket;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error("Client has been destroyed"));
        return;
      }

      this.emit("connection", { state: "connecting" });
      const ws = new this.WS(this.url);

      ws.onopen = () => {
        this.ws = ws;
        this.reconnectAttempts = 0;
        this.emit("connection", { state: "connected" });
        // Re-subscribe after reconnect
        this.resubscribe();
        resolve();
      };

      ws.onclose = () => {
        this.ws = null;
        this.emit("connection", { state: "disconnected" });
        if (this.shouldReconnect && !this.destroyed) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = (err) => {
        if (!this.ws) {
          // Connection never opened
          reject(err);
        }
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };
    });
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "client disconnect");
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === 1; // WebSocket.OPEN
  }

  // ── Subscriptions ──────────────────────────────────────────────

  subscribe(runId: string): void {
    this.subscribedRuns.add(runId);
    this.send({ type: "subscribe", runId });
  }

  unsubscribe(runId: string): void {
    this.subscribedRuns.delete(runId);
    this.subscribedProcesses.delete(runId);
    this.state.delete(runId);
    this.send({ type: "unsubscribe", runId });
  }

  subscribeProcess(runId: string, pid: string): void {
    if (!this.subscribedProcesses.has(runId)) {
      this.subscribedProcesses.set(runId, new Set());
    }
    this.subscribedProcesses.get(runId)!.add(pid);
    this.send({ type: "subscribe_process", runId, pid });
  }

  unsubscribeProcess(runId: string, pid: string): void {
    this.subscribedProcesses.get(runId)?.delete(pid);
    this.send({ type: "unsubscribe_process", runId, pid });
  }

  /**
   * Subscribe to the global terminal for a run (all processes).
   * Optional filter to scope by PIDs and/or log levels.
   *
   * Examples:
   *   subscribeTerminal("run-1")                              // everything
   *   subscribeTerminal("run-1", { levels: ["error"] })       // errors only
   *   subscribeTerminal("run-1", { pids: ["shell-1"] })       // one shell
   *   subscribeTerminal("run-1", { levels: ["output","error"], pids: ["sh-1","sh-2"] })
   */
  subscribeTerminal(runId: string, filter?: LensTerminalFilter): void {
    this.send({ type: "subscribe_terminal", runId, filter });
  }

  unsubscribeTerminal(runId: string): void {
    this.send({ type: "unsubscribe_terminal", runId });
  }

  /** Send a natural-language query about the run. Response arrives via "command_response" events. */
  query(runId: string, question: string): void {
    this.send({ type: "command_query", runId, question });
  }

  /** Send a message to a specific process. Ack arrives via "message_ack" event. */
  sendMessage(runId: string, pid: string, text: string): void {
    this.send({ type: "send_message", runId, pid, text });
  }

  // ── Event emitter ──────────────────────────────────────────────

  on<K extends keyof LensClientEventMap>(event: K, handler: EventHandler<K>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off<K extends keyof LensClientEventMap>(event: K, handler: EventHandler<K>): void {
    this.listeners.get(event)?.delete(handler);
  }

  once<K extends keyof LensClientEventMap>(event: K, handler: EventHandler<K>): () => void {
    const wrapper = ((data: LensClientEventMap[K]) => {
      this.off(event, wrapper as EventHandler<K>);
      handler(data);
    }) as EventHandler<K>;
    return this.on(event, wrapper);
  }

  /** Wait for the next event of a given type. */
  waitFor<K extends keyof LensClientEventMap>(
    event: K,
    filter?: (data: LensClientEventMap[K]) => boolean,
    timeoutMs = 30000,
  ): Promise<LensClientEventMap[K]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for ${event}`));
      }, timeoutMs);

      const cleanup = this.on(event, (data) => {
        if (!filter || filter(data)) {
          clearTimeout(timer);
          cleanup();
          resolve(data);
        }
      });
    });
  }

  private emit<K extends keyof LensClientEventMap>(event: K, data: LensClientEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          (handler as EventHandler<K>)(data);
        } catch {
          // Don't let handler errors break the client
        }
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: LensServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "snapshot":
        this.state.set(msg.runId, msg.snapshot);
        this.emit("snapshot", { runId: msg.runId, snapshot: msg.snapshot });
        this.emit("state", { runId: msg.runId, snapshot: msg.snapshot });
        break;

      case "delta":
        this.applyDelta(msg.runId, msg.delta);
        this.emit("delta", { runId: msg.runId, delta: msg.delta });
        break;

      case "event":
        this.emit("event", { runId: msg.runId, event: msg.event as unknown as Record<string, unknown> });
        break;

      case "cognitive_event":
        this.emit("cognitive_event", { runId: msg.runId, cognitiveEvent: msg.cognitiveEvent });
        break;

      case "terminal_line":
        this.emit("terminal_line", { runId: msg.runId, pid: msg.pid, line: msg.line });
        break;

      case "run_end":
        this.emit("run_end", { runId: msg.runId, reason: msg.reason });
        break;

      case "narrative":
        this.emit("narrative", { runId: msg.runId, text: msg.text });
        break;

      case "command_response":
        this.emit("command_response", { runId: msg.runId, text: msg.text, done: msg.done });
        break;

      case "message_ack":
        this.emit("message_ack", { runId: msg.runId, pid: msg.pid, text: msg.text, deliveredAt: msg.deliveredAt });
        break;

      case "error":
        this.emit("error", { message: msg.message });
        break;
    }
  }

  /**
   * Apply a delta to the cached snapshot, producing an updated merged state.
   * This is what makes the client reactive — consumers always get a full snapshot.
   */
  private applyDelta(runId: string, delta: LensSnapshotDelta): void {
    const current = this.state.get(runId);
    if (!current) return;

    const updated = { ...current, tick: delta.tick };

    // Processes
    if (delta.processes) {
      let procs = [...current.processes];

      // Remove
      if (delta.processes.removed.length > 0) {
        const removedSet = new Set(delta.processes.removed);
        procs = procs.filter(p => !removedSet.has(p.pid));
      }

      // Add
      procs.push(...delta.processes.added);

      // Update changed
      for (const ch of delta.processes.changed) {
        const idx = procs.findIndex(p => p.pid === ch.pid);
        if (idx >= 0) {
          procs[idx] = { ...procs[idx], ...ch.changed };
        }
      }

      updated.processes = procs;
    }

    // DAG
    if (delta.dag) {
      const nodes = [...current.dag.nodes];
      const edges = [...current.dag.edges];

      if (delta.dag.removedNodes.length > 0) {
        const removedSet = new Set(delta.dag.removedNodes);
        updated.dag = {
          nodes: nodes.filter(n => !removedSet.has(n.pid)),
          edges,
        };
      }

      if (delta.dag.addedNodes.length > 0) {
        updated.dag = {
          nodes: [...(updated.dag?.nodes ?? nodes), ...delta.dag.addedNodes],
          edges: updated.dag?.edges ?? edges,
        };
      }

      if (delta.dag.removedEdges.length > 0) {
        const toRemove = new Set(delta.dag.removedEdges.map(e => `${e.from}->${e.to}`));
        updated.dag = {
          nodes: updated.dag?.nodes ?? nodes,
          edges: (updated.dag?.edges ?? edges).filter(e => !toRemove.has(`${e.from}->${e.to}`)),
        };
      }

      if (delta.dag.addedEdges.length > 0) {
        updated.dag = {
          nodes: updated.dag?.nodes ?? nodes,
          edges: [...(updated.dag?.edges ?? edges), ...delta.dag.addedEdges],
        };
      }
    }

    // Blackboard
    if (delta.blackboard) {
      const bb = { ...current.blackboard };
      for (const entry of delta.blackboard.updated) {
        bb[entry.key] = entry;
      }
      for (const key of delta.blackboard.removed) {
        delete bb[key];
      }
      updated.blackboard = bb;
    }

    // Metrics
    if (delta.metrics) {
      updated.metrics = { ...current.metrics, ...delta.metrics };
    }

    this.state.set(runId, updated);
    this.emit("state", { runId, snapshot: updated });
  }

  private send(msg: LensClientMessage): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private resubscribe(): void {
    for (const runId of this.subscribedRuns) {
      this.send({ type: "subscribe", runId });
    }
    for (const [runId, pids] of this.subscribedProcesses) {
      for (const pid of pids) {
        this.send({ type: "subscribe_process", runId, pid });
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1),
      30000,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        // Will trigger onclose → scheduleReconnect again
      });
    }, delay);
  }
}

// Re-export types that consumers need
export type {
  LensSnapshot,
  LensSnapshotDelta,
  LensTerminalLine,
  LensTerminalFilter,
  LensProcess,
  LensDagNode,
  LensEdge,
  LensBBEntry,
  LensMetrics,
  LensHeuristic,
  LensDeferral,
  LensProcessDelta,
  LensServerMessage,
  LensClientMessage,
};
export type { LensCognitiveEvent } from "./cognitive-events.js";
