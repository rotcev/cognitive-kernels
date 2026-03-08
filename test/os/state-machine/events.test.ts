import { describe, expect, test } from "vitest";
import type { KernelEvent, KernelEventInput } from "../../../src/os/state-machine/events.js";

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
      commands: [{ kind: "idle" }, { kind: "bb_write", key: "k", value: "v" }, { kind: "exit", code: 0, reason: "done" }],
      response: "test response",
      timestamp: Date.now(),
      seq: 1,
    };
    expect(event.type).toBe("process_completed");
    expect(event.pid).toBe("proc-1");
    expect(event.commands).toHaveLength(3);
  });

  test("all event types are constructable", () => {
    const ts = Date.now();
    const events: KernelEvent[] = [
      { type: "boot", goal: "g", timestamp: ts, seq: 0 },
      { type: "process_completed", pid: "p", name: "n", success: true, commandCount: 0, tokensUsed: 0, commands: [], response: "", timestamp: ts, seq: 1 },
      { type: "process_submitted", pid: "p", name: "n", model: "m", timestamp: ts, seq: 2 },
      { type: "ephemeral_completed", id: "e", name: "n", success: true, timestamp: ts, seq: 3 },
      { type: "timer_fired", timer: "housekeep", timestamp: ts, seq: 4 },
      { type: "metacog_evaluated", commandCount: 0, triggerCount: 0, timestamp: ts, seq: 5 },
      { type: "awareness_evaluated", hasAdjustment: false, timestamp: ts, seq: 6 },
      { type: "shell_output", pid: "p", hasStdout: true, hasStderr: false, exitCode: 0, timestamp: ts, seq: 7 },
      { type: "external_command", command: "halt", timestamp: ts, seq: 8 },
      { type: "halt_check", result: true, reason: "goal_work_complete", timestamp: ts, seq: 9 },
      { type: "metacog_response_received", response: '{"topology":null}', timestamp: ts, seq: 10 },
      { type: "awareness_response_received", adjustments: [], notes: [], flaggedHeuristics: [], timestamp: ts, seq: 11 },
      { type: "llm_turn_completed", pid: "p", success: true, response: "done", tokensUsed: 100, commands: [], timestamp: ts, seq: 12 },
      { type: "subkernel_completed", pid: "sk-1", success: true, response: "result", tokensUsed: 500, timestamp: ts, seq: 13 },
      { type: "shell_output_received", pid: "sh-1", output: "hello\n", exitCode: 0, timestamp: ts, seq: 14 },
      { type: "ipc_flushed", wokenPids: ["p1", "p2"], timestamp: ts, seq: 15 },
    ];
    expect(events).toHaveLength(16);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });

  test("metacog_response_received event has required fields", () => {
    const event: KernelEvent = {
      type: "metacog_response_received",
      response: '{"topology":null,"memory":[],"halt":null}',
      timestamp: Date.now(),
      seq: 0,
    };
    expect(event.type).toBe("metacog_response_received");
    if (event.type === "metacog_response_received") {
      expect(event.response).toContain("topology");
    }
  });

  test("awareness_response_received event has required fields", () => {
    const event: KernelEvent = {
      type: "awareness_response_received",
      adjustments: [{ type: "priority", pid: "p1", value: 80 }],
      notes: ["Process p1 stalling"],
      flaggedHeuristics: [{ id: "h1", reason: "outdated" }],
      timestamp: Date.now(),
      seq: 0,
    };
    expect(event.type).toBe("awareness_response_received");
    if (event.type === "awareness_response_received") {
      expect(event.adjustments).toHaveLength(1);
      expect(event.notes).toHaveLength(1);
      expect(event.flaggedHeuristics).toHaveLength(1);
    }
  });

  test("llm_turn_completed event has required fields", () => {
    const event: KernelEvent = {
      type: "llm_turn_completed",
      pid: "worker-1",
      success: true,
      response: "Task completed",
      tokensUsed: 1200,
      commands: [{ kind: "idle" }],
      usage: { inputTokens: 800, outputTokens: 400 },
      timestamp: Date.now(),
      seq: 0,
    };
    expect(event.type).toBe("llm_turn_completed");
    if (event.type === "llm_turn_completed") {
      expect(event.pid).toBe("worker-1");
      expect(event.tokensUsed).toBe(1200);
      expect(event.commands).toHaveLength(1);
      expect(event.usage?.inputTokens).toBe(800);
    }
  });

  test("subkernel_completed event has required fields", () => {
    const event: KernelEvent = {
      type: "subkernel_completed",
      pid: "sk-1",
      success: true,
      response: "Sub-kernel finished",
      tokensUsed: 5000,
      timestamp: Date.now(),
      seq: 0,
    };
    expect(event.type).toBe("subkernel_completed");
    if (event.type === "subkernel_completed") {
      expect(event.pid).toBe("sk-1");
      expect(event.success).toBe(true);
      expect(event.tokensUsed).toBe(5000);
    }
  });

  test("shell_output_received event has required fields", () => {
    const event: KernelEvent = {
      type: "shell_output_received",
      pid: "sh-1",
      output: "compilation successful\n",
      exitCode: 0,
      timestamp: Date.now(),
      seq: 0,
    };
    expect(event.type).toBe("shell_output_received");
    if (event.type === "shell_output_received") {
      expect(event.pid).toBe("sh-1");
      expect(event.output).toContain("compilation");
      expect(event.exitCode).toBe(0);
    }
  });

  test("ipc_flushed event has required fields", () => {
    const event: KernelEvent = {
      type: "ipc_flushed",
      wokenPids: ["proc-1", "proc-2", "proc-3"],
      timestamp: Date.now(),
      seq: 0,
    };
    expect(event.type).toBe("ipc_flushed");
    if (event.type === "ipc_flushed") {
      expect(event.wokenPids).toHaveLength(3);
      expect(event.wokenPids).toContain("proc-2");
    }
  });

  test("KernelEventInput omits timestamp and seq for new event types", () => {
    const inputs: KernelEventInput[] = [
      { type: "metacog_response_received", response: "{}" },
      { type: "awareness_response_received", adjustments: [], notes: [], flaggedHeuristics: [] },
      { type: "llm_turn_completed", pid: "p", success: true, response: "", tokensUsed: 0, commands: [] },
      { type: "subkernel_completed", pid: "p", success: true, response: "", tokensUsed: 0 },
      { type: "shell_output_received", pid: "p", output: "", exitCode: 0 },
      { type: "ipc_flushed", wokenPids: [] },
    ];
    expect(inputs).toHaveLength(6);
    for (const input of inputs) {
      // KernelEventInput should not have timestamp or seq
      expect("timestamp" in input).toBe(false);
      expect("seq" in input).toBe(false);
    }
  });
});
