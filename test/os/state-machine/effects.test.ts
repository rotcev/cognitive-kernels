import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KernelEffect } from "../../../src/os/state-machine/effects.js";

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
