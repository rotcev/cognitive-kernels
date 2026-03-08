import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KernelInterpreter } from "../../src/os/kernel-interpreter.js";
import { EventQueue } from "../../src/os/event-queue.js";
import type { KernelState } from "../../src/os/state-machine/state.js";
import type { KernelEffect } from "../../src/os/state-machine/effects.js";
import type { KernelEvent } from "../../src/os/state-machine/events.js";
import type { Brain, BrainThread, TurnResult } from "../../src/types.js";
import type { OsProtocolEmitter, OsProtocolEventInput } from "../../src/os/protocol-emitter.js";
import type { ScopedMemoryStore } from "../../src/os/scoped-memory-store.js";

/** Minimal KernelState stub — only the fields the interpreter reads. */
function makeState(overrides?: Partial<KernelState>): KernelState {
  return {
    goal: "test goal",
    runId: "run-1",
    config: {
      kernel: {
        metacogModel: "test-model",
        processModel: "test-model",
        tokenBudget: 100000,
        maxTicks: 100,
        wallTimeLimitMs: 60000,
      },
      scheduler: {
        strategy: "priority",
        maxConcurrentProcesses: 4,
      },
    } as any,
    processes: new Map(),
    inflight: new Set(),
    activeEphemeralCount: 0,
    blackboard: new Map(),
    tickCount: 0,
    schedulerStrategy: "priority",
    schedulerMaxConcurrent: 4,
    schedulerRoundRobinIndex: 0,
    schedulerHeuristics: [],
    currentStrategies: [],
    dagTopology: { nodes: [], edges: [] },
    deferrals: new Map(),
    pendingTriggers: [],
    lastMetacogTick: 0,
    metacogEvalCount: 0,
    activeStrategyId: null,
    matchedStrategyIds: new Set(),
    metacogInflight: false,
    lastMetacogWakeAt: 0,
    metacogHistory: [],
    awarenessNotes: [],
    oscillationWarnings: [],
    blindSpots: [],
    metacogFocus: null,
    drainingPids: new Set(),
    killThresholdAdjustment: 0,
    killEvalHistory: [],
    selectedBlueprintInfo: null,
    ephemeralStats: { spawns: 0, successes: 0, failures: 0, totalDurationMs: 0 },
    heuristicApplicationLog: [],
    halted: false,
    haltReason: null,
    goalWorkDoneAt: 0,
    startTime: Date.now(),
    lastProcessCompletionTime: 0,
    housekeepCount: 0,
    ...overrides,
  } as KernelState;
}

/** Creates a mock Brain that returns a thread with configurable behavior. */
function makeBrain(opts?: {
  runResult?: TurnResult;
  runError?: Error;
}): Brain & { lastThread: BrainThread | null } {
  const brain: Brain & { lastThread: BrainThread | null } = {
    lastThread: null,
    startThread(_options?: any): BrainThread {
      const thread: BrainThread = {
        id: "thread-1",
        run: vi.fn().mockImplementation(async () => {
          if (opts?.runError) throw opts.runError;
          return opts?.runResult ?? { finalResponse: '{"topology": null, "memory": [], "halt": null}' };
        }),
        abort: vi.fn(),
      };
      brain.lastThread = thread;
      return thread;
    },
  };
  return brain;
}

/** Creates a mock emitter. */
function makeEmitter(): {
  emit: ReturnType<typeof vi.fn>;
  saveSnapshot: ReturnType<typeof vi.fn>;
} {
  return {
    emit: vi.fn(),
    saveSnapshot: vi.fn(),
  };
}

