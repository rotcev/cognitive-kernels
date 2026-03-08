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
    ];
    expect(effects).toHaveLength(12);
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

  test("boot collects emit_protocol effect for os_process_spawn", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const effects = kernel.getEffectLog();
    const spawns = effects.filter((e: any) => e.type === "emit_protocol" && e.action === "os_process_spawn");
    expect(spawns.length).toBeGreaterThanOrEqual(1);
    expect((spawns[0] as any).message).toContain("goal-orchestrator");
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

    // Should have submit_llm effects (goal-orchestrator gets submitted)
    const submitEffects = effects.filter((e: any) => e.type === "submit_llm");
    expect(submitEffects.length).toBeGreaterThanOrEqual(1);

    // Log the effect type distribution for debugging
    const typeCounts: Record<string, number> = {};
    for (const e of effects) {
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    }
    console.log("Effect type distribution:", typeCounts);
  });
});
