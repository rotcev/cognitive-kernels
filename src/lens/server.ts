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
import type { LensSnapshot, LensSnapshotDelta, LensTerminalLine, LensTerminalLevel, LensTerminalFilter, LensServerMessage, LensClientMessage } from "./types.js";
import { buildLensSnapshot } from "./view-models.js";
import { diffSnapshots } from "./snapshot-differ.js";
import { StreamSegmenter } from "./stream-segmenter.js";
import { extractCognitiveEvent } from "./cognitive-events.js";
import type { NarrativeGenerator } from "./narrative.js";
import type { OsSystemSnapshot } from "../os/types.js";

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
