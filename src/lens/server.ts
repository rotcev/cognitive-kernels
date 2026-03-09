/**
 * Lens WebSocket server.
 *
 * Accepts client connections, manages run subscriptions, and pushes
 * Lens-transformed data (snapshots, deltas, terminal lines) to clients.
 *
 * Protocol (client → server):
 *   { type: "subscribe", runId: string }
 *   { type: "unsubscribe", runId: string }
 *   { type: "subscribe_process", runId: string, pid: string }
 *   { type: "unsubscribe_process", runId: string, pid: string }
 *
 * Protocol (server → client):
 *   { type: "snapshot", runId: string, snapshot: LensSnapshot }
 *   { type: "delta", runId: string, delta: LensSnapshotDelta }
 *   { type: "event", runId: string, event: RuntimeProtocolEvent }
 *   { type: "terminal_line", runId: string, pid: string, line: LensTerminalLine }
 *   { type: "run_end", runId: string, reason: string }
 *   { type: "error", message: string }
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { LensEventBus, LensBusEvent } from "./event-bus.js";
import type { LensSnapshot, LensSnapshotDelta, LensTerminalLine, LensTerminalLevel, LensTerminalFilter, LensServerMessage, LensClientMessage, LensProcess, LensDagNode, LensEdge } from "./types.js";
import { buildLensSnapshot } from "./view-models.js";
import { diffSnapshots } from "./snapshot-differ.js";
import { StreamSegmenter } from "./stream-segmenter.js";
import { extractCognitiveEvent } from "./cognitive-events.js";
import type { NarrativeGenerator } from "./narrative.js";
import type { OsSystemSnapshot } from "../os/types.js";
import type { OsProcessType } from "../os/types.js";

interface TerminalSubscription {
  filter?: LensTerminalFilter;
  /** Precomputed sets for fast matching. */
  pidSet?: Set<string>;
  levelSet?: Set<LensTerminalLevel>;
}

interface ClientState {
  ws: WebSocket;
  subscribedRuns: Set<string>;
  subscribedProcesses: Map<string, Set<string>>; // runId → Set<pid>
  /** Global terminal subscription per run (all processes, with optional filter). */
  terminalSubs: Map<string, TerminalSubscription>; // runId → filter
}

interface RunState {
  lastSnapshot: LensSnapshot | null;
  prevTokens: { total: number; timestamp: number } | undefined;
  segmenter: StreamSegmenter;
}

export interface LensServerOptions {
  bus: LensEventBus;
  port?: number;
  server?: HttpServer; // attach to existing HTTP server
  heartbeatIntervalMs?: number;
  narrator?: NarrativeGenerator;
  storage?: import("../db/storage-backend.js").StorageBackend;
}

export class LensServer {
  private wss: WebSocketServer | null = null;
  private readonly bus: LensEventBus;
  private readonly port: number;
  private readonly externalServer?: HttpServer;
  private readonly heartbeatIntervalMs: number;
  private readonly narrator?: NarrativeGenerator;
  private readonly storage?: import("../db/storage-backend.js").StorageBackend;

  private clients = new Set<ClientState>();
  private runs = new Map<string, RunState>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private busListener: ((event: LensBusEvent) => void) | null = null;

  constructor(options: LensServerOptions) {
    this.bus = options.bus;
    this.port = options.port ?? 3200;
    this.externalServer = options.server;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30000;
    this.narrator = options.narrator;
    this.storage = options.storage;
  }

  async start(): Promise<void> {
    if (this.externalServer) {
      this.wss = new WebSocketServer({ server: this.externalServer });
    } else {
      this.wss = new WebSocketServer({ port: this.port });
      await new Promise<void>((resolve) => {
        this.wss!.once("listening", resolve);
      });
    }

    this.wss.on("connection", (ws) => this.handleConnection(ws));

    // Heartbeat
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, this.heartbeatIntervalMs);