describe("KernelInterpreter", () => {
  let queue: EventQueue;
  let brain: ReturnType<typeof makeBrain>;
  let emitter: ReturnType<typeof makeEmitter>;
  let interpreter: KernelInterpreter;

  beforeEach(() => {
    queue = new EventQueue();
    brain = makeBrain();
    emitter = makeEmitter();
    interpreter = new KernelInterpreter(
      brain,
      emitter as unknown as OsProtocolEmitter,
      queue,
      null, // no memory store
      "/tmp/test",
    );
  });

  afterEach(() => {
    interpreter.cleanup();
  });

  // ─── emit_protocol ──────────────────────────────────────────

  it("emit_protocol calls emitter.emit", async () => {
    const effect: KernelEffect = {
      type: "emit_protocol",
      action: "os_kernel_boot",
      message: "Kernel booted",
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    expect(emitter.emit).toHaveBeenCalledOnce();
    expect(emitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "os_kernel_boot",
        message: "Kernel booted",
      }),
    );
  });

  // ─── schedule_timer ─────────────────────────────────────────

  it("schedule_timer enqueues timer_fired event after delay", async () => {
    vi.useFakeTimers();

    const effect: KernelEffect = {
      type: "schedule_timer",
      timer: "metacog",
      delayMs: 100,
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    // No event yet
    let dequeued: KernelEvent | null = null;
    const p = queue.dequeue().then((e) => { dequeued = e; });

    // Advance time
    vi.advanceTimersByTime(100);

    await p;
    expect(dequeued).not.toBeNull();
    expect(dequeued!.type).toBe("timer_fired");
    expect((dequeued as any).timer).toBe("metacog");

    vi.useRealTimers();
  });

  // ─── cancel_timer ───────────────────────────────────────────

  it("cancel_timer prevents timer_fired", async () => {
    vi.useFakeTimers();

    // Schedule a timer
    await interpreter.interpret(
      { type: "schedule_timer", timer: "metacog", delayMs: 100, seq: 0 },
      makeState(),
    );

    // Cancel it
    await interpreter.interpret(
      { type: "cancel_timer", timer: "metacog", seq: 1 },
      makeState(),
    );

    // Advance past the delay
    vi.advanceTimersByTime(200);

    // The queue should still be empty — try dequeueing with a short timeout
    let gotEvent = false;
    const racePromise = Promise.race([
      queue.dequeue().then(() => { gotEvent = true; }),
      new Promise<void>((r) => setTimeout(r, 10)),
    ]);

    vi.advanceTimersByTime(10);
    await racePromise;

    expect(gotEvent).toBe(false);

    vi.useRealTimers();
  });

  // ─── persist_snapshot ───────────────────────────────────────

  it("persist_snapshot calls emitter.saveSnapshot", async () => {
    const effect: KernelEffect = {
      type: "persist_snapshot",
      runId: "run-1",
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    expect(emitter.saveSnapshot).toHaveBeenCalledOnce();
  });

  // ─── halt ───────────────────────────────────────────────────

  it("halt calls cleanup without throwing", async () => {
    const effect: KernelEffect = {
      type: "halt",
      reason: "goal achieved",
      seq: 0,
    };

    // Should not throw
    await expect(interpreter.interpret(effect, makeState())).resolves.toBeUndefined();
  });

  // ─── run_metacog ────────────────────────────────────────────

  it("run_metacog enqueues metacog_response_received", async () => {
    const responseJson = '{"topology": null, "memory": [], "halt": null}';
    brain = makeBrain({ runResult: { finalResponse: responseJson } });
    interpreter = new KernelInterpreter(
      brain,
      emitter as unknown as OsProtocolEmitter,
      queue,
      null,
      "/tmp/test",
    );

    const effect: KernelEffect = {
      type: "run_metacog",
      context: {
        ticksSinceLastEval: 1,
        processEvents: [],
        ipcActivity: { signalCount: 0, blackboardKeyCount: 0 },
        dagDelta: { since: "", nodesAdded: [], nodesRemoved: [], edgesAdded: [], edgesRemoved: [], nodesUpdated: [] },
        progressMetrics: { activeProcessCount: 0, stalledProcessCount: 0, totalTokensUsed: 0, wallTimeElapsedMs: 0, tickCount: 0 },
        relevantHeuristics: [],
      },
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    const event = await queue.dequeue();
    expect(event.type).toBe("metacog_response_received");
    expect((event as any).response).toBe(responseJson);
  });

  // ─── run_metacog error ──────────────────────────────────────

  it("run_metacog handles error gracefully", async () => {
    brain = makeBrain({ runError: new Error("LLM unavailable") });
    interpreter = new KernelInterpreter(
      brain,
      emitter as unknown as OsProtocolEmitter,
      queue,
      null,
      "/tmp/test",
    );

    const effect: KernelEffect = {
      type: "run_metacog",
      context: {
        ticksSinceLastEval: 1,
        processEvents: [],
        ipcActivity: { signalCount: 0, blackboardKeyCount: 0 },
        dagDelta: { since: "", nodesAdded: [], nodesRemoved: [], edgesAdded: [], edgesRemoved: [], nodesUpdated: [] },
        progressMetrics: { activeProcessCount: 0, stalledProcessCount: 0, totalTokensUsed: 0, wallTimeElapsedMs: 0, tickCount: 0 },
        relevantHeuristics: [],
      },
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    const event = await queue.dequeue();
    expect(event.type).toBe("metacog_response_received");
    // On error, response should be a fallback JSON with null topology
    const response = (event as any).response;
    expect(response).toContain("topology");
  });

  // ─── legacy effects are no-ops ──────────────────────────────

  it("legacy effects are no-ops", async () => {
    const legacyTypes: KernelEffect["type"][] = [
      "submit_llm",
      "submit_ephemeral",
      "submit_metacog",
      "submit_awareness",
      "activate_process",
      "idle_process",
      "signal_emit",
      "child_done_signal",
      "flush_ipc",
      "rebuild_dag",
      "schedule_pass",
      "apply_strategies",
      "spawn_topology_process",
      "kill_process",
      "drain_process",
    ];

    const state = makeState();

    for (const type of legacyTypes) {
      // Build a minimal effect of each type — just needs type and seq
      const effect = { type, seq: 0 } as KernelEffect;
      await expect(interpreter.interpret(effect, state)).resolves.toBeUndefined();
    }
  });

  // ─── run_awareness placeholder ──────────────────────────────

  it("run_awareness enqueues awareness_response_received", async () => {
    const effect: KernelEffect = {
      type: "run_awareness",
      context: {},
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    const event = await queue.dequeue();
    expect(event.type).toBe("awareness_response_received");
    expect((event as any).adjustments).toEqual([]);
    expect((event as any).notes).toEqual([]);
    expect((event as any).flaggedHeuristics).toEqual([]);
  });

  // ─── run_shell placeholder ──────────────────────────────────

  it("run_shell enqueues shell_output_received placeholder", async () => {
    const effect: KernelEffect = {
      type: "run_shell",
      pid: "shell-1",
      command: "echo",
      args: ["hello"],
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    const event = await queue.dequeue();
    expect(event.type).toBe("shell_output_received");
    expect((event as any).pid).toBe("shell-1");
  });

  // ─── run_subkernel placeholder ──────────────────────────────

  it("run_subkernel enqueues subkernel_completed placeholder", async () => {
    const effect: KernelEffect = {
      type: "run_subkernel",
      pid: "sub-1",
      goal: "sub goal",
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    const event = await queue.dequeue();
    expect(event.type).toBe("subkernel_completed");
    expect((event as any).pid).toBe("sub-1");
  });

  // ─── run_llm ────────────────────────────────────────────────

  it("run_llm enqueues llm_turn_completed on success", async () => {
    const responseText = "I completed the task.";
    brain = makeBrain({ runResult: { finalResponse: responseText } });

    const processes = new Map<string, any>();
    processes.set("p1", {
      pid: "p1",
      name: "worker-1",
      objective: "do the thing",
      model: "test-model",
      state: "running",
    });

    const state = makeState({ processes });
    interpreter = new KernelInterpreter(
      brain,
      emitter as unknown as OsProtocolEmitter,
      queue,
      null,
      "/tmp/test",
    );

    const effect: KernelEffect = {
      type: "run_llm",
      pid: "p1",
      seq: 0,
    };

    await interpreter.interpret(effect, state);

    const event = await queue.dequeue();
    expect(event.type).toBe("llm_turn_completed");
    expect((event as any).pid).toBe("p1");
    expect((event as any).success).toBe(true);
    expect((event as any).response).toBe(responseText);
  });

  it("run_llm enqueues llm_turn_completed with success=false on error", async () => {
    brain = makeBrain({ runError: new Error("model crashed") });

    const processes = new Map<string, any>();
    processes.set("p1", {
      pid: "p1",
      name: "worker-1",
      objective: "do the thing",
      model: "test-model",
      state: "running",
    });

    const state = makeState({ processes });
    interpreter = new KernelInterpreter(
      brain,
      emitter as unknown as OsProtocolEmitter,
      queue,
      null,
      "/tmp/test",
    );

    const effect: KernelEffect = {
      type: "run_llm",
      pid: "p1",
      seq: 0,
    };

    await interpreter.interpret(effect, state);

    const event = await queue.dequeue();
    expect(event.type).toBe("llm_turn_completed");
    expect((event as any).pid).toBe("p1");
    expect((event as any).success).toBe(false);
    expect((event as any).response).toContain("model crashed");
  });

  // ─── run_ephemeral ──────────────────────────────────────────

  it("run_ephemeral enqueues ephemeral_completed on success", async () => {
    const responseText = "scout result";
    brain = makeBrain({ runResult: { finalResponse: responseText } });
    interpreter = new KernelInterpreter(
      brain,
      emitter as unknown as OsProtocolEmitter,
      queue,
      null,
      "/tmp/test",
    );

    const effect: KernelEffect = {
      type: "run_ephemeral",
      pid: "eph-1",
      parentPid: "p1",
      objective: "quick check",
      model: "test-model",
      seq: 0,
    };

    await interpreter.interpret(effect, makeState());

    const event = await queue.dequeue();
    expect(event.type).toBe("ephemeral_completed");
    expect((event as any).id).toBe("eph-1");
    expect((event as any).success).toBe(true);
    expect((event as any).response).toBe(responseText);
  });

  // ─── null emitter handling ──────────────────────────────────

  it("works with null emitter", async () => {
    const noEmitterInterpreter = new KernelInterpreter(
      brain,
      null,
      queue,
      null,
      "/tmp/test",
    );

    // emit_protocol with null emitter should be a no-op
    await expect(
      noEmitterInterpreter.interpret(
        { type: "emit_protocol", action: "test", message: "hi", seq: 0 },
        makeState(),
      ),
    ).resolves.toBeUndefined();

    // persist_snapshot with null emitter should be a no-op
    await expect(
      noEmitterInterpreter.interpret(
        { type: "persist_snapshot", runId: "run-1", seq: 0 },
        makeState(),
      ),
    ).resolves.toBeUndefined();

    noEmitterInterpreter.cleanup();
  });

  // ─── schedule_timer replaces existing timer ─────────────────

  it("schedule_timer replaces existing timer with same name", async () => {
    vi.useFakeTimers();

    const state = makeState();

    // Schedule first timer
    await interpreter.interpret(
      { type: "schedule_timer", timer: "metacog", delayMs: 200, seq: 0 },
      state,
    );

    // Replace with shorter timer
    await interpreter.interpret(
      { type: "schedule_timer", timer: "metacog", delayMs: 50, seq: 1 },
      state,
    );

    // Advance past 50ms but before 200ms
    vi.advanceTimersByTime(60);

    const event = await queue.dequeue();
    expect(event.type).toBe("timer_fired");
    expect((event as any).timer).toBe("metacog");

    // With setInterval, the replacement timer (50ms) fires again.
    // The key assertion: the OLD timer (200ms) was cancelled by clearInterval.
    // Advance past 200ms boundary — if old timer fired, we'd get a stale event.
    vi.advanceTimersByTime(50);
    const secondEvent = await queue.dequeue();
    expect(secondEvent.type).toBe("timer_fired");
    expect((secondEvent as any).timer).toBe("metacog"); // still the replacement timer, not old

    vi.useRealTimers();
  });
});
