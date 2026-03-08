import { describe, expect, test } from "vitest";
import type { KernelEffect, KernelEffectInput } from "../../../src/os/state-machine/effects.js";

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
      { type: "spawn_topology_process", name: "worker-1", objective: "do stuff", model: "gpt-4", priority: 1, seq: 20 },
      { type: "kill_process", pid: "p", name: "worker-1", seq: 21 },
      { type: "drain_process", pid: "p", name: "worker-1", seq: 22 },
      { type: "run_llm", pid: "p1", seq: 23 },
      { type: "run_metacog", context: { tick: 1 }, seq: 24 },
      { type: "run_awareness", context: { snapshot: {} }, seq: 25 },
      { type: "run_ephemeral", pid: "e1", parentPid: "p1", objective: "scout", model: "gpt-4", seq: 26 },
      { type: "run_shell", pid: "s1", command: "ls", args: ["-la"], workingDir: "/tmp", seq: 27 },
      { type: "run_subkernel", pid: "sk1", goal: "sub-goal", maxTicks: 10, seq: 28 },
    ];
    expect(effects).toHaveLength(29);
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

  test("type discrimination works for run_* effect types", () => {
    const effects: KernelEffect[] = [
      { type: "run_llm", pid: "p1", seq: 0 },
      { type: "run_metacog", context: { tick: 5, processCount: 3 }, seq: 1 },
      { type: "run_awareness", context: { snapshot: { processes: [] } }, seq: 2 },
      { type: "run_ephemeral", pid: "e1", parentPid: "p1", objective: "scout ahead", model: "gpt-4", seq: 3 },
      { type: "run_shell", pid: "s1", command: "npm", args: ["test"], workingDir: "/app", seq: 4 },
      { type: "run_subkernel", pid: "sk1", goal: "research topic", maxTicks: 20, seq: 5 },
    ];

    for (const e of effects) {
      if (e.type === "run_llm") {
        expect(e.pid).toBe("p1");
      }
      if (e.type === "run_metacog") {
        expect(e.context.tick).toBe(5);
        expect(e.context.processCount).toBe(3);
      }
      if (e.type === "run_awareness") {
        expect(e.context.snapshot).toBeDefined();
      }
      if (e.type === "run_ephemeral") {
        expect(e.pid).toBe("e1");
        expect(e.parentPid).toBe("p1");
        expect(e.objective).toBe("scout ahead");
        expect(e.model).toBe("gpt-4");
      }
      if (e.type === "run_shell") {
        expect(e.pid).toBe("s1");
        expect(e.command).toBe("npm");
        expect(e.args).toEqual(["test"]);
        expect(e.workingDir).toBe("/app");
      }
      if (e.type === "run_subkernel") {
        expect(e.pid).toBe("sk1");
        expect(e.goal).toBe("research topic");
        expect(e.maxTicks).toBe(20);
      }
    }
  });

  test("run_* effects work with optional fields omitted", () => {
    const effects: KernelEffect[] = [
      { type: "run_ephemeral", pid: "e1", parentPid: "p1", objective: "scout", seq: 0 },
      { type: "run_shell", pid: "s1", command: "echo", args: ["hi"], seq: 1 },
      { type: "run_subkernel", pid: "sk1", goal: "sub-goal", seq: 2 },
    ];

    expect(effects).toHaveLength(3);

    if (effects[0].type === "run_ephemeral") {
      expect(effects[0].model).toBeUndefined();
    }
    if (effects[1].type === "run_shell") {
      expect(effects[1].workingDir).toBeUndefined();
    }
    if (effects[2].type === "run_subkernel") {
      expect(effects[2].maxTicks).toBeUndefined();
    }
  });

  test("KernelEffectInput omits seq for run_* types", () => {
    const inputs: KernelEffectInput[] = [
      { type: "run_llm", pid: "p1" },
      { type: "run_metacog", context: { tick: 1 } },
      { type: "run_awareness", context: {} },
      { type: "run_ephemeral", pid: "e1", parentPid: "p1", objective: "scout" },
      { type: "run_shell", pid: "s1", command: "ls", args: ["-la"] },
      { type: "run_subkernel", pid: "sk1", goal: "sub-goal" },
    ];
    expect(inputs).toHaveLength(6);
    // Verify none have a seq property
    for (const input of inputs) {
      expect("seq" in input).toBe(false);
    }
  });
});
