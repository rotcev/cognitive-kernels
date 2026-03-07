/**
 * Narrative generator tests.
 *
 * Uses a mock generate function (no real LLM calls).
 */

import { describe, expect, test, vi } from "vitest";
import { NarrativeGenerator } from "../../src/lens/narrative.js";
import type { LensSnapshot, LensSnapshotDelta } from "../../src/lens/types.js";

function makeSnapshot(tick: number, overrides?: Partial<LensSnapshot>): LensSnapshot {
  return {
    runId: "test-run",
    tick,
    goal: "Build a web scraper",
    elapsed: tick * 5000,
    processes: [
      {
        pid: "p1",
        name: "goal-orchestrator",
        type: "lifecycle",
        state: "running",
        role: "kernel",
        parentPid: null,
        children: ["p2"],
        objective: "coordinate web scraper build",
        priority: 90,
        tickCount: tick,
        tokensUsed: tick * 1000,
        tokenBudget: null,
        model: "test",
        spawnedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        backendKind: undefined,
        selfReports: [],
        blackboardIO: [],
      },
      {
        pid: "p2",
        name: "scraper-worker",
        type: "lifecycle",
        state: tick > 2 ? "dead" : "running",
        role: "worker",
        parentPid: "p1",
        children: [],
        objective: "implement scraping logic",
        priority: 70,
        tickCount: tick,
        tokensUsed: tick * 500,
        tokenBudget: null,
        model: "test",
        spawnedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        exitCode: tick > 2 ? 0 : undefined,
        exitReason: tick > 2 ? "completed" : undefined,
        backendKind: undefined,
        selfReports: [],
        blackboardIO: [],
      },
    ],
    dag: { nodes: [], edges: [] },
    blackboard: tick > 1 ? { "scraper-result": { key: "scraper-result", value: "done", writer: "scraper-worker", readBy: [] } } : {},
    heuristics: [],
    deferrals: [],
    metrics: {
      totalTokens: tick * 1500,
      tokenRate: 100,
      processCount: 2,
      runningCount: tick > 2 ? 1 : 2,
      sleepingCount: 0,
      deadCount: tick > 2 ? 1 : 0,
      checkpointedCount: 0,
      suspendedCount: 0,
      dagDepth: 1,
      dagEdgeCount: 0,
      wallTimeElapsedMs: tick * 5000,
      tickCount: tick,
    },
    ...overrides,
  };
}

describe("NarrativeGenerator", () => {
  test("generates narrative from snapshot", async () => {
    const generate = vi.fn(async () => "The system is building a web scraper.");
    const narrator = new NarrativeGenerator({ generate, throttleMs: 0 });

    const result = await narrator.fromSnapshot(makeSnapshot(1));

    expect(result).not.toBeNull();
    expect(result!.text).toBe("The system is building a web scraper.");
    expect(result!.runId).toBe("test-run");
    expect(generate).toHaveBeenCalledOnce();

    // Verify the prompt contains useful context
    const prompt = generate.mock.calls[0][0];
    expect(prompt).toContain("Build a web scraper");
    expect(prompt).toContain("goal-orchestrator");
    expect(prompt).toContain("scraper-worker");
  });

  test("generates narrative from delta", async () => {
    const generate = vi.fn(async () => "A new worker just started.");
    const narrator = new NarrativeGenerator({ generate, throttleMs: 0 });

    // Need to generate from snapshot first (tick 0)
    await narrator.fromSnapshot(makeSnapshot(0));

    const delta: LensSnapshotDelta = {
      tick: 1,
      timestamp: new Date().toISOString(),
      processes: {
        added: [{
          pid: "p3",
          name: "parser-worker",
          type: "lifecycle" as const,
          state: "running" as const,
          role: "worker" as const,
          parentPid: "p1",
          children: [],
          objective: "parse HTML content",
          priority: 70,
          tickCount: 0,
          tokensUsed: 0,
          tokenBudget: null,
          model: "test",
          spawnedAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          backendKind: undefined,
          selfReports: [],
          blackboardIO: [],
        }],
        removed: [],
        changed: [],
      },
    };

    const result = await narrator.fromDelta(makeSnapshot(1), delta);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("A new worker just started.");

    // Verify delta prompt mentions the new process
    const prompt = generate.mock.calls[1][0];
    expect(prompt).toContain("parser-worker");
    expect(prompt).toContain("parse HTML content");
  });

  test("throttles generation", async () => {
    const generate = vi.fn(async () => "Status update.");
    const narrator = new NarrativeGenerator({ generate, throttleMs: 10000 });

    const r1 = await narrator.fromSnapshot(makeSnapshot(1));
    expect(r1).not.toBeNull();

    // Same tick — should be throttled
    const r2 = await narrator.fromSnapshot(makeSnapshot(1));
    expect(r2).toBeNull();

    // Different tick but within throttle window
    const r3 = await narrator.fromSnapshot(makeSnapshot(2));
    expect(r3).toBeNull();

    expect(generate).toHaveBeenCalledOnce();
  });

  test("skips duplicate ticks", async () => {
    const generate = vi.fn(async () => "Update.");
    const narrator = new NarrativeGenerator({ generate, throttleMs: 0 });

    await narrator.fromSnapshot(makeSnapshot(1));
    const r2 = await narrator.fromSnapshot(makeSnapshot(1));
    expect(r2).toBeNull();
    expect(generate).toHaveBeenCalledOnce();
  });

  test("handles generate failure gracefully", async () => {
    const generate = vi.fn(async () => { throw new Error("API down"); });
    const narrator = new NarrativeGenerator({ generate, throttleMs: 0 });

    const result = await narrator.fromSnapshot(makeSnapshot(1));
    expect(result).toBeNull(); // No crash, returns null
  });

  test("prevents concurrent generation", async () => {
    let resolveGenerate: ((v: string) => void) | null = null;
    const generate = vi.fn(() => new Promise<string>((resolve) => { resolveGenerate = resolve; }));
    const narrator = new NarrativeGenerator({ generate, throttleMs: 0 });

    // Start first generation (will hang)
    const p1 = narrator.fromSnapshot(makeSnapshot(1));

    // Try second while first is pending — should be skipped
    const r2 = await narrator.fromSnapshot(makeSnapshot(2));
    expect(r2).toBeNull();

    // Resolve first
    resolveGenerate!("Done.");
    const r1 = await p1;
    expect(r1).not.toBeNull();
    expect(generate).toHaveBeenCalledOnce();
  });

  test("prompt includes blackboard keys", async () => {
    const generate = vi.fn(async () => "Status.");
    const narrator = new NarrativeGenerator({ generate, throttleMs: 0 });

    await narrator.fromSnapshot(makeSnapshot(2)); // tick 2 has blackboard data

    const prompt = generate.mock.calls[0][0];
    expect(prompt).toContain("scraper-result");
  });

  test("prompt includes completed processes", async () => {
    const generate = vi.fn(async () => "Status.");
    const narrator = new NarrativeGenerator({ generate, throttleMs: 0 });

    await narrator.fromSnapshot(makeSnapshot(3)); // tick 3 has dead process

    const prompt = generate.mock.calls[0][0];
    expect(prompt).toContain("Completed");
    expect(prompt).toContain("scraper-worker");
  });
});
