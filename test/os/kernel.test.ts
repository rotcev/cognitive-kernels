import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { OsKernel } from "../../src/os/kernel.js";
import { parseOsConfig } from "../../src/os/config.js";
import type { Brain, BrainThread, TurnResult } from "../../src/types.js";

class MockThread implements BrainThread {
  readonly id = "mock-thread";

  abort(): void {}

  async run(_input: string): Promise<TurnResult> {
    return { finalResponse: "Acknowledged." };
  }
}

class MockBrain implements Brain {
  startThread(): BrainThread {
    return new MockThread();
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `cognitive-kernel-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTestConfig() {
  return parseOsConfig({
    enabled: true,
    kernel: {
      tickIntervalMs: 10,
      metacogCadence: 3,
      wallTimeLimitMs: 5000,
    },
    memory: {
      basePath: tmpDir,
    },
  });
}

describe("OsKernel executive exit prevention", () => {
  test("root lifecycle process with pending deferrals and no children wakes on tick as well as child completion", async () => {
    const kernel = new OsKernel(makeTestConfig(), new MockBrain(), tmpDir);
    kernel.boot("Test exit prevention with deferrals");

    // Manually add a root lifecycle process since boot no longer creates goal-orchestrator
    const testPid = "os-proc-test-root";
    (kernel as any).table.addDirect({
      pid: testPid,
      type: "lifecycle",
      state: "running",
      name: "test-root",
      parentPid: null,
      objective: "Test exit prevention with deferrals",
      priority: 90,
      spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tickCount: 1, // Already past first tick to bypass hard-spawn enforcement
      tokensUsed: 0,
      model: makeTestConfig().kernel.processModel,
      workingDir: "/tmp",
      children: [],
      onParentDeath: "orphan",
      restartPolicy: "never",
    });

    const orchestrator = kernel.snapshot().processes.find((process) => process.name === "test-root");
    expect(orchestrator).toBeDefined();

    // Register a deferral via metacog command
    await (kernel as any).executeMetacogCommand({
      kind: "defer",
      descriptor: {
        type: "lifecycle",
        name: "deferred-worker",
        objective: "wait for readiness",
        priority: 70,
      },
      condition: { type: "blackboard_key_exists", key: "gate:ready" },
      reason: "Test deferral",
    });

    expect((kernel as any).deferrals.size).toBe(1);

    // Route through processOneResult (which delegates to transition function)
    await (kernel as any).processOneResult({
      pid: orchestrator!.pid,
      success: true,
      commands: [{ kind: "exit", code: 0, reason: "done" }],
      tokensUsed: 100,
      response: "Exiting.",
    });

    const orchAfter = kernel.snapshot().processes.find((process) => process.pid === orchestrator!.pid);
    expect(orchAfter?.state).toBe("idle");
    expect(orchAfter?.wakeOnSignals).toEqual(["tick:1", "child:done"]);
  });
});
