/**
 * Segments protocol events into per-process terminal lines.
 * Maintains ring buffers per PID.
 */

import type { RuntimeProtocolEvent } from "../types.js";
import type { LensTerminalLine, LensTerminalLevel } from "./types.js";

const DEFAULT_BUFFER_SIZE = 500;

export class StreamSegmenter {
  private buffers = new Map<string, LensTerminalLine[]>();
  private maxPerProcess: number;
  private seq = 0;

  constructor(maxPerProcess = DEFAULT_BUFFER_SIZE) {
    this.maxPerProcess = maxPerProcess;
  }

  /**
   * Ingest a protocol event. If it's tagged with an agent, it gets
   * segmented into that agent's terminal buffer.
   */
  ingest(event: RuntimeProtocolEvent): LensTerminalLine | null {
    const pid = event.agentId;
    if (!pid) return null;

    const line = this.classify(event);
    if (!line) return null;

    let buf = this.buffers.get(pid);
    if (!buf) {
      buf = [];
      this.buffers.set(pid, buf);
    }

    buf.push(line);
    if (buf.length > this.maxPerProcess) {
      buf.splice(0, buf.length - this.maxPerProcess);
    }

    return line;
  }

  /**
   * Get all lines for a process.
   */
  getLines(pid: string, limit?: number): LensTerminalLine[] {
    const buf = this.buffers.get(pid) ?? [];
    if (limit && limit < buf.length) {
      return buf.slice(-limit);
    }
    return [...buf];
  }

  /**
   * Get lines added since a given sequence number.
   */
  getLinesSince(pid: string, sinceSeq: number): LensTerminalLine[] {
    const buf = this.buffers.get(pid) ?? [];
    return buf.filter((line) => line.seq > sinceSeq);
  }

  /**
   * Get all PIDs that have buffered lines.
   */
  getPids(): string[] {
    return [...this.buffers.keys()];
  }

  /**
   * Clear all buffers.
   */
  clear(): void {
    this.buffers.clear();
    this.seq = 0;
  }

  /**
   * Classify a protocol event into a terminal line.
   */
  private classify(event: RuntimeProtocolEvent): LensTerminalLine | null {
    const level = this.inferLevel(event);
    const text = this.extractText(event);
    if (!text) return null;

    this.seq++;
    return {
      seq: this.seq,
      timestamp: event.timestamp,
      pid: event.agentId!,
      processName: event.agentName ?? event.agentId!,
      level,
      text,
    };
  }

  private inferLevel(event: RuntimeProtocolEvent): LensTerminalLevel {
    const action = event.action;

    if (action.includes("spawn") || action.includes("kill") || action.includes("checkpoint") || action.includes("exit")) {
      return "system";
    }
    if (action === "os_llm_stream") {
      // Parse the inner StreamEvent to determine type
      try {
        const inner = JSON.parse(event.message ?? "{}");
        if (inner.type === "text_delta") return "thinking";
        if (inner.type === "tool_started" || inner.type === "tool_completed" || inner.type === "tool_progress") return "tool";
        if (inner.type === "status") return "info";
        if (inner.type === "task_started" || inner.type === "task_completed") return "info";
        if (inner.type === "usage") return "info";
      } catch {
        // Fall through
      }
      return "thinking";
    }
    if (action.includes("command")) return "tool";
    if (action.includes("error")) return "error";

    return "info";
  }

  private extractText(event: RuntimeProtocolEvent): string {
    if (!event.message) return "";

    // For LLM stream events, extract meaningful text
    if (event.action === "os_llm_stream") {
      try {
        const inner = JSON.parse(event.message);
        if (inner.type === "text_delta") return inner.text ?? "";
        if (inner.type === "tool_started") return `tool_started: ${inner.toolName}`;
        if (inner.type === "tool_completed") {
          const summary = inner.resultSummary;
          const preview = typeof summary === "string" ? summary.slice(0, 200) : "";
          return `tool_completed: ${inner.toolName}${preview ? " — " + preview : ""}`;
        }
        if (inner.type === "tool_failed") return `tool_failed: ${inner.toolName} — ${inner.error ?? "unknown"}`;
        if (inner.type === "usage") return `usage: ${inner.usage?.inputTokens ?? 0}in/${inner.usage?.outputTokens ?? 0}out`;
        if (inner.type === "status") return `status: ${inner.status}`;
        if (inner.type === "task_started") return `task_started: ${inner.description}`;
        if (inner.type === "task_completed") return `task_completed: ${inner.summary}`;
        return event.message;
      } catch {
        return event.message;
      }
    }

    return event.message;
  }
}
