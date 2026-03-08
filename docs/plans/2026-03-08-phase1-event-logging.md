# Phase 1: Event Logging — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define the `KernelEvent` type system and instrument all kernel entry points to record a complete, typed event log — with zero behavior changes.

**Architecture:** Add a `KernelEvent` discriminated union type in a new `src/os/state-machine/events.ts` module. Add an `eventLog: KernelEvent[]` array to `OsKernel`. At each entry point that drives kernel state transitions, push a typed event before executing existing logic. Expose the log via `kernel.getEventLog()` for tests and Lens.

**Tech Stack:** TypeScript, vitest, existing kernel test infrastructure (MockBrain, bootKernel, priv helper)

---

### Task 1: Create the KernelEvent type

**Files:**
- Create: `src/os/state-machine/events.ts`

**Step 1: Write the failing test**

Create `test/os/state-machine/events.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import type { KernelEvent } from "../../../src/os/state-machine/events.js";

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
      timestamp: Date.now(),
      seq: 1,
    };
    expect(event.type).toBe("process_completed");
    expect(event.pid).toBe("proc-1");
  });

  test("all event types are constructable", () => {
    const ts = Date.now();
    const events: KernelEvent[] = [
      { type: "boot", goal: "g", timestamp: ts, seq: 0 },
      { type: "process_completed", pid: "p", name: "n", success: true, commandCount: 0, tokensUsed: 0, timestamp: ts, seq: 1 },
      { type: "process_submitted", pid: "p", name: "n", model: "m", timestamp: ts, seq: 2 },
      { type: "ephemeral_completed", id: "e", name: "n", success: true, timestamp: ts, seq: 3 },
      { type: "timer_fired", timer: "housekeep", timestamp: ts, seq: 4 },
      { type: "metacog_evaluated", commandCount: 0, triggerCount: 0, timestamp: ts, seq: 5 },
      { type: "awareness_evaluated", hasAdjustment: false, timestamp: ts, seq: 6 },
      { type: "shell_output", pid: "p", hasStdout: true, hasStderr: false, exitCode: 0, timestamp: ts, seq: 7 },
      { type: "external_command", command: "halt", timestamp: ts, seq: 8 },
      { type: "halt_check", result: true, reason: "goal_work_complete", timestamp: ts, seq: 9 },
    ];
    expect(events).toHaveLength(10);
    // Verify seq is monotonically increasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: FAIL — module `../../../src/os/state-machine/events.js` not found

**Step 3: Write minimal implementation**

Create `src/os/state-machine/events.ts`:

```typescript
/**
 * KernelEvent — the complete set of events that drive kernel state transitions.
 *
 * Every event has:
 * - `type`: discriminant tag
 * - `timestamp`: epoch ms when the event occurred
 * - `seq`: monotonically increasing sequence number (total ordering)
 *
 * Events are the INPUT side of the state machine:
 *   transition(state, event) → (state', effects)
 *
 * Design principle: events carry enough context to be self-describing
 * in a log, but NOT the full payload (e.g., we log `commandCount` not
 * the entire command array). Full payloads live in the state.
 */

/** Base fields present on every event. */
type BaseEvent = {
  timestamp: number;
  seq: number;
};

/** Kernel booted with a goal. */
export type BootEvent = BaseEvent & {
  type: "boot";
  goal: string;
};

/** An LLM process completed a turn. */
export type ProcessCompletedEvent = BaseEvent & {
  type: "process_completed";
  pid: string;
  name: string;
  success: boolean;
  commandCount: number;
  tokensUsed: number;
};

/** A process was submitted to the LLM executor. */
export type ProcessSubmittedEvent = BaseEvent & {
  type: "process_submitted";
  pid: string;
  name: string;
  model: string;
};

/** An ephemeral (fire-and-forget scout) completed. */
export type EphemeralCompletedEvent = BaseEvent & {
  type: "ephemeral_completed";
  id: string;
  name: string;
  success: boolean;
};

/** A wall-clock timer fired. */
export type TimerFiredEvent = BaseEvent & {
  type: "timer_fired";
  timer: "housekeep" | "metacog" | "watchdog" | "snapshot";
};

/** Metacog evaluation completed. */
export type MetacogEvaluatedEvent = BaseEvent & {
  type: "metacog_evaluated";
  commandCount: number;
  triggerCount: number;
};

/** Awareness daemon evaluation completed. */
export type AwarenessEvaluatedEvent = BaseEvent & {
  type: "awareness_evaluated";
  hasAdjustment: boolean;
};

/** Shell process produced output or exited. */
export type ShellOutputEvent = BaseEvent & {
  type: "shell_output";
  pid: string;
  hasStdout: boolean;
  hasStderr: boolean;
  exitCode?: number;
};

