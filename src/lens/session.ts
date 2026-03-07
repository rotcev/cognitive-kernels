/**
 * Lens session — the orchestrator that ties the Lens components together.
 *
 * Manages per-run state, subscribes to the event bus, and coordinates
 * the WebSocket server. Supports two modes:
 *
 * 1. In-process: kernel emitter pushes directly to the LensEventBus (zero-cost)
 * 2. Storage poller: for child-process runs, polls Neon for new events/snapshots
 */

import { LensEventBus } from "./event-bus.js";
import { LensServer } from "./server.js";
import { LensStoragePoller } from "./file-watcher.js";
import type { NarrativeGenerator } from "./narrative.js";
import type { StorageBackend } from "../db/storage-backend.js";
import type { Server as HttpServer } from "node:http";

export interface LensSessionOptions {
  /** Port for standalone WebSocket server. Ignored if `httpServer` is provided. */
  port?: number;
  /** Attach to an existing HTTP server instead of creating a standalone one. */
  httpServer?: HttpServer;
  /** Storage backend for polling child-process runs. */
  storage?: StorageBackend;
  /** Poll interval for storage poller (ms). Default: 2000. */
  pollIntervalMs?: number;
  /** Narrative generator for human-readable status summaries. */
  narrator?: NarrativeGenerator;
}

export class LensSession {
  readonly bus: LensEventBus;
  readonly server: LensServer;

  private pollers = new Map<string, LensStoragePoller>();
  private storage?: StorageBackend;
  private pollIntervalMs: number;
  private started = false;

  constructor(options: LensSessionOptions = {}) {
    this.bus = new LensEventBus();
    this.storage = options.storage;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;

    this.server = new LensServer({
      bus: this.bus,
      port: options.port ?? 3200,
      server: options.httpServer,
      narrator: options.narrator,
      storage: options.storage,
    });
  }

  /**
   * Start the Lens session — begins accepting WebSocket connections.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await this.server.start();
    this.started = true;
  }

  /**
   * Stop the Lens session — closes all connections and pollers.
   */
  async stop(): Promise<void> {
    for (const poller of this.pollers.values()) {
      poller.stop();
    }
    this.pollers.clear();
    await this.server.stop();
    this.bus.removeAllListeners();
    this.started = false;
  }

  /**
   * Start observing a child-process run via storage polling.
   * For in-process runs, the emitter's lensBus handles this automatically.
   */
  observeRun(runId: string): void {
    if (!this.storage) {
      throw new Error("Cannot observe run without a storage backend. Pass `storage` to LensSession.");
    }
    if (this.pollers.has(runId)) return;

    const poller = new LensStoragePoller({
      runId,
      storage: this.storage,
      bus: this.bus,
      pollIntervalMs: this.pollIntervalMs,
    });
    this.pollers.set(runId, poller);
    poller.start();
  }

  /**
   * Stop observing a child-process run.
   */
  unobserveRun(runId: string): void {
    const poller = this.pollers.get(runId);
    if (poller) {
      poller.stop();
      this.pollers.delete(runId);
    }
  }

  /**
   * Get the address the WebSocket server is listening on.
   */
  get address(): { port: number } | null {
    return this.server.address;
  }
}
