import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KernelEvent } from "../../../src/os/state-machine/events.js";
import { OsKernel } from "../../../src/os/kernel.js";
import { parseOsConfig } from "../../../src/os/config.js";
import type { Brain, BrainThread, TurnResult } from "../../../src/types.js";

class MockThread implements BrainThread {
  readonly id = "mock-thread";
  abort(): void {}
  async run(): Promise<TurnResult> {
    return { finalResponse: "Acknowledged." };
  }
}

class MockBrain implements Brain {
  startThread(): BrainThread { return new MockThread(); }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `ck-sm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("KernelEvent types", () => {
  test("boot event has required fields", () => {
    const event: KernelEvent = {
      type: "boot",
      goal: "test goal",
      timestamp: Date.now(),
      seq: 0,
    };
    expect(event.type).toBe("boot");
    expect(event.goal).toBe("test goal");
    expect(event.seq).toBe(0);
  });

  test("process_completed event has required fields", () => {
    const event: KernelEvent = {
      type: "process_completed",
      pid: "proc-1",
      name: "test-proc",
      success: true,
      commandCount: 3,
      tokensUsed: 1500,
      timestamp: Date.now(),
      seq: 1,
    };
    expect(event.type).toBe("process_completed");
    expect(event.pid).toBe("proc-1");
  });

  test("all event types are constructable", () => {
    const ts = Date.now();
    const events: KernelEvent[] = [
      { type: "boot", goal: "g", timestamp: ts, seq: 0 },
      { type: "process_completed", pid: "p", name: "n", success: true, commandCount: 0, tokensUsed: 0, timestamp: ts, seq: 1 },
      { type: "process_submitted", pid: "p", name: "n", model: "m", timestamp: ts, seq: 2 },
      { type: "ephemeral_completed", id: "e", name: "n", success: true, timestamp: ts, seq: 3 },
      { type: "timer_fired", timer: "housekeep", timestamp: ts, seq: 4 },
      { type: "metacog_evaluated", commandCount: 0, triggerCount: 0, timestamp: ts, seq: 5 },
      { type: "awareness_evaluated", hasAdjustment: false, timestamp: ts, seq: 6 },
      { type: "shell_output", pid: "p", hasStdout: true, hasStderr: false, exitCode: 0, timestamp: ts, seq: 7 },
      { type: "external_command", command: "halt", timestamp: ts, seq: 8 },
      { type: "halt_check", result: true, reason: "goal_work_complete", timestamp: ts, seq: 9 },
    ];
    expect(events).toHaveLength(10);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });
});

describe("Kernel event log", () => {
  test("boot records a boot event", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const log = kernel.getEventLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].type).toBe("boot");
    if (log[0].type === "boot") {
      expect(log[0].goal).toBe("Test goal");
      expect(log[0].seq).toBe(0);
    }
  });

  test("event seq is monotonically increasing", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const log = kernel.getEventLog();
    for (let i = 1; i < log.length; i++) {
      expect(log[i].seq).toBeGreaterThan(log[i - 1].seq);
    }
  });
});
