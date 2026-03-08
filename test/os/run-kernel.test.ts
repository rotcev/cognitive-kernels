import { describe, it, expect, vi, afterEach } from "vitest";
import { runKernel } from "../../src/os/run-kernel.js";
import type { OsConfig } from "../../src/os/types.js";
import type { Brain, BrainThread } from "../../src/types.js";

/**
 * Build a minimal but structurally valid OsConfig.
 * Uses short timers so tests halt quickly.
 */
function makeTestConfig(overrides?: Partial<OsConfig>): OsConfig {
  return {
    enabled: true,
    kernel: {
      tickIntervalMs: 50,
      maxConcurrentProcesses: 4,
      metacogCadence: 1,
      metacogModel: "test-model",
      processModel: "test-model",
      tokenBudget: 100_000,
      wallTimeLimitMs: 30_000,
      housekeepIntervalMs: 50,
      metacogIntervalMs: 50,
      snapshotIntervalMs: 60_000, // long — we don't need snapshots in tests
    },
    scheduler: {
      strategy: "priority" as const,
      maxConcurrentProcesses: 4,
      tickIntervalMs: 50,
      metacogCadence: 1,
      metacogTriggers: ["boot"],
    },
    ipc: {
      blackboardMaxKeys: 100,
    },
    memory: {
      snapshotCadence: 10,
      heuristicDecayRate: 0.1,
      heuristicPruneThreshold: 0.01,
      maxHeuristics: 100,
      consolidationIntervalTicks: 50,
      basePath: "/tmp/test-memory",
    },
    processes: {
      maxDepth: 5,
      maxTotalProcesses: 20,
      defaultPriority: 10,
    },
    ephemeral: {
      enabled: false,
      maxPerProcess: 3,
      maxConcurrent: 5,
      defaultModel: "test-model",
    },
    systemProcess: {
      enabled: false,
      maxSystemProcesses: 5,
      stdoutBufferLines: 100,
    },
    childKernel: {
      enabled: false,
      maxChildKernels: 3,
      defaultMaxTicks: 50,
      ticksPerParentTurn: 5,
      maxDepth: 2,
    },
    awareness: {
      enabled: false,
      cadence: 5,
      historyWindow: 100,
      model: "test-model",
    },
    observation: {
      enabled: false,
      browserMcp: {
        command: "echo",
        args: [],
        maxInstances: 1,
      },
      defaultModel: "test-model",
    },
    ...overrides,
  } as OsConfig;
}

/**
 * Build a mock Brain whose metacog response declares a halt.
 * The metacog agent calls brain.startThread().run() with the metacog prompt,
 * so we return a halt response in the topology format.
 */
function makeHaltingBrain(): Brain {
  return {
    startThread: vi.fn().mockReturnValue({
      id: "thread-1",
      run: vi.fn().mockResolvedValue({
        finalResponse: JSON.stringify({
          assessment: "goal achieved",
          topology: null,
          memory: [],
          halt: { status: "achieved", summary: "done" },
          citedHeuristicIds: [],
        }),
      }),
      abort: vi.fn(),
    } satisfies BrainThread),
  };
}

describe("runKernel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs event loop until halt", async () => {
    const brain = makeHaltingBrain();
    const config = makeTestConfig();

    const state = await runKernel("say hello", config, brain, null);

    expect(state.halted).toBe(true);
    expect(state.goal).toBe("say hello");
  }, 10_000);

  it("boot creates no daemon processes (metacog/awareness are kernel-level modules)", async () => {
    const brain = makeHaltingBrain();
    const config = makeTestConfig();

    const state = await runKernel("test goal", config, brain, null);

    // No metacog-daemon or awareness-daemon in process table — they're kernel-level modules now
    const metacogDaemon = [...state.processes.values()].find(
      (p) => p.name === "metacog-daemon",
    );
    expect(metacogDaemon).toBeUndefined();
  }, 10_000);

  it("halt reason is set", async () => {
    const brain = makeHaltingBrain();
    const config = makeTestConfig();

    const state = await runKernel("halt test", config, brain, null);

    expect(state.haltReason).toBeTruthy();
    expect(state.haltReason).toContain("achieved");
  }, 10_000);

  it("emits protocol events when emitter is provided", async () => {
    const brain = makeHaltingBrain();
    const config = makeTestConfig();
    const mockEmitter = {
      emit: vi.fn(),
      writeLiveState: vi.fn(),
      saveSnapshot: vi.fn(),
    };

    const state = await runKernel(
      "emit test",
      config,
      brain,
      mockEmitter as any,
    );

    expect(state.halted).toBe(true);
    // Should have emitted at least boot and halt events
    expect(mockEmitter.emit).toHaveBeenCalled();
    const calls = mockEmitter.emit.mock.calls.map((c: any[]) => c[0]?.action);
    expect(calls).toContain("os_boot");
  }, 10_000);

  it("returns final state with runId set", async () => {
    const brain = makeHaltingBrain();
    const config = makeTestConfig();

    const state = await runKernel("id test", config, brain, null);

    expect(state.runId).toBeTruthy();
    expect(typeof state.runId).toBe("string");
    expect(state.runId.length).toBeGreaterThan(0);
  }, 10_000);
});
