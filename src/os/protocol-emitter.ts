import path from "node:path";
import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import type { RuntimeProtocolEvent, RuntimeProtocolAction, RuntimeProtocolStatus, StreamEvent } from "../types.js";
import type { OsSystemSnapshot } from "./types.js";

const DB_FLUSH_BATCH_SIZE = 10;
const DB_FLUSH_INTERVAL_MS = 1_000;

export type OsProtocolEventInput = {
  action: RuntimeProtocolAction;
  status: RuntimeProtocolStatus;
  message?: string;
  agentId?: string;
  agentName?: string;
};

export type OsProtocolEmitterStorageBackend = {
  isConnected(): boolean;
  appendEvents?(runId: string, events: RuntimeProtocolEvent[]): Promise<void> | void;
  saveSnapshot?(runId: string, snapshot: OsSystemSnapshot, source: "live" | "final"): Promise<void> | void;
};

export type OsProtocolEmitterFileOptions = {
  protocolLogPath: string;
  snapshotPath: string;
  livePath: string;
  storageBackend?: OsProtocolEmitterStorageBackend;
};

export type OsProtocolEmitterDbOnlyOptions = {
  storageBackend: OsProtocolEmitterStorageBackend;
  runId: string;
};

export type OsProtocolEmitterOptions = OsProtocolEmitterFileOptions | OsProtocolEmitterDbOnlyOptions;

export class OsProtocolEmitter {
  private readonly stream: WriteStream | null;
  private readonly snapshotPath: string | null;
  private readonly livePath: string | null;
  private readonly runId: string;
  private readonly storageBackend?: OsProtocolEmitterStorageBackend;
  private readonly bufferedEvents: RuntimeProtocolEvent[] = [];

  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(options: OsProtocolEmitterOptions);
  constructor(protocolLogPath: string, snapshotPath: string, livePath: string, storageBackend?: OsProtocolEmitterStorageBackend);
  constructor(
    optionsOrPath: OsProtocolEmitterOptions | string,
    snapshotPath?: string,
    livePath?: string,
    storageBackend?: OsProtocolEmitterStorageBackend,
  ) {
    if (typeof optionsOrPath === "string") {
      // Legacy positional args
      this.stream = createWriteStream(optionsOrPath, { flags: "a" });
      this.snapshotPath = snapshotPath!;
      this.livePath = livePath!;
      this.runId = path.basename(path.dirname(optionsOrPath));
      this.storageBackend = storageBackend;
    } else if ("protocolLogPath" in optionsOrPath) {
      this.stream = createWriteStream(optionsOrPath.protocolLogPath, { flags: "a" });
      this.snapshotPath = optionsOrPath.snapshotPath;
      this.livePath = optionsOrPath.livePath;
      this.runId = path.basename(path.dirname(optionsOrPath.protocolLogPath));
      this.storageBackend = optionsOrPath.storageBackend;
    } else {
      // DB-only mode
      this.stream = null;
      this.snapshotPath = null;
      this.livePath = null;
      this.runId = optionsOrPath.runId;
      this.storageBackend = optionsOrPath.storageBackend;
    }
  }

  emit(input: OsProtocolEventInput): void {
    const event: RuntimeProtocolEvent = {
      action: input.action,
      status: input.status,
      timestamp: new Date().toISOString(),
      message: input.message,
      agentId: input.agentId,
      agentName: input.agentName,
      eventSource: "os",
    };

    this.stream?.write(`${JSON.stringify(event)}\n`);
    this.enqueueBackendEvent(event);
  }

  emitStreamEvent(pid: string, processName: string, event: StreamEvent): void {
    // Filter empty text_delta events
    if (event.type === "text_delta" && !event.text) return;

    const entry: RuntimeProtocolEvent = {
      action: "os_llm_stream",
      status: "started",
      timestamp: new Date().toISOString(),
      agentId: pid,
      agentName: processName,
      message: JSON.stringify(event),
      eventSource: "os",
    };

    this.stream?.write(`${JSON.stringify(entry)}\n`);
    this.enqueueBackendEvent(entry);
  }

  writeLiveState(snapshot: OsSystemSnapshot): void {
    if (this.livePath) {
      writeFileSync(this.livePath, JSON.stringify(snapshot, null, 2), "utf8");
    }

    if (this.storageBackend?.isConnected() && typeof this.storageBackend.saveSnapshot === "function") {
      void Promise.resolve(this.storageBackend.saveSnapshot(this.runId, snapshot, "live")).catch(() => {
        // Filesystem snapshot artifacts are authoritative; DB writes are best-effort.
      });
    }
  }

  saveSnapshot(snapshot: OsSystemSnapshot): void {
    this.writeLiveState(snapshot);
    if (this.snapshotPath) {
      writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
    }

    if (this.storageBackend?.isConnected() && typeof this.storageBackend.saveSnapshot === "function") {
      void Promise.resolve(this.storageBackend.saveSnapshot(this.runId, snapshot, "final")).catch(() => {
        // Filesystem snapshot artifacts are authoritative; DB writes are best-effort.
      });
    }
  }

  private enqueueBackendEvent(event: RuntimeProtocolEvent): void {
    if (!this.storageBackend?.isConnected() || typeof this.storageBackend.appendEvents !== "function") {
      return;
    }

    this.bufferedEvents.push(event);

    if (this.bufferedEvents.length >= DB_FLUSH_BATCH_SIZE) {
      this.clearFlushTimer();
      this.flushBufferedEvents();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushBufferedEvents();
      }, DB_FLUSH_INTERVAL_MS);

      if (typeof this.flushTimer.unref === "function") {
        this.flushTimer.unref();
      }
    }
  }

  private flushBufferedEvents(): void {
    if (this.flushInFlight) {
      return;
    }

    if (this.bufferedEvents.length === 0) {
      return;
    }

    const batch = this.bufferedEvents.splice(0, DB_FLUSH_BATCH_SIZE);

    this.flushInFlight = Promise.resolve(this.storageBackend?.appendEvents?.(this.runId, batch))
      .catch(() => {
        // Filesystem protocol log is authoritative; DB event writes are best-effort.
      })
      .finally(() => {
        this.flushInFlight = null;

        if (this.bufferedEvents.length >= DB_FLUSH_BATCH_SIZE) {
          this.flushBufferedEvents();
          return;
        }

        if (this.bufferedEvents.length > 0 && !this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushBufferedEvents();
          }, DB_FLUSH_INTERVAL_MS);

          if (typeof this.flushTimer.unref === "function") {
            this.flushTimer.unref();
          }
        }
      });
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) {
      return;
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  async close(): Promise<void> {
    this.clearFlushTimer();

    while (this.bufferedEvents.length > 0 || this.flushInFlight) {
      this.flushBufferedEvents();
      if (this.flushInFlight) {
        await this.flushInFlight;
      }
    }

    if (this.stream) {
      await new Promise<void>((resolve) => {
        this.stream!.end(() => resolve());
      });
    }
  }
}