/** External command received (halt, pause, resume). */
export type ExternalCommandEvent = BaseEvent & {
  type: "external_command";
  command: "halt" | "pause" | "resume";
};

/** shouldHalt() was evaluated. */
export type HaltCheckEvent = BaseEvent & {
  type: "halt_check";
  result: boolean;
  reason: string | null;
};

/** The discriminated union of all kernel events. */
export type KernelEvent =
  | BootEvent
  | ProcessCompletedEvent
  | ProcessSubmittedEvent
  | EphemeralCompletedEvent
  | TimerFiredEvent
  | MetacogEvaluatedEvent
  | AwarenessEvaluatedEvent
  | ShellOutputEvent
  | ExternalCommandEvent
  | HaltCheckEvent
  ;

/** Helper to create a sequencer function for event logging. */
export function createEventSequencer(): () => number {
  let seq = 0;
  return () => seq++;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/os/state-machine/events.ts test/os/state-machine/events.test.ts
git commit -m "feat(state-machine): define KernelEvent type algebra"
```

---

### Task 2: Add event log to the kernel class

**Files:**
- Modify: `src/os/kernel.ts` (add eventLog field, nextSeq, getEventLog method, logEvent helper)

**Step 1: Write the failing test**

Add to `test/os/state-machine/events.test.ts`:

```typescript
import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";
import { OsKernel } from "../../../src/os/kernel.js";
import { parseOsConfig } from "../../../src/os/config.js";
import type { Brain, BrainThread, TurnResult } from "../../../src/types.js";

// ─── Mock Brain (same as event-driven-kernel tests) ──────────────────────

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

// ─── Kernel integration ──────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `ck-sm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: FAIL — `kernel.getEventLog is not a function`

**Step 3: Write minimal implementation**

In `src/os/kernel.ts`:

1. Add import at top:
```typescript
import type { KernelEvent } from "./state-machine/events.js";
import { createEventSequencer } from "./state-machine/events.js";
```

2. Add fields to `OsKernel` class (near other private fields):
```typescript
  private readonly eventLog: KernelEvent[] = [];
  private readonly nextSeq = createEventSequencer();
```

3. Add helper method:
```typescript
  /** Record a kernel event. */
  private logEvent(event: Omit<KernelEvent, "timestamp" | "seq">): void {
    this.eventLog.push({
      ...event,
      timestamp: Date.now(),
      seq: this.nextSeq(),
    } as KernelEvent);
  }
```

4. Add public accessor:
```typescript
  /** Get the event log (for testing and Lens). */
  getEventLog(): readonly KernelEvent[] {
    return this.eventLog;
  }
```

5. Add boot event logging in `boot()` method, right after `this.goal = goal;`:
```typescript
    this.logEvent({ type: "boot", goal });
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: PASS (5 tests)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All 183+ tests pass (additive change only)

**Step 6: Commit**

```bash
git add src/os/kernel.ts test/os/state-machine/events.test.ts
git commit -m "feat(state-machine): add event log to kernel with boot event"
```

---

### Task 3: Instrument process submission events

**Files:**
- Modify: `src/os/kernel.ts` — `submitProcess()` method (~line 1804)

**Step 1: Write the failing test**

Add to `test/os/state-machine/events.test.ts`:

```typescript
  test("submitting a process records process_submitted event", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    // goal-orchestrator was booted — trigger a scheduling pass to submit it
    const k = kernel as any;
    k.doSchedulingPass();

    const log = kernel.getEventLog();
    const submitted = log.filter((e: any) => e.type === "process_submitted");
    expect(submitted.length).toBeGreaterThanOrEqual(1);
    const first = submitted[0] as any;
    expect(first.pid).toBeTruthy();
    expect(first.name).toBeTruthy();
    expect(first.seq).toBeGreaterThan(0);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: FAIL — `submitted.length` is 0 (no process_submitted events logged yet)

**Step 3: Write minimal implementation**

In `src/os/kernel.ts`, in `submitProcess()` method (~line 1804), add at the top of the method body (after the proc parameter):

```typescript
    this.logEvent({
      type: "process_submitted",
      pid: proc.pid,
      name: proc.name,
      model: proc.model ?? this.config.kernel.processModel,
    });
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/kernel.ts
git commit -m "feat(state-machine): log process_submitted events"
```

---

### Task 4: Instrument process completion events

**Files:**
- Modify: `src/os/kernel.ts` — `onProcessComplete()` method (~line 1856)

**Step 1: Write the failing test**

Add to `test/os/state-machine/events.test.ts`:

```typescript
  test("process completion records process_completed event", async () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000, maxConcurrentProcesses: 10 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    // Neutralize scheduling to avoid infinite loop
    k.doSchedulingPass = () => {};

    // Simulate a process completion
    const proc = k.table.getAll().find((p: any) => p.name === "goal-orchestrator");
    expect(proc).toBeTruthy();

    await k.onProcessComplete({
      pid: proc.pid,
      success: true,
      response: "test",
      tokensUsed: 500,
      commands: [{ kind: "idle", wakeOnSignals: ["tick:1"] }],
    });

    const log = kernel.getEventLog();
    const completed = log.filter((e: any) => e.type === "process_completed");
    expect(completed.length).toBe(1);
    const evt = completed[0] as any;
    expect(evt.pid).toBe(proc.pid);
    expect(evt.name).toBe("goal-orchestrator");
    expect(evt.success).toBe(true);
    expect(evt.tokensUsed).toBe(500);
    expect(evt.commandCount).toBe(1);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: FAIL — `completed.length` is 0

**Step 3: Write minimal implementation**

In `src/os/kernel.ts`, in `onProcessComplete()` method, right after `if (this.halted) return;` and before `const release = await this.mutex.acquire();`:

```typescript
    const completedProc = this.table.get(result.pid);
    this.logEvent({
      type: "process_completed",
      pid: result.pid,
      name: completedProc?.name ?? "unknown",
      success: result.success,
      commandCount: result.commands.length,
      tokensUsed: result.tokensUsed,
    });
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/kernel.ts
git commit -m "feat(state-machine): log process_completed events"
```

---

### Task 5: Instrument timer events

**Files:**
- Modify: `src/os/kernel.ts` — `safeHousekeep()`, `doMetacogCheck()`, snapshot timer, watchdog

**Step 1: Write the failing test**

Add to `test/os/state-machine/events.test.ts`:

```typescript
  test("housekeep records timer_fired event", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    k.safeHousekeep();

    const log = kernel.getEventLog();
    const timerEvents = log.filter((e: any) => e.type === "timer_fired" && e.timer === "housekeep");
    expect(timerEvents.length).toBeGreaterThanOrEqual(1);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: FAIL — `timerEvents.length` is 0

**Step 3: Write minimal implementation**

In `src/os/kernel.ts`:

1. In `safeHousekeep()` (~line 477), add at the top before `if (this.halted) return;`:
```typescript
    this.logEvent({ type: "timer_fired", timer: "housekeep" });
```

2. In `doMetacogCheck()` (~line 515), add at the top:
```typescript
    this.logEvent({ type: "timer_fired", timer: "metacog" });
```

3. In the snapshot timer callback (search for `safeSnapshotWrite` or `snapshotTimer`), add:
```typescript
    this.logEvent({ type: "timer_fired", timer: "snapshot" });
```

4. In the watchdog callback (search for `detectTickStall` or `watchdogTimer`), add:
```typescript
    this.logEvent({ type: "timer_fired", timer: "watchdog" });
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All 183+ tests pass

**Step 6: Commit**

```bash
git add src/os/kernel.ts
git commit -m "feat(state-machine): log timer_fired events for all timers"
```

---

### Task 6: Instrument ephemeral completion and halt check events

**Files:**
- Modify: `src/os/kernel.ts` — `runOneEphemeral()` (~line 2379) and `shouldHalt()` (~line 4409)

**Step 1: Write the failing test**

Add to `test/os/state-machine/events.test.ts`:

```typescript
  test("shouldHalt records halt_check event", () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    // Clear the event log so we only see halt_check events
    k.eventLog.length = 0;

    kernel.shouldHalt();

    const log = kernel.getEventLog();
    const haltChecks = log.filter((e: any) => e.type === "halt_check");
    expect(haltChecks.length).toBe(1);
    expect(haltChecks[0].result).toBe(false); // kernel just booted, shouldn't halt
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: FAIL — `haltChecks.length` is 0

**Step 3: Write minimal implementation**

1. In `shouldHalt()` (~line 4409), capture the result and log before returning. Replace the method to log at the end:

At the very start of `shouldHalt()`, save a reference to log at end. The simplest approach: wrap the return value.

Add a local variable at the start of `shouldHalt()`:
```typescript
    const logHalt = (result: boolean) => {
      this.logEvent({ type: "halt_check", result, reason: result ? this.haltReason : null });
      return result;
    };
```

Then replace each `return true;` with `return logHalt(true);` and the final `return false;` with `return logHalt(false);`.

Note: There are ~6 return points in shouldHalt(). Only instrument the final two (the `goal_work_complete` path and the final `return false`) plus the early `return true` paths. The simplest approach is to refactor to use a single return:

```typescript
  shouldHalt(): boolean {
    if (this.halted) {
      return true; // already halted, no need to log
    }

    let result = false;
    // ... existing logic, but assign to result instead of returning ...

    this.logEvent({ type: "halt_check", result, reason: result ? this.haltReason : null });
    return result;
  }
```

This is a bigger refactor of shouldHalt(). The safer approach for Phase 1 is to just log at each return point. Pick the approach that minimizes risk — logging at each return point is more lines but doesn't change control flow.

2. In `runOneEphemeral()` (~line 2379), add at the end (in the finally/completion block after the ephemeral result is processed):

```typescript
    this.logEvent({
      type: "ephemeral_completed",
      id: desc.ephemeralId,
      name: desc.name,
      success: true, // or false if caught an error
    });
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All 183+ tests pass

**Step 6: Commit**

```bash
git add src/os/kernel.ts
git commit -m "feat(state-machine): log ephemeral_completed and halt_check events"
```

---

### Task 7: Instrument metacog and awareness evaluation events

**Files:**
- Modify: `src/os/kernel.ts` — `doMetacogCheck()` method (~line 515)

**Step 1: Write the failing test**

Add to `test/os/state-machine/events.test.ts`:

```typescript
  test("metacog evaluation records metacog_evaluated event", async () => {
    const config = parseOsConfig({ enabled: true, memory: { basePath: tmpDir }, awareness: { enabled: false }, kernel: { telemetryEnabled: false, watchdogIntervalMs: 600000 } });
    const kernel = new OsKernel(config, new MockBrain(), tmpDir);
    kernel.boot("Test goal");

    const k = kernel as any;
    // Neutralize scheduling
    k.doSchedulingPass = () => {};

    await k.doMetacogCheck();

    const log = kernel.getEventLog();
    const metacogEvents = log.filter((e: any) => e.type === "metacog_evaluated");
    expect(metacogEvents.length).toBe(1);
    expect(typeof metacogEvents[0].commandCount).toBe("number");
    expect(typeof metacogEvents[0].triggerCount).toBe("number");
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: FAIL — `metacogEvents.length` is 0

**Step 3: Write minimal implementation**

In `doMetacogCheck()`, after the metacog evaluation completes and commands are parsed/executed, add:

```typescript
    this.logEvent({
      type: "metacog_evaluated",
      commandCount: commands.length, // the parsed metacog commands
      triggerCount: this.pendingTriggers.length,
    });
```

If awareness daemon runs in the same method, add after its evaluation:

```typescript
    this.logEvent({
      type: "awareness_evaluated",
      hasAdjustment: adjustment !== undefined && adjustment !== null,
    });
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/kernel.ts
git commit -m "feat(state-machine): log metacog_evaluated and awareness_evaluated events"
```

---

### Task 8: Verify full event log coverage with integration test

**Files:**
- Modify: `test/os/state-machine/events.test.ts`

**Step 1: Write the integration test**

```typescript
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

    // Must have at least one timer_fired (housekeep runs on boot)
    const timerEvents = log.filter((e: any) => e.type === "timer_fired");
    expect(timerEvents.length).toBeGreaterThanOrEqual(1);

    // Log the event type distribution for debugging
    const typeCounts: Record<string, number> = {};
    for (const e of log) {
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    }
    console.log("Event type distribution:", typeCounts);
  });
});
```

**Step 2: Run test**

Run: `npx vitest run test/os/state-machine/events.test.ts`
Expected: PASS — all tests green, console shows event type distribution

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All 183+ tests pass (zero regressions)

**Step 4: Commit**

```bash
git add test/os/state-machine/events.test.ts
git commit -m "test(state-machine): integration test for complete event log coverage"
```

---

### Task 9: Build and verify

**Step 1: Build**

Run: `npm run build`
Expected: Clean build, no errors

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (183 existing + ~10 new)

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore(state-machine): phase 1 complete — event logging"
```

---

## Summary

After Phase 1, the kernel has:
- `KernelEvent` discriminated union with 10 event types
- `eventLog: KernelEvent[]` with monotonic sequencing on every kernel instance
- Every entry point instrumented: boot, process submission, process completion, all 4 timers, ephemeral completion, metacog evaluation, awareness evaluation, halt checks
- Integration test verifying complete event sequence
- Zero behavior changes — all additive

This directly enables:
- **Phase 2**: Effect capture (events show what triggered each effect)
- **Phase 5**: Replay (feed recorded events through transition function)
- **Lens**: Event log as a richer data source than protocol events
