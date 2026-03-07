import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OsKernel } from "../../src/os/kernel.js";
import { parseOsConfig } from "../../src/os/config.js";
import type { Brain, BrainThread, TurnResult } from "../../src/types.js";
import type { OsProcessTurnResult } from "../../src/os/types.js";
import { AsyncMutex } from "../../src/os/async-mutex.js";

// ─── Mock Brain ────────────────────────────────────────────────────────────

class MockThread implements BrainThread {
  readonly id = "mock-thread";
  private delayMs: number;
  private responseFn: () => string;

  constructor(delayMs = 0, responseFn?: () => string) {
    this.delayMs = delayMs;
    this.responseFn = responseFn ?? (() => "Acknowledged.");
  }

  abort(): void {}

  async run(_input: string): Promise<TurnResult> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return { finalResponse: this.responseFn() };
  }
}

class MockBrain implements Brain {
  delayMs = 0;
  responseFn?: () => string;

  startThread(): BrainThread {
    return new MockThread(this.delayMs, this.responseFn);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `ck-event-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTestConfig(overrides?: Record<string, unknown>) {
  return parseOsConfig({
    enabled: true,
    kernel: {
      tickIntervalMs: 10,
      metacogCadence: 3,
      wallTimeLimitMs: 0,
      maxConcurrentProcesses: 10,
      telemetryEnabled: false,
      watchdogIntervalMs: 600000,
      ...((overrides?.kernel as Record<string, unknown>) ?? {}),
    },
    memory: {
      basePath: tmpDir,
    },
    awareness: {
      enabled: false,
    },
  });
}

function bootKernel(
  brain?: Brain,
  configOverrides?: Record<string, unknown>,
): OsKernel {
  const b = brain ?? new MockBrain();
  const kernel = new OsKernel(makeTestConfig(configOverrides), b, tmpDir);
  kernel.boot("Test goal for event-driven kernel");
  return kernel;
}

/** Access private members of kernel for testing. */
function priv(kernel: OsKernel): Record<string, any> {
  return kernel as any;
}

/**
 * Neutralize doSchedulingPass so onProcessComplete doesn't
 * re-submit processes (avoids infinite loop in unit tests).
 */
function stubSchedulingPass(kernel: OsKernel): void {
  priv(kernel).doSchedulingPass = () => {};
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Event-driven kernel: boot sanity", () => {
  test("boot creates expected processes", () => {
    const kernel = bootKernel();
    const snap = kernel.snapshot();
    const names = snap.processes.map((p) => p.name);

    expect(names).toContain("goal-orchestrator");
    expect(names).toContain("metacog-daemon");

    kernel.halt("test_complete");
  });
});

describe("Event-driven kernel: concurrency", () => {
  test("submitProcess runs multiple processes concurrently (fan-out)", async () => {
    const brain = new MockBrain();
    brain.delayMs = 60;
    const kernel = bootKernel(brain);

    // Prevent completion handler from re-submitting (avoid infinite loop)
    stubSchedulingPass(kernel);

    const supervisor = priv(kernel).supervisor;
    const workers = [];
    for (let i = 0; i < 3; i++) {
      const w = supervisor.spawn({
        type: "lifecycle" as const,
        name: `fan-worker-${i}`,
        objective: `Worker ${i} task`,
        priority: 70,
        model: "mock",
        workingDir: tmpDir,
      });
      supervisor.activate(w.pid);
      workers.push(w);
    }

    const startTime = Date.now();
    for (const w of workers) {
      priv(kernel).submitProcess(w);
    }

    const inflight = priv(kernel).inflight as Map<
      string,
      Promise<OsProcessTurnResult>
    >;
    expect(inflight.size).toBeGreaterThanOrEqual(3);

    // Wait for all to settle
    await Promise.allSettled([...inflight.values()]);
    const elapsed = Date.now() - startTime;

    // 3 x 60ms concurrent should be ~60ms, not 180ms.
    // Allow generous overhead (e.g. prompt building, FS ops).
    expect(elapsed).toBeLessThan(150);

    // Wait for .then handlers
    await new Promise((r) => setTimeout(r, 30));

    kernel.halt("test_complete");
  }, 10000);

  test("inflight map tracks in-progress processes correctly", async () => {
    const brain = new MockBrain();
    brain.delayMs = 40;
    const kernel = bootKernel(brain);
    stubSchedulingPass(kernel);

    const supervisor = priv(kernel).supervisor;
    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "tracked-worker",
      objective: "Test tracking",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    const inflight = priv(kernel).inflight as Map<
      string,
      Promise<OsProcessTurnResult>
    >;

    priv(kernel).submitProcess(w);
    expect(inflight.has(w.pid)).toBe(true);

    await Promise.allSettled([...inflight.values()]);
    await new Promise((r) => setTimeout(r, 30));

    expect(inflight.has(w.pid)).toBe(false);

    kernel.halt("test_complete");
  }, 10000);

  test("duplicate submitProcess for same PID is a no-op", async () => {
    const brain = new MockBrain();
    brain.delayMs = 50;
    const kernel = bootKernel(brain);
    stubSchedulingPass(kernel);

    const supervisor = priv(kernel).supervisor;
    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "dedup-worker",
      objective: "Test dedup",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    priv(kernel).submitProcess(w);
    const inflight = priv(kernel).inflight as Map<
      string,
      Promise<OsProcessTurnResult>
    >;
    const sizeAfterFirst = inflight.size;

    // Second submit for same PID — should be a no-op
    priv(kernel).submitProcess(w);
    expect(inflight.size).toBe(sizeAfterFirst);

    await Promise.allSettled([...inflight.values()]);
    kernel.halt("test_complete");
  }, 10000);
});

describe("Event-driven kernel: sequential completions", () => {
  test("100 sequential onProcessComplete calls without resource leaks", async () => {
    const kernel = bootKernel();
    stubSchedulingPass(kernel);

    const table = priv(kernel).table;
    const supervisor = priv(kernel).supervisor;
    const mutex = priv(kernel).mutex as AsyncMutex;

    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "stress-worker",
      objective: "Stress test",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    for (let i = 0; i < 100; i++) {
      await priv(kernel).onProcessComplete({
        pid: w.pid,
        success: true,
        response: `Result ${i}`,
        tokensUsed: 10,
        commands: [],
      } satisfies OsProcessTurnResult);
    }

    // Inflight should not have grown
    const inflightAfter = priv(kernel).inflight as Map<string, any>;
    expect(inflightAfter.has(w.pid)).toBe(false);

    // Mutex should be free
    expect(mutex.isLocked).toBe(false);
    expect(mutex.waitingCount).toBe(0);

    // Tokens should be accumulated
    const proc = table.get(w.pid);
    expect(proc.tokensUsed).toBe(1000); // 100 * 10

    kernel.halt("test_complete");
  }, 30000);
});

describe("Event-driven kernel: error survival", () => {
  test("executor error on submitProcess triggers error-path onProcessComplete", async () => {
    const brain = new MockBrain();
    brain.responseFn = () => {
      throw new Error("Simulated LLM failure");
    };

    const kernel = bootKernel(brain);
    stubSchedulingPass(kernel);

    const supervisor = priv(kernel).supervisor;

    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "error-worker",
      objective: "Test error survival",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    priv(kernel).submitProcess(w);

    const inflight = priv(kernel).inflight as Map<
      string,
      Promise<OsProcessTurnResult>
    >;
    await Promise.allSettled([...inflight.values()]);
    await new Promise((r) => setTimeout(r, 50));

    // Kernel should still be alive
    expect(priv(kernel).halted).toBe(false);
    // Inflight should be empty
    expect(inflight.size).toBe(0);

    kernel.halt("test_complete");
  }, 10000);

  test("onProcessComplete with unknown pid is a no-op", async () => {
    const kernel = bootKernel();
    stubSchedulingPass(kernel);

    // Should not throw
    await priv(kernel).onProcessComplete({
      pid: "nonexistent-pid",
      success: true,
      response: "Ghost result",
      tokensUsed: 0,
      commands: [],
    } satisfies OsProcessTurnResult);

    expect(priv(kernel).halted).toBe(false);

    kernel.halt("test_complete");
  }, 10000);
});

describe("Event-driven kernel: halt behavior", () => {
  test("halted kernel does not process new results via onProcessComplete", async () => {
    const kernel = bootKernel();
    stubSchedulingPass(kernel);

    const supervisor = priv(kernel).supervisor;
    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "post-halt-worker",
      objective: "Should not process",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);
    const table = priv(kernel).table;
    const tokensBefore = table.get(w.pid).tokensUsed;

    // Halt first
    kernel.halt("test_halt");

    // Try to process — should be rejected by the halted guard
    await priv(kernel).onProcessComplete({
      pid: w.pid,
      success: true,
      response: "Post-halt result",
      tokensUsed: 100,
      commands: [],
    } satisfies OsProcessTurnResult);

    // Tokens should NOT have been added
    expect(table.get(w.pid).tokensUsed).toBe(tokensBefore);
  }, 10000);

  test("shouldHalt detects wall time exceeded", async () => {
    const kernel = bootKernel(undefined, {
      kernel: { wallTimeLimitMs: 50 },
    });

    // Wait for wall time to expire
    await new Promise((r) => setTimeout(r, 80));

    expect(kernel.shouldHalt()).toBe(true);

    kernel.halt("test_complete");
  }, 10000);

  test("shouldHalt returns true after halt() call", () => {
    const kernel = bootKernel();

    expect(kernel.shouldHalt()).toBe(false);
    kernel.halt("manual_halt");
    expect(kernel.shouldHalt()).toBe(true);
  });
});

describe("Event-driven kernel: safety guards", () => {
  test("safeHousekeep returns early when halted", async () => {
    const kernel = bootKernel();
    kernel.halt("test_halt");

    const mutex = priv(kernel).mutex as AsyncMutex;
    await priv(kernel).safeHousekeep();

    // Mutex should not be locked — returned early before acquiring
    expect(mutex.isLocked).toBe(false);
  }, 10000);

  test("safeMetacogCheck returns early when halted", async () => {
    const kernel = bootKernel();
    kernel.halt("test_halt");

    await priv(kernel).safeMetacogCheck();

    const mutex = priv(kernel).mutex as AsyncMutex;
    expect(mutex.isLocked).toBe(false);
  }, 10000);

  test("safeSnapshotWrite returns early when halted", () => {
    const kernel = bootKernel();
    kernel.halt("test_halt");

    // Should not throw
    priv(kernel).safeSnapshotWrite();
  });

  test("doSchedulingPass respects maxConcurrentProcesses", async () => {
    const brain = new MockBrain();
    brain.delayMs = 200; // Slow enough to stay in-flight

    const kernel = bootKernel(brain, {
      kernel: { maxConcurrentProcesses: 2 },
    });

    const supervisor = priv(kernel).supervisor;
    for (let i = 0; i < 5; i++) {
      const w = supervisor.spawn({
        type: "lifecycle" as const,
        name: `limited-worker-${i}`,
        objective: `Worker ${i}`,
        priority: 70,
        model: "mock",
        workingDir: tmpDir,
      });
      supervisor.activate(w.pid);
    }

    // Stub out onProcessComplete to prevent cascading
    const origOnComplete = priv(kernel).onProcessComplete.bind(kernel);
    priv(kernel).onProcessComplete = async () => {};

    priv(kernel).doSchedulingPass();

    const inflight = priv(kernel).inflight as Map<string, any>;
    // Should not exceed maxConcurrentProcesses
    expect(inflight.size).toBeLessThanOrEqual(2);

    // Restore and cleanup
    priv(kernel).onProcessComplete = origOnComplete;
    await Promise.allSettled([...inflight.values()]);
    kernel.halt("test_complete");
  }, 10000);
});

describe("Event-driven kernel: mutex serialization", () => {
  test("concurrent onProcessComplete calls are serialized", async () => {
    const kernel = bootKernel();
    stubSchedulingPass(kernel);

    const supervisor = priv(kernel).supervisor;
    const table = priv(kernel).table;

    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "mutex-worker",
      objective: "Test mutex",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    // Fire 10 concurrent calls
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        priv(kernel).onProcessComplete({
          pid: w.pid,
          success: true,
          response: `Concurrent result ${i}`,
          tokensUsed: 1,
          commands: [],
        } satisfies OsProcessTurnResult),
      );
    }

    await Promise.all(promises);

    // All 10 should have been applied sequentially
    const proc = table.get(w.pid);
    expect(proc.tickCount).toBe(10);
    expect(proc.tokensUsed).toBe(10);

    // Mutex should be free
    const mutex = priv(kernel).mutex as AsyncMutex;
    expect(mutex.isLocked).toBe(false);
    expect(mutex.waitingCount).toBe(0);

    kernel.halt("test_complete");
  }, 30000);
});

describe("Event-driven kernel: housekeep integration", () => {
  test("housekeep increments tick counter", () => {
    const kernel = bootKernel();
    const scheduler = priv(kernel).scheduler;

    const tickBefore = scheduler.tickCount;
    priv(kernel).housekeep();
    expect(scheduler.tickCount).toBe(tickBefore + 1);

    kernel.halt("test_complete");
  });

  test("housekeep wakes expired sleepers", () => {
    const kernel = bootKernel();
    const supervisor = priv(kernel).supervisor;
    const table = priv(kernel).table;

    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "sleepy-worker",
      objective: "Test sleep wake",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    // Put to sleep with 0ms duration (immediately expired)
    supervisor.sleep(w.pid, 0);
    expect(table.get(w.pid).state).toBe("sleeping");

    priv(kernel).housekeep();

    expect(table.get(w.pid).state).toBe("running");

    kernel.halt("test_complete");
  });

  test("stall detection force-wakes idle processes after 3 empty cycles", () => {
    const kernel = bootKernel();
    const supervisor = priv(kernel).supervisor;
    const table = priv(kernel).table;

    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "stalled-worker",
      objective: "Test stall detection",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);
    supervisor.idle(w.pid, {});
    expect(table.get(w.pid).state).toBe("idle");

    // 3 housekeep cycles with no inflight → triggers stall detection
    priv(kernel).housekeep();
    priv(kernel).housekeep();
    priv(kernel).housekeep();

    expect(table.get(w.pid).state).toBe("running");

    kernel.halt("test_complete");
  });
});

describe("Event-driven kernel: timer lifecycle", () => {
  test("stopEventLoop clears all timers", () => {
    const kernel = bootKernel();

    // Simulate timers being set
    priv(kernel).housekeepTimer = setInterval(() => {}, 99999);
    priv(kernel).snapshotTimer = setInterval(() => {}, 99999);
    priv(kernel).metacogTimer = setInterval(() => {}, 99999);

    priv(kernel).stopEventLoop();

    expect(priv(kernel).housekeepTimer).toBeNull();
    expect(priv(kernel).snapshotTimer).toBeNull();
    expect(priv(kernel).metacogTimer).toBeNull();

    kernel.halt("test_complete");
  });

  test("eventLoop resolves when haltResolve is called", async () => {
    const brain = new MockBrain();
    brain.delayMs = 10;
    const kernel = bootKernel(brain);

    // Stub submitProcess to prevent actual executor calls
    priv(kernel).submitProcess = () => {};

    const loopPromise = priv(kernel).eventLoop();

    // Brief delay then halt
    await new Promise((r) => setTimeout(r, 50));
    kernel.halt("external_halt");
    priv(kernel).haltResolve?.();

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("eventLoop did not resolve within 5s")),
        5000,
      ),
    );

    await Promise.race([loopPromise, timeout]);

    // Timers should be cleaned up
    expect(priv(kernel).housekeepTimer).toBeNull();
    expect(priv(kernel).snapshotTimer).toBeNull();
    expect(priv(kernel).metacogTimer).toBeNull();
  }, 10000);
});

describe("Event-driven kernel: stability hardening", () => {
  test("submitProcess is a no-op when halted", async () => {
    const brain = new MockBrain();
    brain.delayMs = 50;
    const kernel = bootKernel(brain);

    const supervisor = priv(kernel).supervisor;
    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "post-halt-submit",
      objective: "Should not be submitted",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    kernel.halt("test_halt");

    priv(kernel).submitProcess(w);

    const inflight = priv(kernel).inflight as Map<string, any>;
    expect(inflight.has(w.pid)).toBe(false);
  });

  test("doSchedulingPass is a no-op when halted", () => {
    const kernel = bootKernel();

    kernel.halt("test_halt");

    // Should not throw and should not submit any processes
    const inflightBefore = (priv(kernel).inflight as Map<string, any>).size;
    priv(kernel).doSchedulingPass();
    const inflightAfter = (priv(kernel).inflight as Map<string, any>).size;

    expect(inflightAfter).toBe(inflightBefore);
  });

  test("stream tracking maps are cleaned up per-process on completion", async () => {
    const brain = new MockBrain();
    brain.delayMs = 30;
    const kernel = bootKernel(brain);
    stubSchedulingPass(kernel);

    const supervisor = priv(kernel).supervisor;
    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "stream-cleanup-worker",
      objective: "Test stream cleanup",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    // Manually set stream tracking entries to simulate streaming
    priv(kernel).lastStreamEventAt.set(w.pid, Date.now());
    priv(kernel).streamTokenCount.set(w.pid, 42);

    priv(kernel).submitProcess(w);

    const inflight = priv(kernel).inflight as Map<
      string,
      Promise<OsProcessTurnResult>
    >;
    await Promise.allSettled([...inflight.values()]);
    await new Promise((r) => setTimeout(r, 30));

    // Stream tracking should be cleaned up for this pid
    expect(priv(kernel).lastStreamEventAt.has(w.pid)).toBe(false);
    expect(priv(kernel).streamTokenCount.has(w.pid)).toBe(false);

    kernel.halt("test_complete");
  }, 10000);

  test("turnKillCallbacks are cleaned up on process completion", async () => {
    const brain = new MockBrain();
    brain.delayMs = 30;
    const kernel = bootKernel(brain);
    stubSchedulingPass(kernel);

    const supervisor = priv(kernel).supervisor;
    const w = supervisor.spawn({
      type: "lifecycle" as const,
      name: "kill-cleanup-worker",
      objective: "Test kill callback cleanup",
      priority: 70,
      model: "mock",
      workingDir: tmpDir,
    });
    supervisor.activate(w.pid);

    priv(kernel).submitProcess(w);

    // Should have a kill callback while in-flight
    expect(priv(kernel).turnKillCallbacks.has(w.pid)).toBe(true);

    const inflight = priv(kernel).inflight as Map<
      string,
      Promise<OsProcessTurnResult>
    >;
    await Promise.allSettled([...inflight.values()]);
    await new Promise((r) => setTimeout(r, 30));

    // Kill callback should be cleaned up after completion
    expect(priv(kernel).turnKillCallbacks.has(w.pid)).toBe(false);
    expect(priv(kernel).turnStartTimes.has(w.pid)).toBe(false);

    kernel.halt("test_complete");
  }, 10000);
});
