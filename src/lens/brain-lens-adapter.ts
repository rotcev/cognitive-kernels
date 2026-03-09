/**
 * BrainLensAdapter — bridges brain-specific streaming to the Lens layer.
 *
 * Different brain backends (Codex/OpenAI vs Claude) have different streaming
 * characteristics:
 * - Codex: tool events arrive with ThreadEvent semantics, batched per item
 * - Claude: text_delta events are fine-grained, tool events carry provider field
 *
 * This adapter:
 * 1. Normalizes stream events to a consistent shape for Lens consumption
 * 2. Enriches events with provider metadata (which brain produced this)
 * 3. Throttles high-frequency text_delta events to avoid WebSocket flooding
 * 4. Emits structured protocol events for Lens-aware tool tracking
 */

import type { OsProtocolEmitter } from "../os/protocol-emitter.js";
import type { StreamEvent, StreamEventCallback, BrainProvider } from "../types.js";

/** Throttle config per provider — tuned for their streaming characteristics. */
const THROTTLE_MS: Record<BrainProvider, number> = {
  codex: 50,   // Codex batches naturally — light throttle
  claude: 100, // Claude streams fine-grained text_delta — throttle harder
};

export interface BrainLensAdapterOptions {
  emitter: OsProtocolEmitter;
  provider: BrainProvider;
}

export class BrainLensAdapter {
  private readonly emitter: OsProtocolEmitter;
  private readonly provider: BrainProvider;
  private readonly throttleMs: number;

  constructor(options: BrainLensAdapterOptions) {
    this.emitter = options.emitter;
    this.provider = options.provider;
    this.throttleMs = THROTTLE_MS[options.provider];
  }

  /**
   * Create a stream callback for a specific process.
   * Returned callback can be passed to BrainThread.run() as onStreamEvent.
   */
  createStreamCallback(pid: string, processName: string): StreamEventCallback {
    let lastTextDeltaAt = 0;
    let pendingText = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (pendingText) {
        this.emitter.emitStreamEvent(pid, processName, {
          type: "text_delta",
          text: pendingText,
        });
        pendingText = "";
      }
      flushTimer = null;
    };

    return (event: StreamEvent) => {
      // Text deltas: throttle to avoid flooding the WebSocket
      if (event.type === "text_delta") {
        pendingText += event.text;
        const now = Date.now();
        if (now - lastTextDeltaAt >= this.throttleMs) {
          // Enough time passed — flush immediately
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          flush();
          lastTextDeltaAt = now;
        } else if (!flushTimer) {
          // Schedule a flush for remaining text
          flushTimer = setTimeout(() => {
            flush();
            lastTextDeltaAt = Date.now();
          }, this.throttleMs);
        }
        return;
      }

      // Flush any pending text before non-text events
      if (pendingText) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        flush();
      }

      // All non-text events: emit immediately with provider enrichment
      this.emitter.emitStreamEvent(pid, processName, event);
    };
  }
}
