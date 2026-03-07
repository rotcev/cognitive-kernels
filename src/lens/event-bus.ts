/**
 * Typed in-process event bus for the Lens layer.
 *
 * The kernel's OsProtocolEmitter optionally emits to this bus.
 * The Lens subscribes to it for real-time event ingestion without polling.
 */

import { EventEmitter } from "node:events";
import type { RuntimeProtocolEvent } from "../types.js";
import type { OsSystemSnapshot } from "../os/types.js";

export type LensBusEvent =
  | { type: "event"; runId: string; event: RuntimeProtocolEvent }
  | { type: "snapshot"; runId: string; snapshot: OsSystemSnapshot }
  | { type: "run_start"; runId: string }
  | { type: "run_end"; runId: string; reason: string };

export class LensEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: LensBusEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit("*", event);
  }

  on(type: LensBusEvent["type"] | "*", listener: (event: LensBusEvent) => void): void {
    this.emitter.on(type, listener);
  }

  off(type: LensBusEvent["type"] | "*", listener: (event: LensBusEvent) => void): void {
    this.emitter.off(type, listener);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
