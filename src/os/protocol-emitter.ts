import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import type { RuntimeProtocolEvent, RuntimeProtocolAction, RuntimeProtocolStatus, StreamEvent } from "../types.js";
import type { OsSystemSnapshot } from "./types.js";

export type OsProtocolEventInput = {
  action: RuntimeProtocolAction;
  status: RuntimeProtocolStatus;
  message?: string;
  agentId?: string;
  agentName?: string;
};

export class OsProtocolEmitter {
  private readonly stream: WriteStream;
  private readonly snapshotPath: string;
  private readonly livePath: string;

  constructor(protocolLogPath: string, snapshotPath: string, livePath: string) {
    this.stream = createWriteStream(protocolLogPath, { flags: "a" });
    this.snapshotPath = snapshotPath;
    this.livePath = livePath;
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
    this.stream.write(`${JSON.stringify(event)}\n`);
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
    this.stream.write(`${JSON.stringify(entry)}\n`);
  }

  writeLiveState(snapshot: OsSystemSnapshot): void {
    writeFileSync(this.livePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  writeSnapshot(snapshot: OsSystemSnapshot): void {
    this.writeLiveState(snapshot);
    writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}
