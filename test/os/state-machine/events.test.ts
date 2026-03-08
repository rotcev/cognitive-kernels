import { describe, expect, test } from "vitest";
import type { KernelEvent } from "../../../src/os/state-machine/events.js";

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
