import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KernelEvent, KernelEventInput } from "../../../src/os/state-machine/events.js";
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

  test("submitting a process records process_submitted event", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    // Stub scheduling pass to prevent infinite re-submission loop
    k.doSchedulingPass = () => {};

    // Add a test process manually since boot no longer creates goal-orchestrator
    const testPid = "test-proc-1";
    k.table.addDirect({
      pid: testPid,
      type: "lifecycle",
      state: "running",
      name: "test-worker",
      parentPid: null,
      objective: "test",
      priority: 70,
      spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tickCount: 0,
      tokensUsed: 0,
      model: config.kernel.processModel,
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan",
      restartPolicy: "never",
    });
    const proc = k.table.get(testPid);
    expect(proc).toBeTruthy();
    k.submitProcess(proc);

    const log = kernel.getEventLog();
    const submitted = log.filter((e: any) => e.type === "process_submitted");
    expect(submitted.length).toBeGreaterThanOrEqual(1);
    const first = submitted[0] as any;
    expect(first.pid).toBeTruthy();
    expect(first.name).toBeTruthy();
    expect(first.seq).toBeGreaterThan(0);
  });

  test("housekeep records timer_fired event", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.doSchedulingPass = () => {};
    k.safeHousekeep();

    const log = kernel.getEventLog();
    const timerEvents = log.filter((e: any) => e.type === "timer_fired" && e.timer === "housekeep");
    expect(timerEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("process completion records process_completed event", async () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000, maxConcurrentProcesses: 10 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.doSchedulingPass = () => {};

    // Add a test process manually since boot no longer creates goal-orchestrator
    const testPid = "test-proc-complete";
    k.table.addDirect({
      pid: testPid,
      type: "lifecycle",
      state: "running",
      name: "test-worker",
      parentPid: null,
      objective: "test",
      priority: 70,
      spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tickCount: 0,
      tokensUsed: 0,
      model: config.kernel.processModel,
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan",
      restartPolicy: "never",
    });

    await k.onProcessComplete({
      pid: testPid,
      success: true,
      response: "test",
      tokensUsed: 500,
      commands: [{ kind: "idle", wakeOnSignals: ["tick:1"] }],
    });

    const log = kernel.getEventLog();
    const completed = log.filter((e: any) => e.type === "process_completed");
    expect(completed.length).toBe(1);
    const evt = completed[0] as any;
    expect(evt.pid).toBe(testPid);
    expect(evt.name).toBe("test-worker");
    expect(evt.success).toBe(true);
    expect(evt.tokensUsed).toBe(500);
    expect(evt.commandCount).toBe(1);
  });

  test("shouldHalt records halt_check event", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.eventLog.length = 0;

    kernel.shouldHalt();

    const log = kernel.getEventLog();
    const haltChecks = log.filter((e: any) => e.type === "halt_check");
    expect(haltChecks.length).toBe(1);
    expect((haltChecks[0] as any).result).toBe(false);
  });

  test("metacog evaluation records metacog_evaluated event", async () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.doSchedulingPass = () => {};
    // Add a trigger so shouldConsultMetacog() returns true
    k.pendingTriggers = ["test_trigger"];

    await k.doMetacogCheck();

    const log = kernel.getEventLog();
    const metacogEvents = log.filter((e: any) => e.type === "metacog_evaluated");
    expect(metacogEvents.length).toBe(1);
    expect(typeof (metacogEvents[0] as any).commandCount).toBe("number");
    expect(typeof (metacogEvents[0] as any).triggerCount).toBe("number");
  });
});

describe("Event log integration", () => {
  test("a minimal kernel run produces a complete event sequence", async () => {
    const brain = new MockBrain();
    const config = parseOsConfig({
      enabled: true,
      memory: { basePath: tmpDir },
      awareness: { enabled: false },
      kernel: {
        telemetryEnabled: false,
        watchdogIntervalMs: 600000,
        maxConcurrentProcesses: 3,
        tokenBudget: 100, // very low — forces quick halt
      },
    });
    const kernel = new OsKernel(config, brain, tmpDir);

    try {
      await kernel.run("Quick test");
    } catch {
      // May throw on very low token budget, that's fine
    }

    const log = kernel.getEventLog();

    // Must have at least a boot event
    expect(log[0].type).toBe("boot");

    // Seq is monotonically increasing
    for (let i = 1; i < log.length; i++) {
      expect(log[i].seq).toBeGreaterThan(log[i - 1].seq);
    }

    // All events have timestamps
    for (const event of log) {
      expect(event.timestamp).toBeGreaterThan(0);
    }

    // Should have halt_check events (kernel checks halt condition during run)
    const haltChecks = log.filter((e: any) => e.type === "halt_check");
    expect(haltChecks.length).toBeGreaterThanOrEqual(1);

    // Log the event type distribution for debugging
    const typeCounts: Record<string, number> = {};
    for (const e of log) {
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    }
    console.log("Event type distribution:", typeCounts);
  });
});
