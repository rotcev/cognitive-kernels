import { randomUUID } from "node:crypto";
import type {
  OsBlackboardEntry,
  OsSignal,
  OsSignalSubscription,
  OsIpcConfig,
  OsIpcSummary,
} from "./types.js";

export function matchSignalPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes("*")) return pattern === name;

  // Convert glob pattern to regex
  // ** matches anything including colons
  // * matches anything except colons
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      regexStr += "[^:]*";
      i += 1;
    } else if (
      pattern[i] === "." ||
      pattern[i] === "(" ||
      pattern[i] === ")" ||
      pattern[i] === "[" ||
      pattern[i] === "]" ||
      pattern[i] === "{" ||
      pattern[i] === "}" ||
      pattern[i] === "+" ||
      pattern[i] === "?" ||
      pattern[i] === "^" ||
      pattern[i] === "$" ||
      pattern[i] === "|" ||
      pattern[i] === "\\"
    ) {
      regexStr += "\\" + pattern[i];
      i += 1;
    } else {
      regexStr += pattern[i];
      i += 1;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr).test(name);
}

export class OsIpcBus {
  private blackboard: Map<string, OsBlackboardEntry> = new Map();
  private subscriptions: OsSignalSubscription[] = [];
  private pendingSignals: Map<string, OsSignal[]> = new Map();
  private config: OsIpcConfig;

  constructor(config: OsIpcConfig) {
    this.config = config;
  }

  // ── Blackboard ────────────────────────────────────────────────────

  bbWrite(key: string, value: unknown, writerPid: string): void {
    const existing = this.blackboard.get(key);
    if (!existing && this.blackboard.size >= this.config.blackboardMaxKeys) {
      throw new Error(
        `Blackboard max keys (${this.config.blackboardMaxKeys}) exceeded`,
      );
    }

    if (existing) {
      existing.value = value;
      existing.version += 1;
      existing.writtenBy = writerPid;
      existing.writtenAt = new Date().toISOString();
    } else {
      this.blackboard.set(key, {
        key,
        value,
        version: 1,
        writtenBy: writerPid,
        writtenAt: new Date().toISOString(),
        readBy: [],
      });
    }
  }

  bbRead(key: string, readerPid?: string): OsBlackboardEntry | undefined {
    const entry = this.blackboard.get(key);
    if (entry && readerPid && !entry.readBy.includes(readerPid)) {
      entry.readBy.push(readerPid);
    }
    return entry;
  }

  bbReadAll(): OsBlackboardEntry[] {
    return Array.from(this.blackboard.values());
  }

  bbDelete(key: string): void {
    this.blackboard.delete(key);
  }

  // ── Signals ───────────────────────────────────────────────────────

  subscribe(pid: string, signalPattern: string): void {
    this.subscriptions.push({ pid, signalPattern });
    if (!this.pendingSignals.has(pid)) {
      this.pendingSignals.set(pid, []);
    }
  }

  unsubscribe(pid: string, signalPattern?: string): void {
    if (signalPattern === undefined) {
      this.subscriptions = this.subscriptions.filter((s) => s.pid !== pid);
    } else {
      this.subscriptions = this.subscriptions.filter(
        (s) => !(s.pid === pid && s.signalPattern === signalPattern),
      );
    }
  }

  emitSignal(name: string, emittedBy: string, payload?: unknown): OsSignal {
    const signal: OsSignal = {
      name,
      emittedBy,
      payload,
      emittedAt: new Date().toISOString(),
    };

    for (const sub of this.subscriptions) {
      if (matchSignalPattern(sub.signalPattern, name)) {
        const pending = this.pendingSignals.get(sub.pid);
        if (pending) {
          pending.push(signal);
        } else {
          this.pendingSignals.set(sub.pid, [signal]);
        }
      }
    }

    return signal;
  }

  getPendingSignals(pid: string): OsSignal[] {
    const signals = this.pendingSignals.get(pid) ?? [];
    this.pendingSignals.set(pid, []);
    return signals;
  }

  // ── General ───────────────────────────────────────────────────────

  flush(): { wokenPids: string[] } {
    const wokenPids = new Set<string>();

    // Collect PIDs that have pending signals
    for (const [pid, signals] of this.pendingSignals) {
      if (signals.length > 0) {
        wokenPids.add(pid);
      }
    }

    return { wokenPids: Array.from(wokenPids) };
  }

  summary(): OsIpcSummary {
    let signalCount = 0;
    for (const [, signals] of this.pendingSignals) {
      signalCount += signals.length;
    }

    return {
      signalCount,
      blackboardKeyCount: this.blackboard.size,
    };
  }

  getPendingForProcess(
    pid: string,
  ): { signals: OsSignal[] } {
    const signals = this.pendingSignals.get(pid) ?? [];
    return { signals };
  }
}