    // Subscribe to bus
    this.busListener = (event) => this.handleBusEvent(event);
    this.bus.on("*", this.busListener);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.busListener) {
      this.bus.off("*", this.busListener);
      this.busListener = null;
    }

    if (this.wss) {
      for (const client of this.clients) {
        client.ws.close(1000, "server shutting down");
      }
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    this.clients.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get address(): { port: number } | null {
    const addr = this.wss?.address();
    if (!addr || typeof addr === "string") return null;
    return { port: addr.port };
  }

  // ── Connection handling ───────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    const client: ClientState = {
      ws,
      subscribedRuns: new Set(),
      subscribedProcesses: new Map(),
      terminalSubs: new Map(),
    };

    this.clients.add(client);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as LensClientMessage;
        this.handleClientMessage(client, msg);
      } catch {
        this.send(client, { type: "error", message: "Invalid JSON" });
      }
    });

    ws.on("close", () => {
      this.clients.delete(client);
    });

    ws.on("error", () => {
      this.clients.delete(client);
    });
  }

  private handleClientMessage(client: ClientState, msg: LensClientMessage): void {
    switch (msg.type) {
      case "subscribe": {
        client.subscribedRuns.add(msg.runId);
        // Send current snapshot if we have one, otherwise try storage
        const run = this.getOrCreateRunState(msg.runId);
        if (run.lastSnapshot) {
          this.send(client, { type: "snapshot", runId: msg.runId, snapshot: run.lastSnapshot });
        } else if (this.storage?.isConnected()) {
          void this.loadSnapshotFromStorage(client, msg.runId, run);
        }
        break;
      }
      case "unsubscribe":
        client.subscribedRuns.delete(msg.runId);
        client.subscribedProcesses.delete(msg.runId);
        break;
      case "subscribe_process": {
        if (!client.subscribedProcesses.has(msg.runId)) {
          client.subscribedProcesses.set(msg.runId, new Set());
        }
        client.subscribedProcesses.get(msg.runId)!.add(msg.pid);
        // Send existing terminal lines for this process
        const runState = this.runs.get(msg.runId);
        if (runState) {
          const lines = runState.segmenter.getLines(msg.pid);
          for (const line of lines) {
            this.send(client, { type: "terminal_line", runId: msg.runId, pid: msg.pid, line });
          }
        }
        break;
      }
      case "unsubscribe_process": {
        const pids = client.subscribedProcesses.get(msg.runId);
        if (pids) pids.delete(msg.pid);
        break;
      }
      case "subscribe_terminal": {
        const sub: TerminalSubscription = {};
        if (msg.filter?.pids?.length) sub.pidSet = new Set(msg.filter.pids);
        if (msg.filter?.levels?.length) sub.levelSet = new Set(msg.filter.levels);
        sub.filter = msg.filter;
        client.terminalSubs.set(msg.runId, sub);
        // Send existing lines that match the filter
        const termRun = this.runs.get(msg.runId);
        if (termRun) {
          let lines: import("./types.js").LensTerminalLine[];
          if (sub.pidSet) {
            lines = termRun.segmenter.filterByPids([...sub.pidSet]);
          } else {
            lines = termRun.segmenter.getAllLines();
          }
          if (sub.levelSet) {
            lines = lines.filter(l => sub.levelSet!.has(l.level));
          }
          for (const line of lines) {
            this.send(client, { type: "terminal_line", runId: msg.runId, pid: line.pid, line });
          }
        }
        break;
      }
      case "unsubscribe_terminal":
        client.terminalSubs.delete(msg.runId);
        break;
      default:
        this.send(client, { type: "error", message: `Unknown message type: ${(msg as { type: string }).type}` });
    }
  }

  // ── Storage fetch for completed/historical runs ──────────────

  private async loadSnapshotFromStorage(client: ClientState, runId: string, run: RunState): Promise<void> {
    try {
      // Fetch snapshot and events in parallel
      const [snapshotResult, eventsResult] = await Promise.all([
        this.storage!.fetchLatestSnapshot(runId),
        this.storage!.fetchEventsSince(runId, 0),
      ]);

      if (snapshotResult.snapshot) {
        const lensSnapshot = buildLensSnapshot(snapshotResult.snapshot, run.prevTokens);
        run.lastSnapshot = lensSnapshot;
        if (snapshotResult.snapshot.processes) {
          run.segmenter.updateNamesFromSnapshot(snapshotResult.snapshot.processes);
        }
        if (client.subscribedRuns.has(runId) && client.ws.readyState === WebSocket.OPEN) {
          this.send(client, { type: "snapshot", runId, snapshot: lensSnapshot });
        }
      }

      // Replay historical events through segmenter to rebuild terminal + event feed
      if (eventsResult.events.length > 0 && client.ws.readyState === WebSocket.OPEN) {
        for (const event of eventsResult.events) {
          run.segmenter.ingest(event);
          // Send raw event for the event feed
          this.send(client, { type: "event", runId, event });
        }
        // Send all accumulated terminal lines (terminal sub may have arrived while async was in-flight)
        const termSub = client.terminalSubs.get(runId);
        let lines = run.segmenter.getAllLines();
        if (termSub?.pidSet) lines = lines.filter(l => termSub.pidSet!.has(l.pid));
        if (termSub?.levelSet) lines = lines.filter(l => termSub.levelSet!.has(l.level));
        for (const line of lines) {
          this.send(client, { type: "terminal_line", runId, pid: line.pid, line });
        }
      }
    } catch {
      // Storage fetch failed — client just sees empty state
    }
  }

  // ── Bus event handling ────────────────────────────────────────

  private handleBusEvent(event: LensBusEvent): void {
    switch (event.type) {
      case "event":
        this.handleProtocolEvent(event.runId, event.event);
        break;
      case "snapshot":
        this.handleSnapshot(event.runId, event.snapshot);
        break;
      case "run_end":
        this.broadcastToRun(event.runId, { type: "run_end", runId: event.runId, reason: event.reason });
        break;
    }
  }

  private handleProtocolEvent(runId: string, event: import("../types.js").RuntimeProtocolEvent): void {
    const run = this.getOrCreateRunState(runId);

    // Ingest into stream segmenter
    run.segmenter.ingest(event);

    // Broadcast raw event to subscribed clients
    this.broadcastToRun(runId, { type: "event", runId, event });

    // Extract and broadcast cognitive event if present
    const cognitiveEvent = extractCognitiveEvent(event);
    if (cognitiveEvent) {
      this.broadcastToRun(runId, { type: "cognitive_event", runId, cognitiveEvent });
    }

    // ── Event-driven DAG: derive topology from protocol events ──
    this.deriveStateFromEvent(runId, run, event);

    // If the event has an agentId, send terminal line to process subscribers
    // and global terminal subscribers
    if (event.agentId) {
      const lines = run.segmenter.getLines(event.agentId);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        for (const client of this.clients) {
          // Per-process subscription
          const pids = client.subscribedProcesses.get(runId);
          if (pids?.has(event.agentId)) {
            this.send(client, { type: "terminal_line", runId, pid: event.agentId, line: lastLine });
            continue; // Don't double-send if also has terminal sub
          }

          // Global terminal subscription with filter
          const termSub = client.terminalSubs.get(runId);
          if (termSub) {
            if (termSub.pidSet && !termSub.pidSet.has(lastLine.pid)) continue;
            if (termSub.levelSet && !termSub.levelSet.has(lastLine.level)) continue;
            this.send(client, { type: "terminal_line", runId, pid: event.agentId, line: lastLine });
          }
        }
      }
    }
  }

  // ── Event-derived DAG state ──────────────────────────────────────

  /**
   * Derive DAG/topology state from protocol events in real-time.
   * This makes the topology view event-driven (<10ms latency)
   * instead of depending on periodic snapshot polling.
   */
  private deriveStateFromEvent(
    runId: string,
    run: RunState,
    event: import("../types.js").RuntimeProtocolEvent,
  ): void {
    const action = event.action;
    const detail = event.detail as Record<string, unknown> | undefined;

    if (action === "os_boot") {
      // Initialize an empty snapshot from boot event
      const goal = (detail?.goal as string) ?? event.message?.replace("goal=", "") ?? "";
      const bootRunId = (detail?.runId as string) ?? runId;

      const metacogNode: LensDagNode = {
        pid: "__metacog__",
        name: "metacog",
        type: "daemon" as OsProcessType,
        state: "idle",
        role: "kernel",
        priority: 100,
        parentPid: null,
      };

      const metacogProcess: LensProcess = {
        pid: "__metacog__",
        name: "metacog",
        type: "daemon" as OsProcessType,
        state: "idle",
        role: "kernel",
        parentPid: null,
        children: [],
        objective: "Metacognitive oversight",
        priority: 100,
        tickCount: 0,
        tokensUsed: 0,
        tokenBudget: null,
        model: "",
        spawnedAt: event.timestamp ?? new Date().toISOString(),
        lastActiveAt: event.timestamp ?? new Date().toISOString(),
        backendKind: "llm",
        selfReports: [],
        blackboardIO: [],
      };

      if (!run.lastSnapshot) {
        run.lastSnapshot = {
          runId: bootRunId,
          tick: 0,
          goal,
          elapsed: 0,
          processes: [metacogProcess],
          dag: { nodes: [metacogNode], edges: [] },
          blackboard: {},
          heuristics: [],
          deferrals: [],
          metrics: {
            totalTokens: 0, tokenRate: 0, processCount: 1,
            runningCount: 0, sleepingCount: 0, deadCount: 0,
            checkpointedCount: 0, suspendedCount: 0,
            dagDepth: 0, dagEdgeCount: 0, wallTimeElapsedMs: 0, tickCount: 0,
          },
        };
        this.broadcastToRun(runId, { type: "snapshot", runId, snapshot: run.lastSnapshot });
      }
      return;
    }

    if (action === "os_process_spawn" && detail) {
      const pid = detail.pid as string;
      const name = (detail.name as string) ?? "unknown";
      const objective = (detail.objective as string) ?? "";
      const model = (detail.model as string) ?? "";
      const priority = (detail.priority as number) ?? 50;
      const parentPid = (detail.parentPid as string) ?? null;
      const procType = (detail.type as OsProcessType) ?? "lifecycle";
      const backend = detail.backend as { kind?: "llm" | "system" | "kernel" } | undefined;
      const timestamp = event.timestamp ?? new Date().toISOString();

      if (!pid) return;

      // Determine role
      const role = procType === "daemon" ? "kernel" as const
        : backend?.kind === "kernel" ? "sub-kernel" as const
        : backend?.kind === "system" ? "shell" as const
        : "worker" as const;

      const newProcess: LensProcess = {
        pid, name, type: procType, state: "running", role,
        parentPid, children: [], objective, priority,
        tickCount: 0, tokensUsed: 0, tokenBudget: null,
        model, spawnedAt: timestamp, lastActiveAt: timestamp,
        backendKind: backend?.kind, selfReports: [], blackboardIO: [],
      };

      const newNode: LensDagNode = {
        pid, name, type: procType, state: "running", role,
        priority, parentPid, backendKind: backend?.kind,
      };

      // Build edges
      const newEdges: LensEdge[] = [];
      if (parentPid) {
        newEdges.push({ from: parentPid, to: pid, relation: "parent-child" });
      } else {
        // Top-level process — connect from metacog
        newEdges.push({ from: "__metacog__", to: pid, relation: "orchestrates" });
      }

      // Update parent's children list
      if (parentPid && run.lastSnapshot) {
        const parentProc = run.lastSnapshot.processes.find(p => p.pid === parentPid);
        if (parentProc && !parentProc.children.includes(pid)) {
          parentProc.children = [...parentProc.children, pid];
        }
      }

      if (run.lastSnapshot) {
        // Apply to cached snapshot
        run.lastSnapshot = {
          ...run.lastSnapshot,
          processes: [...run.lastSnapshot.processes, newProcess],
          dag: {
            nodes: [...run.lastSnapshot.dag.nodes, newNode],
            edges: [...run.lastSnapshot.dag.edges, ...newEdges],
          },
          metrics: {
            ...run.lastSnapshot.metrics,
            processCount: run.lastSnapshot.processes.length + 1,
            runningCount: (run.lastSnapshot.metrics.runningCount ?? 0) + 1,
            dagEdgeCount: run.lastSnapshot.dag.edges.length + newEdges.length,
          },
        };

        // Broadcast delta
        const delta: LensSnapshotDelta = {
          tick: run.lastSnapshot.tick,
          timestamp: timestamp,
          processes: {
            added: [newProcess],
            removed: [],
            changed: [],
          },
          dag: {
            addedNodes: [newNode],
            removedNodes: [],
            addedEdges: newEdges,
            removedEdges: [],
          },
          metrics: {
            processCount: run.lastSnapshot.metrics.processCount,
            runningCount: run.lastSnapshot.metrics.runningCount,
            dagEdgeCount: run.lastSnapshot.metrics.dagEdgeCount,
          },
        };
        this.broadcastToRun(runId, { type: "delta", runId, delta });
      }
      return;
    }

    if (action === "os_process_kill" && detail) {
      const pid = detail.pid as string;
      if (!pid || !run.lastSnapshot) return;

      const procIdx = run.lastSnapshot.processes.findIndex(p => p.pid === pid);
      if (procIdx < 0) return;

      const updatedProc = { ...run.lastSnapshot.processes[procIdx], state: "dead" as const };
      const procs = [...run.lastSnapshot.processes];
      procs[procIdx] = updatedProc;

      // Update node state in DAG
      const nodes = run.lastSnapshot.dag.nodes.map(n =>
        n.pid === pid ? { ...n, state: "dead" as const } : n
      );

      const wasRunning = run.lastSnapshot.processes[procIdx].state === "running";

      run.lastSnapshot = {
        ...run.lastSnapshot,
        processes: procs,
        dag: { ...run.lastSnapshot.dag, nodes },
        metrics: {
          ...run.lastSnapshot.metrics,
          deadCount: (run.lastSnapshot.metrics.deadCount ?? 0) + 1,
          runningCount: wasRunning
            ? Math.max(0, (run.lastSnapshot.metrics.runningCount ?? 0) - 1)
            : run.lastSnapshot.metrics.runningCount,
        },
      };

      const delta: LensSnapshotDelta = {
        tick: run.lastSnapshot.tick,
        timestamp: event.timestamp ?? new Date().toISOString(),
        processes: {
          added: [],
          removed: [],
          changed: [{ pid, changed: { state: "dead" } }],
        },
        dag: {
          addedNodes: [],
          removedNodes: [],
          addedEdges: [],
          removedEdges: [],
        },
        metrics: {
          deadCount: run.lastSnapshot.metrics.deadCount,
          runningCount: run.lastSnapshot.metrics.runningCount,
        },
      };
      this.broadcastToRun(runId, { type: "delta", runId, delta });
      return;
    }
  }

  private handleSnapshot(runId: string, rawSnapshot: OsSystemSnapshot): void {
    const run = this.getOrCreateRunState(runId);

    // Backfill PID→name cache from snapshot process list
    if (rawSnapshot.processes) {
      run.segmenter.updateNamesFromSnapshot(rawSnapshot.processes);
    }

    const lensSnapshot = buildLensSnapshot(rawSnapshot, run.prevTokens);
    run.prevTokens = {
      total: rawSnapshot.progressMetrics.totalTokensUsed,
      timestamp: Date.now(),
    };

    // Always inject metacog virtual process/node if not already present.
    // The UI derives DAG from processes, so metacog must be in both arrays.
    this.ensureMetacogInSnapshot(lensSnapshot);

    let snapshotDelta: import("./types.js").LensSnapshotDelta | null = null;

    if (run.lastSnapshot) {
      snapshotDelta = diffSnapshots(run.lastSnapshot, lensSnapshot);
      if (snapshotDelta) {
        this.broadcastToRun(runId, { type: "delta", runId, delta: snapshotDelta });
      }
    } else {
      this.broadcastToRun(runId, { type: "snapshot", runId, snapshot: lensSnapshot });
    }

    run.lastSnapshot = lensSnapshot;

    // Fire-and-forget narrative generation (cheap model, throttled)
    if (this.narrator) {
      const narrator = this.narrator;
      const delta = snapshotDelta;
      const doNarrate = async () => {
        const result = delta
          ? await narrator.fromDelta(lensSnapshot, delta)
          : await narrator.fromSnapshot(lensSnapshot);
        if (result) {
          this.broadcastToRun(runId, { type: "narrative", runId, text: result.text });
        }
      };
      void doNarrate();
    }
  }

  /**
   * Ensure the metacog virtual process/node exists in a snapshot.
   * The UI derives DAG nodes from `processes`, so metacog must appear there.
   */
  private ensureMetacogInSnapshot(snapshot: LensSnapshot): void {
    const METACOG_PID = "__metacog__";
    const hasMetacogProcess = snapshot.processes.some(p => p.pid === METACOG_PID);
    if (!hasMetacogProcess) {
      const hasRunning = snapshot.processes.some(p => p.state === "running");
      const metacogState = hasRunning ? "running" : "idle";

      snapshot.processes.push({
        pid: METACOG_PID,
        name: "metacog",
        type: "daemon" as OsProcessType,
        state: metacogState as any,
        role: "kernel",
        parentPid: null,
        children: [],
        objective: "Metacognitive oversight",
        priority: 100,
        tickCount: 0,
        tokensUsed: 0,
        tokenBudget: null,
        model: "",
        spawnedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        backendKind: "llm",
        selfReports: [],
        blackboardIO: [],
      });
    }

    const hasMetacogNode = snapshot.dag.nodes.some(n => n.pid === METACOG_PID);
    if (!hasMetacogNode) {
      snapshot.dag.nodes.push({
        pid: METACOG_PID,
        name: "metacog",
        type: "daemon" as OsProcessType,
        state: "idle",
        role: "kernel",
        priority: 100,
        parentPid: null,
      });
    }

    // Ensure top-level processes have an "orchestrates" edge from metacog
    for (const proc of snapshot.processes) {
      if (proc.pid === METACOG_PID) continue;
      if (proc.parentPid) continue; // Not top-level
      const hasEdge = snapshot.dag.edges.some(
        e => e.from === METACOG_PID && e.to === proc.pid,
      );
      if (!hasEdge) {
        snapshot.dag.edges.push({
          from: METACOG_PID,
          to: proc.pid,
          relation: "orchestrates",
        });
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private getOrCreateRunState(runId: string): RunState {
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        lastSnapshot: null,
        prevTokens: undefined,
        segmenter: new StreamSegmenter(),
      };
      this.runs.set(runId, run);
    }
    return run;
  }

  private broadcastToRun(runId: string, message: LensServerMessage): void {
    const json = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.subscribedRuns.has(runId) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(json);
      }
    }
  }

  private send(client: ClientState, message: LensServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}
