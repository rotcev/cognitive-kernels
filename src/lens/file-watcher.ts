/**
 * Storage poller for the Lens.
 *
 * For kernel runs not in the current process (e.g. started by another server
 * instance), the Lens polls the storage backend for new events and snapshots.
 *
 * Neon is the source of truth. This poller queries it incrementally using
 * seq-based cursors and emits to the LensEventBus so downstream consumers
 * see no difference from in-process runs.
 */

import type { LensEventBus } from "./event-bus.js";
import type { StorageBackend } from "../db/storage-backend.js";

export interface StoragePollerOptions {
  runId: string;
  storage: StorageBackend;
  bus: LensEventBus;
  pollIntervalMs?: number;
}

export class LensStoragePoller {
  private readonly runId: string;
  private readonly storage: StorageBackend;
  private readonly bus: LensEventBus;
  private readonly pollIntervalMs: number;

  private lastSeq = 0;
  private lastSnapshotTick = -1;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private stopped = false;

  constructor(options: StoragePollerOptions) {
    this.runId = options.runId;
    this.storage = options.storage;
    this.bus = options.bus;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  start(): void {
    this.stopped = false;
    this.bus.emit({ type: "run_start", runId: this.runId });

    // Initial poll
    void this.poll();

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.storage.isConnected() || this.polling) return;

    this.polling = true;
    try {
      // Fetch new events since last known seq (single indexed query)
      const { events, lastSeq } = await this.storage.fetchEventsSince(this.runId, this.lastSeq);
      if (lastSeq > this.lastSeq) {
        this.lastSeq = lastSeq;
        for (const event of events) {
          this.bus.emit({ type: "event", runId: this.runId, event });
        }
      }

      // Fetch latest snapshot (single indexed query)
      const state = await this.storage.fetchLatestSnapshot(this.runId);
      if (state.snapshot && state.source !== "missing") {
        const tick = state.snapshot.tickCount ?? -1;
        if (tick > this.lastSnapshotTick) {
          this.lastSnapshotTick = tick;
          this.bus.emit({ type: "snapshot", runId: this.runId, snapshot: state.snapshot });
        }
      }
    } catch {
      // Polling failure is non-fatal — retry on next interval
    } finally {
      this.polling = false;
    }
  }
}
