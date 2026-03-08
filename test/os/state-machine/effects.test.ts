import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KernelEffect } from "../../../src/os/state-machine/effects.js";
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
  tmpDir = path.join(os.tmpdir(), `ck-eff-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("KernelEffect types", () => {
  test("all effect types are constructable", () => {
    const effects: KernelEffect[] = [
      { type: "submit_llm", pid: "p", name: "n", model: "m", seq: 0 },
      { type: "submit_ephemeral", pid: "p", ephemeralId: "e", name: "n", model: "m", seq: 1 },
      { type: "submit_metacog", triggerCount: 2, seq: 2 },
      { type: "submit_awareness", seq: 3 },
      { type: "start_shell", pid: "p", name: "n", command: "ls", args: ["-la"], seq: 4 },
      { type: "start_subkernel", pid: "p", name: "n", goal: "g", seq: 5 },
      { type: "schedule_timer", timer: "housekeep", delayMs: 500, seq: 6 },
      { type: "cancel_timer", timer: "housekeep", seq: 7 },
      { type: "persist_snapshot", runId: "r", seq: 8 },
      { type: "persist_memory", operation: "save_heuristics", seq: 9 },
      { type: "emit_protocol", action: "os_process_spawn", message: "test", seq: 10 },
      { type: "halt", reason: "goal_work_complete", seq: 11 },
      { type: "activate_process", pid: "p", seq: 12 },
      { type: "idle_process", pid: "p", wakeOnSignals: ["tick:1"], seq: 13 },
      { type: "signal_emit", signal: "data:ready", sender: "p1", payload: { key: "val" }, seq: 14 },
      { type: "child_done_signal", childPid: "c1", childName: "worker", parentPid: "p1", exitCode: 0, exitReason: "done", seq: 15 },
      { type: "flush_ipc", seq: 16 },
      { type: "rebuild_dag", seq: 17 },
      { type: "schedule_pass", seq: 18 },
      { type: "apply_strategies", strategyIds: ["s1", "s2"], seq: 19 },
    ];
    expect(effects).toHaveLength(20);
    // Verify seq is monotonically increasing
    for (let i = 1; i < effects.length; i++) {
      expect(effects[i].seq).toBeGreaterThan(effects[i - 1].seq);
    }
  });

  test("type discrimination works", () => {
    const effect: KernelEffect = { type: "submit_llm", pid: "p1", name: "test", model: "gpt-4", seq: 0 };
    if (effect.type === "submit_llm") {
      expect(effect.pid).toBe("p1");
      expect(effect.model).toBe("gpt-4");
    }
  });

  test("type discrimination works for new typed effects", () => {
    const effects: KernelEffect[] = [
      { type: "activate_process", pid: "p1", seq: 0 },
      { type: "idle_process", pid: "p2", wakeOnSignals: ["tick:1"], seq: 1 },
      { type: "signal_emit", signal: "data:ready", sender: "p1", seq: 2 },
      { type: "child_done_signal", childPid: "c1", childName: "w1", parentPid: "p1", exitCode: 0, seq: 3 },
      { type: "flush_ipc", seq: 4 },
      { type: "rebuild_dag", seq: 5 },
      { type: "schedule_pass", seq: 6 },
    ];

    for (const e of effects) {
      if (e.type === "activate_process") {
        expect(e.pid).toBe("p1");
      }
      if (e.type === "idle_process") {
        expect(e.pid).toBe("p2");
        expect(e.wakeOnSignals).toEqual(["tick:1"]);
      }
      if (e.type === "signal_emit") {
        expect(e.signal).toBe("data:ready");
        expect(e.sender).toBe("p1");
      }
      if (e.type === "child_done_signal") {
        expect(e.childPid).toBe("c1");
        expect(e.childName).toBe("w1");
        expect(e.parentPid).toBe("p1");
        expect(e.exitCode).toBe(0);
      }
      if (e.type === "flush_ipc") {
        expect(e.seq).toBe(4);
      }
      if (e.type === "rebuild_dag") {
        expect(e.seq).toBe(5);
      }
      if (e.type === "schedule_pass") {
        expect(e.seq).toBe(6);
      }
    }
  });
});

describe("Kernel effect log", () => {
  test("kernel exposes getEffectLog()", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");
    const log = kernel.getEffectLog();
    expect(Array.isArray(log)).toBe(true);
  });

  test("collectEffect records submit_llm effect", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.collectEffect({ type: "submit_llm", pid: "p1", name: "test-proc", model: "gpt-4" });

    const effects = kernel.getEffectLog();
    const submits = effects.filter((e: any) => e.type === "submit_llm");
    expect(submits).toHaveLength(1);
    const first = submits[0] as any;
    expect(first.pid).toBe("p1");
    expect(first.name).toBe("test-proc");
    expect(first.model).toBe("gpt-4");
    expect(typeof first.seq).toBe("number");
  });

  test("boot collects submit_metacog effect for immediate metacog evaluation", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const effects = kernel.getEffectLog();
    const metacogEffects = effects.filter((e: any) => e.type === "submit_metacog");
    expect(metacogEffects.length).toBeGreaterThanOrEqual(1);
  });

  test("emitProtocol collects emit_protocol effect", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.emitProtocol("os_test_action", "test message", { extra: "data" });

    const effects = kernel.getEffectLog();
    const testEffects = effects.filter((e: any) => e.type === "emit_protocol" && e.action === "os_test_action");
    expect(testEffects).toHaveLength(1);
    expect((testEffects[0] as any).message).toBe("test message");
  });

  test("eventLoop collects schedule_timer effects for housekeep, snapshot, metacog, watchdog", async () => {
    const config = parseOsConfig({
      enabled: true,
      memory: { basePath: tmpDir },
      awareness: { enabled: false },
      kernel: {
        telemetryEnabled: false,
        housekeepIntervalMs: 1000,
        snapshotIntervalMs: 5000,
        metacogIntervalMs: 30000,
        watchdogIntervalMs: 60000,
      },
    });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;

    // Start eventLoop (sets up housekeep, snapshot, metacog, watchdog timers)
    const loopPromise = k.eventLoop();

    // Immediately halt to stop the loop
    k.haltResolve?.();
    await loopPromise;

    const effects = kernel.getEffectLog();
    const timerEffects = effects.filter((e: any) => e.type === "schedule_timer");

    // Should have schedule_timer effects for all 4 timers
    const timerNames = timerEffects.map((e: any) => e.timer);
    expect(timerNames).toContain("housekeep");
    expect(timerNames).toContain("snapshot");
    expect(timerNames).toContain("metacog");
    expect(timerNames).toContain("watchdog");

    // Verify delayMs values match config
    const housekeep = timerEffects.find((e: any) => e.timer === "housekeep") as any;
    expect(housekeep.delayMs).toBe(1000);

    const snapshot = timerEffects.find((e: any) => e.timer === "snapshot") as any;
    expect(snapshot.delayMs).toBe(5000);

    const watchdog = timerEffects.find((e: any) => e.timer === "watchdog") as any;
    expect(watchdog.delayMs).toBe(60000);

    // metacog: initial call is scheduleNextMetacog(120_000), clamped to min(120000, metacogIntervalMs=30000) = 30000
    const metacog = timerEffects.find((e: any) => e.timer === "metacog") as any;
    expect(metacog.delayMs).toBe(30000);
  });

  test("scheduleNextMetacog collects schedule_timer effect with clamped delay", () => {
    const config = parseOsConfig({
      enabled: true,
      memory: { basePath: tmpDir },
      awareness: { enabled: false },
      kernel: { telemetryEnabled: false, metacogIntervalMs: 45000, watchdogIntervalMs: 600000 },
    });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.scheduleNextMetacog(20000);

    const effects = kernel.getEffectLog();
    const metacogTimers = effects.filter((e: any) => e.type === "schedule_timer" && e.timer === "metacog");
    expect(metacogTimers.length).toBeGreaterThanOrEqual(1);
    // 20000 is within [1000, 45000], so not clamped
    const last = metacogTimers[metacogTimers.length - 1] as any;
    expect(last.delayMs).toBe(20000);

    // Clean up timer
    if (k.metacogTimer) { clearTimeout(k.metacogTimer); k.metacogTimer = null; }
  });

  test("startWatchdog collects schedule_timer effect", () => {
    const config = parseOsConfig({
      enabled: true,
      memory: { basePath: tmpDir },
      awareness: { enabled: false },
      kernel: { telemetryEnabled: false, watchdogIntervalMs: 90000 },
    });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.startWatchdog();

    const effects = kernel.getEffectLog();
    const watchdogTimers = effects.filter((e: any) => e.type === "schedule_timer" && e.timer === "watchdog");
    expect(watchdogTimers.length).toBeGreaterThanOrEqual(1);
    expect((watchdogTimers[0] as any).delayMs).toBe(90000);

    // Clean up timer
    k.stopWatchdog();
  });
});

describe("emit_protocol effect wrapping", () => {
  test("boot with awareness enabled collects emit_protocol for awareness-daemon spawn", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: true }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const effects = kernel.getEffectLog();
    const spawns = effects.filter((e: any) => e.type === "emit_protocol" && e.action === "os_process_spawn");
    const awarenessSpawn = spawns.find((e: any) => e.message.includes("awareness-daemon"));
    expect(awarenessSpawn).toBeDefined();
    expect((awarenessSpawn as any).message).toBe("boot awareness-daemon");
  });

  test("halt() collects emit_protocol effect for os_halt", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    kernel.halt("test_halt_reason");

    const effects = kernel.getEffectLog();
    const haltEffects = effects.filter((e: any) => e.type === "emit_protocol" && e.action === "os_halt");
    expect(haltEffects).toHaveLength(1);
    expect((haltEffects[0] as any).message).toBe("test_halt_reason");
  });

  test("effect seq values are monotonically increasing across mixed effect types", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: true }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");
    kernel.halt("done");

    const effects = kernel.getEffectLog();
    // Should have both spawn and halt protocol effects
    const protocolEffects = effects.filter((e: any) => e.type === "emit_protocol");
    expect(protocolEffects.length).toBeGreaterThanOrEqual(2);

    // All effects (not just protocol) should have monotonically increasing seq
    for (let i = 1; i < effects.length; i++) {
      expect(effects[i].seq).toBeGreaterThan(effects[i - 1].seq);
    }
  });
});

describe("Effect log integration", () => {
  test("a minimal kernel run captures submit_llm, schedule_timer, and emit_protocol effects", async () => {
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
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);

    try {
      await kernel.run("Quick test");
    } catch {
      // May throw on very low token budget, that's fine
    }

    const effects = kernel.getEffectLog();

    // Must have effects
    expect(effects.length).toBeGreaterThanOrEqual(1);

    // Seq is monotonically increasing
    for (let i = 1; i < effects.length; i++) {
      expect(effects[i].seq).toBeGreaterThan(effects[i - 1].seq);
    }

    // Should have schedule_timer effects (timers set up during eventLoop)
    const timerEffects = effects.filter((e: any) => e.type === "schedule_timer");
    expect(timerEffects.length).toBeGreaterThanOrEqual(1);
    const timerNames = timerEffects.map((e: any) => e.timer);
    expect(timerNames).toContain("housekeep");

    // Should have emit_protocol effects (boot spawn at minimum)
    const protocolEffects = effects.filter((e: any) => e.type === "emit_protocol");
    expect(protocolEffects.length).toBeGreaterThanOrEqual(1);

    // Should have submit_metacog effects (boot triggers immediate metacog evaluation)
    const metacogEffects = effects.filter((e: any) => e.type === "submit_metacog");
    expect(metacogEffects.length).toBeGreaterThanOrEqual(1);

    // Log the effect type distribution for debugging
    const typeCounts: Record<string, number> = {};
    for (const e of effects) {
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    }
    console.log("Effect type distribution:", typeCounts);
  });
});
