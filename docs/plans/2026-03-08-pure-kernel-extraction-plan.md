# Pure Kernel Extraction — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the 4700-line `OsKernel` class with a ~30-line event loop, ~300-line I/O interpreter, and expanded pure transition function. Delete `OsKernel`.

**Architecture:** `events → transition(state, event) → [state', effects] → interpret(effect) → events`. All decisions in pure transition. I/O interpreter has zero logic. Coordination flags eliminated — become state fields or vanish.

**Tech Stack:** TypeScript, vitest, fast-check (property-based testing)

**Design doc:** `docs/plans/2026-03-08-pure-kernel-extraction-design.md`

---

## Phase 1: Types

### Task 1: Expand KernelState with new fields

**Files:**
- Modify: `src/os/state-machine/state.ts`
- Test: `test/os/state-machine/state.test.ts`

**Step 1: Write the failing test**

Add to `test/os/state-machine/state.test.ts`:

```typescript
test("KernelState includes metacog coordination fields", () => {
  const state = makeKernelState({ goal: "test" });
  expect(state.metacogInflight).toBe(false);
  expect(state.lastMetacogWakeAt).toBe(0);
  expect(state.metacogHistory).toEqual([]);
  expect(state.drainingPids).toBeInstanceOf(Set);
  expect(state.drainingPids.size).toBe(0);
  expect(state.awarenessNotes).toEqual([]);
  expect(state.oscillationWarnings).toEqual([]);
  expect(state.blindSpots).toEqual([]);
  expect(state.metacogFocus).toBeNull();
  expect(state.killThresholdAdjustment).toBe(0);
  expect(state.killEvalHistory).toEqual([]);
  expect(state.selectedBlueprintInfo).toBeNull();
  expect(state.ephemeralStats).toEqual({ spawns: 0, successes: 0, failures: 0, totalDurationMs: 0 });
  expect(state.heuristicApplicationLog).toEqual([]);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/state.test.ts -v`
Expected: FAIL — properties don't exist on KernelState

**Step 3: Add new fields to KernelState interface and makeKernelState**

In `src/os/state-machine/state.ts`, add to the `KernelState` interface (after the existing fields around line 50):

```typescript
  // Metacog coordination (replaces kernel flags)
  metacogInflight: boolean;
  lastMetacogWakeAt: number;
  metacogHistory: MetacogHistoryEntry[];

  // Awareness state (replaces kernel fields)
  awarenessNotes: string[];
  oscillationWarnings: any[];       // OscillationWarning — keep loose for now
  blindSpots: any[];                // BlindSpotDetection
  metacogFocus: string | null;

  // Drain tracking (replaces drainingPids Set on kernel)
  drainingPids: Set<string>;

  // Kill calibration
  killThresholdAdjustment: number;
  killEvalHistory: any[];           // KillEvalRecord

  // Blueprint tracking
  selectedBlueprintInfo: any | null; // SelectedBlueprintInfo

  // Telemetry for decisions
  ephemeralStats: { spawns: number; successes: number; failures: number; totalDurationMs: number };
  heuristicApplicationLog: any[];   // HeuristicApplicationEntry
```

Add defaults to `makeKernelState()`:

```typescript
  metacogInflight: false,
  lastMetacogWakeAt: 0,
  metacogHistory: [],
  awarenessNotes: [],
  oscillationWarnings: [],
  blindSpots: [],
  metacogFocus: null,
  drainingPids: new Set<string>(),
  killThresholdAdjustment: 0,
  killEvalHistory: [],
  selectedBlueprintInfo: null,
  ephemeralStats: { spawns: 0, successes: 0, failures: 0, totalDurationMs: 0 },
  heuristicApplicationLog: [],
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/state.test.ts -v`
Expected: PASS

**Step 5: Run full state-machine test suite**

Run: `npx vitest run test/os/state-machine/ -v`
Expected: All tests pass (existing tests unaffected — new fields have defaults)

**Step 6: Commit**

```bash
git add src/os/state-machine/state.ts test/os/state-machine/state.test.ts
git commit -m "feat: expand KernelState with metacog, awareness, drain, and telemetry fields"
```

---

### Task 2: Define new event types

**Files:**
- Modify: `src/os/state-machine/events.ts`
- Test: `test/os/state-machine/events.test.ts`

**Step 1: Write the failing test**

Add to `test/os/state-machine/events.test.ts`:

```typescript
import type {
  MetacogResponseReceivedEvent,
  AwarenessResponseReceivedEvent,
  LlmTurnCompletedEvent,
  SubkernelCompletedEvent,
  ShellOutputReceivedEvent,
  IpcFlushedEvent,
} from "../../../src/os/state-machine/events.js";

test("new event types are constructable", () => {
  const metacogEvent: MetacogResponseReceivedEvent = {
    type: "metacog_response_received",
    response: '{"topology": null, "memory": [], "halt": null, "assessment": "ok", "citedHeuristicIds": []}',
    timestamp: Date.now(),
    seq: 1,
  };
  expect(metacogEvent.type).toBe("metacog_response_received");

  const awarenessEvent: AwarenessResponseReceivedEvent = {
    type: "awareness_response_received",
    adjustments: [],
    notes: [],
    flaggedHeuristics: [],
    timestamp: Date.now(),
    seq: 2,
  };
  expect(awarenessEvent.type).toBe("awareness_response_received");

  const llmEvent: LlmTurnCompletedEvent = {
    type: "llm_turn_completed",
    pid: "proc-1",
    success: true,
    response: "done",
    tokensUsed: 100,
    commands: [],
    timestamp: Date.now(),
    seq: 3,
  };
  expect(llmEvent.type).toBe("llm_turn_completed");

  const subkernelEvent: SubkernelCompletedEvent = {
    type: "subkernel_completed",
    pid: "proc-2",
    success: true,
    response: "sub done",
    tokensUsed: 50,
    timestamp: Date.now(),
    seq: 4,
  };
  expect(subkernelEvent.type).toBe("subkernel_completed");

  const shellEvent: ShellOutputReceivedEvent = {
    type: "shell_output_received",
    pid: "proc-3",
    output: "hello",
    exitCode: 0,
    timestamp: Date.now(),
    seq: 5,
  };
  expect(shellEvent.type).toBe("shell_output_received");

  const ipcEvent: IpcFlushedEvent = {
    type: "ipc_flushed",
    wokenPids: ["proc-1"],
    timestamp: Date.now(),
    seq: 6,
  };
  expect(ipcEvent.type).toBe("ipc_flushed");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/events.test.ts -v`
Expected: FAIL — types don't exist

**Step 3: Add new event type interfaces**

In `src/os/state-machine/events.ts`, add after the existing event types (before the KernelEvent union):

```typescript
export interface MetacogResponseReceivedEvent {
  type: "metacog_response_received";
  response: string;   // raw JSON from metacog LLM
  timestamp: number;
  seq: number;
}

export interface AwarenessResponseReceivedEvent {
  type: "awareness_response_received";
  adjustments: any[];  // AwarenessAdjustment[]
  notes: string[];
  flaggedHeuristics: { id: string; reason: string }[];
  timestamp: number;
  seq: number;
}

export interface LlmTurnCompletedEvent {
  type: "llm_turn_completed";
  pid: string;
  success: boolean;
  response: string;
  tokensUsed: number;
  commands: any[];  // OsProcessCommand[]
  usage?: { inputTokens?: number; outputTokens?: number };
  timestamp: number;
  seq: number;
}

export interface SubkernelCompletedEvent {
  type: "subkernel_completed";
  pid: string;
  success: boolean;
  response: string;
  tokensUsed: number;
  timestamp: number;
  seq: number;
}

export interface ShellOutputReceivedEvent {
  type: "shell_output_received";
  pid: string;
  output: string;
  exitCode: number;
  timestamp: number;
  seq: number;
}

export interface IpcFlushedEvent {
  type: "ipc_flushed";
  wokenPids: string[];
  timestamp: number;
  seq: number;
}
```

Add all 6 to the `KernelEvent` union type. Add all 6 to the `KernelEventInput` union (without `timestamp`/`seq`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/events.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/state-machine/events.ts test/os/state-machine/events.test.ts
git commit -m "feat: add new event types for pure kernel — metacog_response, awareness_response, llm_turn_completed, etc."
```

---

### Task 3: Define cleaned-up effect types

**Files:**
- Modify: `src/os/state-machine/effects.ts`
- Test: `test/os/state-machine/effects.test.ts`

**Step 1: Write the failing test**

Add to `test/os/state-machine/effects.test.ts`:

```typescript
import type {
  RunLlmEffect,
  RunMetacogEffect,
  RunAwarenessEffect,
  RunEphemeralEffect,
  RunShellEffect,
  RunSubkernelEffect,
} from "../../../src/os/state-machine/effects.js";

test("new effect types are constructable", () => {
  const runLlm: RunLlmEffect = {
    type: "run_llm",
    pid: "proc-1",
    seq: 1,
  };
  expect(runLlm.type).toBe("run_llm");

  const runMetacog: RunMetacogEffect = {
    type: "run_metacog",
    context: {} as any,
    seq: 2,
  };
  expect(runMetacog.type).toBe("run_metacog");

  const runAwareness: RunAwarenessEffect = {
    type: "run_awareness",
    context: {} as any,
    seq: 3,
  };
  expect(runAwareness.type).toBe("run_awareness");

  const runEphemeral: RunEphemeralEffect = {
    type: "run_ephemeral",
    pid: "eph-1",
    parentPid: "proc-1",
    objective: "check something",
    seq: 4,
  };
  expect(runEphemeral.type).toBe("run_ephemeral");

  const runShell: RunShellEffect = {
    type: "run_shell",
    pid: "shell-1",
    command: "echo",
    args: ["hello"],
    seq: 5,
  };
  expect(runShell.type).toBe("run_shell");

  const runSubkernel: RunSubkernelEffect = {
    type: "run_subkernel",
    pid: "sub-1",
    goal: "refactor module",
    maxTicks: 50,
    seq: 6,
  };
  expect(runSubkernel.type).toBe("run_subkernel");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/effects.test.ts -v`
Expected: FAIL — types don't exist

**Step 3: Add new effect type interfaces**

In `src/os/state-machine/effects.ts`, add:

```typescript
export interface RunLlmEffect {
  type: "run_llm";
  pid: string;
  seq: number;
}

export interface RunMetacogEffect {
  type: "run_metacog";
  context: any;  // MetacogContext — transition builds this from state
  seq: number;
}

export interface RunAwarenessEffect {
  type: "run_awareness";
  context: any;  // AwarenessContext
  seq: number;
}

export interface RunEphemeralEffect {
  type: "run_ephemeral";
  pid: string;
  parentPid: string;
  objective: string;
  model?: string;
  seq: number;
}

export interface RunShellEffect {
  type: "run_shell";
  pid: string;
  command: string;
  args: string[];
  workingDir?: string;
  seq: number;
}

export interface RunSubkernelEffect {
  type: "run_subkernel";
  pid: string;
  goal: string;
  maxTicks?: number;
  seq: number;
}
```

Add all 6 to `KernelEffect` and `KernelEffectInput` unions.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/effects.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/state-machine/effects.ts test/os/state-machine/effects.test.ts
git commit -m "feat: add run_llm, run_metacog, run_awareness, run_ephemeral, run_shell, run_subkernel effect types"
```

---

## Phase 2: Expand Transition

### Task 4: Pure buildMetacogContext in transition

**Files:**
- Create: `src/os/state-machine/metacog-context.ts`
- Test: `test/os/state-machine/metacog-context.test.ts`

**Step 1: Write the failing test**

Create `test/os/state-machine/metacog-context.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { buildMetacogContextPure } from "../../../src/os/state-machine/metacog-context.js";
import { makeKernelState } from "../../../src/os/state-machine/state.js";

describe("buildMetacogContextPure", () => {
  test("produces MetacogContext from KernelState", () => {
    const state = makeKernelState({
      goal: "write fibonacci",
      tickCount: 5,
      lastMetacogTick: 3,
      pendingTriggers: ["boot"],
    });

    const context = buildMetacogContextPure(state);

    expect(context.ticksSinceLastEval).toBe(2);
    expect(context.trigger).toBe("boot");
    expect(context.progressMetrics.tickCount).toBe(5);
    expect(context.ipcActivity).toBeDefined();
    expect(context.dagDelta).toBeDefined();
    expect(context.processEvents).toEqual([]);
  });

  test("returns undefined trigger when no pending triggers", () => {
    const state = makeKernelState({ goal: "test", pendingTriggers: [] });
    const context = buildMetacogContextPure(state);
    expect(context.trigger).toBeUndefined();
  });

  test("includes process table summary in progressMetrics", () => {
    const state = makeKernelState({ goal: "test" });
    // Add a running process
    state.processes.set("p1", {
      pid: "p1", name: "worker", state: "running", type: "lifecycle",
      objective: "do work", priority: 50, spawnedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(), tickCount: 2, tokensUsed: 500,
      model: "test", workingDir: "/tmp", children: [], parentPid: null,
      onParentDeath: "orphan", restartPolicy: "never",
    } as any);

    const context = buildMetacogContextPure(state);
    expect(context.progressMetrics.activeProcessCount).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/metacog-context.test.ts -v`
Expected: FAIL — module doesn't exist

**Step 3: Implement buildMetacogContextPure**

Create `src/os/state-machine/metacog-context.ts`:

This is a pure function that extracts a `MetacogContext` from `KernelState`. Port the logic from `kernel.ts:buildMetacogContext()` (line 3923+) but read everything from state instead of kernel instance fields:

```typescript
import type { KernelState } from "./state.js";
import type { MetacogContext, OsIpcSummary, OsDagDelta, OsProgressMetrics } from "../types.js";

export function buildMetacogContextPure(state: KernelState): MetacogContext {
  const ticksSinceLastEval = state.tickCount - state.lastMetacogTick;

  const trigger = state.pendingTriggers.length > 0
    ? state.pendingTriggers[0]
    : undefined;

  // IPC summary from blackboard state
  const ipcActivity: OsIpcSummary = {
    signalCount: 0,
    blackboardKeyCount: state.blackboard.size,
  };

  // DAG delta — minimal zero-delta (transition doesn't track incremental deltas)
  const dagDelta: OsDagDelta = {
    since: new Date(state.startTime).toISOString(),
    nodesAdded: [],
    nodesRemoved: [],
    edgesAdded: [],
    edgesRemoved: [],
    nodesUpdated: [],
  };

  // Progress metrics from process table
  const allProcesses = [...state.processes.values()];
  const activeProcessCount = allProcesses.filter(p => p.state === "running").length;
  const stalledProcessCount = allProcesses.filter(p => p.state === "sleeping" || p.state === "idle").length;
  const totalTokensUsed = allProcesses.reduce((sum, p) => sum + p.tokensUsed, 0);

  const progressMetrics: OsProgressMetrics = {
    activeProcessCount,
    stalledProcessCount,
    totalTokensUsed,
    tokenBudgetRemaining: state.config.kernel.tokenBudget > 0
      ? state.config.kernel.tokenBudget - totalTokensUsed
      : undefined,
    wallTimeElapsedMs: state.startTime > 0 ? Date.now() - state.startTime : 0,
    tickCount: state.tickCount,
  };

  // Blackboard value summaries for metacog visibility
  const blackboardValueSummaries: Record<string, string> = {};
  for (const [key, entry] of state.blackboard) {
    if (key.startsWith("system:") || key.startsWith("metacog:")) continue;
    const val = typeof entry.value === "string"
      ? entry.value.slice(0, 200)
      : JSON.stringify(entry.value).slice(0, 200);
    blackboardValueSummaries[key] = val;
  }

  return {
    ticksSinceLastEval,
    trigger,
    processEvents: [],  // Events are consumed on read — transition uses state snapshot
    ipcActivity,
    dagDelta,
    progressMetrics,
    relevantHeuristics: state.schedulerHeuristics,
    blackboardValueSummaries,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/metacog-context.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/state-machine/metacog-context.ts test/os/state-machine/metacog-context.test.ts
git commit -m "feat: pure buildMetacogContextPure — reads only from KernelState"
```

---

### Task 5: handleMetacogTimer emits run_metacog effect

**Files:**
- Modify: `src/os/state-machine/transition.ts`
- Test: `test/os/state-machine/transition.test.ts`

**Step 1: Write the failing test**

Add to `test/os/state-machine/transition.test.ts` in the timer_fired describe block:

```typescript
test("metacog timer emits run_metacog effect with context when triggers present", () => {
  const state = makeState();
  const [s1] = transition(state, bootEvent());
  // Boot sets pendingTriggers: ["boot"]

  const [s2, effects] = transition(s1, timerEvent("metacog"));

  const runMetacog = effects.find(e => e.type === "run_metacog");
  expect(runMetacog).toBeDefined();
  expect((runMetacog as any).context).toBeDefined();
  expect((runMetacog as any).context.trigger).toBe("boot");

  // metacogInflight should be set
  expect(s2.metacogInflight).toBe(true);
});

test("metacog timer does not emit run_metacog when metacogInflight", () => {
  const state = makeState();
  const [s1] = transition(state, bootEvent());
  const inflightState = { ...s1, metacogInflight: true };

  const [, effects] = transition(inflightState, timerEvent("metacog"));

  expect(effects.find(e => e.type === "run_metacog")).toBeUndefined();
});

test("metacog timer does not emit run_metacog when no triggers and tickCount is 0", () => {
  const state = makeState();
  const [s1] = transition(state, bootEvent());
  // Clear the boot trigger manually
  const noTriggers = { ...s1, pendingTriggers: [] as any[] };

  const [, effects] = transition(noTriggers, timerEvent("metacog"));

  expect(effects.find(e => e.type === "run_metacog")).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: FAIL — `run_metacog` effect not emitted, `metacogInflight` not set

**Step 3: Modify handleMetacogTimer**

In `src/os/state-machine/transition.ts`, update `handleMetacogTimer()` (around line 1274):

- Add guard: if `state.metacogInflight`, return no effects
- When `shouldRunMetacog`, call `buildMetacogContextPure(state)` and emit `run_metacog` effect instead of `submit_metacog`
- Set `metacogInflight: true` in returned state
- Remove `submit_metacog` emission
- Import `buildMetacogContextPure` from `./metacog-context.js`

```typescript
function handleMetacogTimer(state: KernelState): TransitionResult {
  if (state.halted) return [state, []];
  if (state.metacogInflight) return [state, []];

  const effects: KernelEffectInput[] = [];
  const pendingTriggers = [...state.pendingTriggers];

  // Goal drift safety net
  const ticksSinceMetacog = state.tickCount - state.lastMetacogTick;
  if (ticksSinceMetacog > 5 && state.tickCount > 0) {
    const hasLivingGoalWork = [...state.processes.values()].some(
      p => p.state !== "dead" && p.type !== "daemon"
    );
    if (hasLivingGoalWork && !pendingTriggers.includes("goal_drift")) {
      pendingTriggers.push("goal_drift");
    }
  }

  const cadenceFires = state.tickCount > 0 &&
    state.tickCount % state.config.scheduler.metacogCadence === 0;
  const shouldRunMetacog = pendingTriggers.length > 0 || cadenceFires;

  if (shouldRunMetacog) {
    const context = buildMetacogContextPure({ ...state, pendingTriggers });
    effects.push({
      type: "run_metacog",
      context,
    });
  }

  // Awareness scheduling — emit run_awareness if cadence fires
  if (shouldRunMetacog && state.config.awareness.enabled) {
    const nextMetacogEvalCount = state.metacogEvalCount + 1;
    if (nextMetacogEvalCount > 0 && nextMetacogEvalCount % state.config.awareness.cadence === 0) {
      effects.push({
        type: "run_awareness",
        context: {}, // AwarenessContext — built by transition from state
      });
    }
  }

  return [
    { ...state, pendingTriggers, metacogInflight: shouldRunMetacog },
    assignEffectSeqs(effects),
  ];
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: PASS

**Step 5: Fix any other tests broken by the change**

The test "metacog and watchdog timers are no-ops in transition" will now fail — update it to expect `run_metacog` when triggers are present, and expect empty effects when no triggers.

**Step 6: Commit**

```bash
git add src/os/state-machine/transition.ts src/os/state-machine/metacog-context.ts test/os/state-machine/transition.test.ts
git commit -m "feat: handleMetacogTimer emits run_metacog effect — replaces submit_metacog flag dance"
```

---

### Task 6: handleMetacogResponseReceived

**Files:**
- Modify: `src/os/state-machine/transition.ts`
- Test: `test/os/state-machine/transition.test.ts`

**Step 1: Write the failing tests**

Add a new describe block to `test/os/state-machine/transition.test.ts`:

```typescript
describe("transition — metacog_response_received", () => {
  function metacogResponseEvent(response: object): KernelEvent {
    return {
      type: "metacog_response_received",
      response: JSON.stringify(response),
      timestamp: Date.now(),
      seq: 99,
    } as any;
  }

  test("null topology produces no spawn/kill effects", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const inflight = { ...s1, metacogInflight: true };

    const [s2, effects] = transition(inflight, metacogResponseEvent({
      assessment: "system idle",
      topology: null,
      memory: [],
      halt: null,
      citedHeuristicIds: [],
    }));

    expect(s2.metacogInflight).toBe(false);
    expect(effects.find(e => e.type === "spawn_topology_process")).toBeUndefined();
  });

  test("topology with tasks spawns processes", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const inflight = { ...s1, metacogInflight: true };

    const [s2, effects] = transition(inflight, metacogResponseEvent({
      assessment: "declaring initial topology",
      topology: {
        type: "par",
        children: [
          { type: "task", name: "research", objective: "research the topic" },
          { type: "task", name: "outline", objective: "create outline" },
        ],
      },
      memory: [],
      halt: null,
      citedHeuristicIds: [],
    }));

    expect(s2.metacogInflight).toBe(false);
    const spawns = effects.filter(e => e.type === "spawn_topology_process");
    expect(spawns.length).toBe(2);
  });

  test("halt command sets halted state", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    addProcess(s1, "worker-1", "lifecycle", "running");
    const inflight = { ...s1, metacogInflight: true };

    const [s2] = transition(inflight, metacogResponseEvent({
      assessment: "goal achieved",
      topology: null,
      memory: [],
      halt: { status: "achieved", summary: "done" },
      citedHeuristicIds: [],
    }));

    expect(s2.halted).toBe(true);
    expect(s2.haltReason).toContain("achieved");
  });

  test("invalid JSON response produces no effects and clears inflight", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const inflight = { ...s1, metacogInflight: true };

    const [s2, effects] = transition(inflight, {
      type: "metacog_response_received",
      response: "NOT VALID JSON",
      timestamp: Date.now(),
      seq: 99,
    } as any);

    expect(s2.metacogInflight).toBe(false);
    expect(effects.filter(e => e.type === "spawn_topology_process")).toHaveLength(0);
  });

  test("clears pending triggers after processing", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    // s1 has pendingTriggers: ["boot"]
    const inflight = { ...s1, metacogInflight: true };

    const [s2] = transition(inflight, metacogResponseEvent({
      assessment: "ok",
      topology: null,
      memory: [],
      halt: null,
      citedHeuristicIds: [],
    }));

    expect(s2.pendingTriggers).toEqual([]);
  });

  test("records metacog history entry", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    const inflight = { ...s1, metacogInflight: true };

    const [s2] = transition(inflight, metacogResponseEvent({
      assessment: "initial assessment",
      topology: null,
      memory: [],
      halt: null,
      citedHeuristicIds: [],
    }));

    expect(s2.metacogHistory.length).toBe(1);
    expect(s2.metacogHistory[0].assessment).toBe("initial assessment");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: FAIL — event type not handled in transition switch

**Step 3: Implement handleMetacogResponseReceived**

In `src/os/state-machine/transition.ts`:

1. Add case in the main switch: `case "metacog_response_received": return handleMetacogResponseReceived(state, event);`

2. Implement the handler. This absorbs logic from:
   - `kernel.ts:parseMetacogResponse()` (lines 2400-2519) — format detection, parsing
   - `handleTopologyDeclared()` — validate, optimize, reconcile
   - `handleMetacogEvaluated()` — clear triggers, update counters

```typescript
function handleMetacogResponseReceived(
  state: KernelState,
  event: MetacogResponseReceivedEvent,
): TransitionResult {
  const effects: KernelEffectInput[] = [];

  // Always clear inflight, regardless of parse success
  let newState = { ...state, metacogInflight: false };

  // Parse response
  let parsed: any;
  try {
    parsed = JSON.parse(event.response);
  } catch {
    // Invalid JSON — no-op, clear triggers
    effects.push({
      type: "emit_protocol",
      action: "os_metacog",
      message: "metacog response parse failed",
    });
    return [{ ...newState, pendingTriggers: [], lastMetacogTick: state.tickCount, metacogEvalCount: state.metacogEvalCount + 1 }, assignEffectSeqs(effects)];
  }

  if (!parsed || typeof parsed !== "object") {
    return [{ ...newState, pendingTriggers: [], lastMetacogTick: state.tickCount, metacogEvalCount: state.metacogEvalCount + 1 }, assignEffectSeqs(effects)];
  }

  const topology = parsed.topology ?? null;
  const memory = Array.isArray(parsed.memory) ? parsed.memory : [];
  const halt = parsed.halt ?? null;
  const assessment = parsed.assessment ?? "";

  // Record in metacog history
  const metacogHistory = [...state.metacogHistory, {
    tick: state.tickCount,
    assessment,
    commands: [],  // synthetic — topology algebra doesn't use commands
    trigger: state.pendingTriggers[0],
  }];
  // Cap at awareness history window
  const maxHistory = state.config.awareness?.historyWindow ?? 50;
  if (metacogHistory.length > maxHistory) {
    metacogHistory.splice(0, metacogHistory.length - maxHistory);
  }

  // Emit protocol for observability
  effects.push({
    type: "emit_protocol",
    action: "os_metacog",
    message: `assessment=${assessment.slice(0, 100)} topology=${topology !== null ? "declared" : "null"} memory=${memory.length} halt=${halt?.status ?? "none"}`,
  });

  // Handle memory commands via persist_memory effects
  for (const cmd of memory) {
    effects.push({
      type: "persist_memory",
      data: cmd,
    });
  }

  // Handle halt
  if (halt) {
    return haltWith(
      { ...newState, pendingTriggers: [], metacogHistory, lastMetacogTick: state.tickCount, metacogEvalCount: state.metacogEvalCount + 1 },
      halt.status === "achieved" ? "goal_achieved" : halt.status,
      effects,
    );
  }

  // Handle topology (reuse existing handleTopologyDeclared logic)
  if (topology !== null) {
    // Validate, optimize, reconcile — same as handleTopologyDeclared
    const topoResult = reconcileTopologyPure(newState, topology, effects);
    newState = topoResult.state;
    effects.push(...topoResult.effects);
  }

  return [
    { ...newState, pendingTriggers: [], metacogHistory, lastMetacogTick: state.tickCount, metacogEvalCount: state.metacogEvalCount + 1 },
    assignEffectSeqs(effects),
  ];
}
```

Note: Extract the topology reconciliation logic from the existing `handleTopologyDeclared` into a reusable `reconcileTopologyPure()` helper so both the new handler and the old one (kept for backward compat during migration) can use it.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/state-machine/transition.ts test/os/state-machine/transition.test.ts
git commit -m "feat: handleMetacogResponseReceived — absorbs parseMetacogResponse + topology reconciliation"
```

---

### Task 7: handleAwarenessResponseReceived

**Files:**
- Modify: `src/os/state-machine/transition.ts`
- Test: `test/os/state-machine/transition.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("transition — awareness_response_received", () => {
  function awarenessResponseEvent(notes: string[], adjustments: any[] = []): KernelEvent {
    return {
      type: "awareness_response_received",
      adjustments,
      notes,
      flaggedHeuristics: [],
      timestamp: Date.now(),
      seq: 99,
    } as any;
  }

  test("stores awareness notes in state", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const [s2] = transition(s1, awarenessResponseEvent(["watch for scope creep"]));

    expect(s2.awarenessNotes).toEqual(["watch for scope creep"]);
  });

  test("applies kill threshold adjustment", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const [s2] = transition(s1, awarenessResponseEvent([], [
      { type: "adjust_kill_threshold", delta: 0.1 },
    ]));

    expect(s2.killThresholdAdjustment).toBeCloseTo(0.1);
  });

  test("stores flagged heuristics as blind spots", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());

    const [s2] = transition(s1, {
      type: "awareness_response_received",
      adjustments: [],
      notes: [],
      flaggedHeuristics: [{ id: "h1", reason: "never applied" }],
      timestamp: Date.now(),
      seq: 99,
    } as any);

    expect(s2.blindSpots.length).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: FAIL

**Step 3: Implement handleAwarenessResponseReceived**

Add to transition.ts. Absorbs `kernel.ts:applyAwarenessAdjustment()`. Stores notes, adjustments, and flagged heuristics in state fields.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/state-machine/transition.ts test/os/state-machine/transition.test.ts
git commit -m "feat: handleAwarenessResponseReceived — awareness state managed purely in transition"
```

---

### Task 8: Enhanced llm_turn_completed handler

**Files:**
- Modify: `src/os/state-machine/transition.ts`
- Test: `test/os/state-machine/transition.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("transition — llm_turn_completed", () => {
  function llmCompletedEvent(pid: string, commands: any[] = [], success = true): KernelEvent {
    return {
      type: "llm_turn_completed",
      pid,
      success,
      response: "done",
      tokensUsed: 100,
      commands,
      timestamp: Date.now(),
      seq: 99,
    } as any;
  }

  test("processes commands like process_completed (bb_write)", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    addProcess(s1, "worker-1", "lifecycle", "running");

    const [s2] = transition(s1, llmCompletedEvent("worker-1-pid-goes-here", [
      { kind: "bb_write", key: "result", value: "hello" },
    ]));

    // Blackboard should have the written value
    const entry = s2.blackboard.get("result");
    expect(entry).toBeDefined();
  });

  test("drain check — kills process if pid in drainingPids", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    addProcess(s1, "worker-1", "lifecycle", "running");
    const pid = [...s1.processes.keys()].find(k => s1.processes.get(k)!.name === "worker-1")!;
    s1.drainingPids.add(pid);

    const [s2, effects] = transition(s1, llmCompletedEvent(pid, [{ kind: "idle" }]));

    const proc = s2.processes.get(pid);
    expect(proc?.state).toBe("dead");
    expect(s2.drainingPids.has(pid)).toBe(false);
  });

  test("increments tickCount", () => {
    const state = makeState();
    const [s1] = transition(state, bootEvent());
    addProcess(s1, "worker-1", "lifecycle", "running");
    const pid = [...s1.processes.keys()].find(k => s1.processes.get(k)!.name === "worker-1")!;

    const [s2] = transition(s1, llmCompletedEvent(pid, [{ kind: "idle" }]));

    expect(s2.tickCount).toBe(s1.tickCount + 1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: FAIL

**Step 3: Implement llm_turn_completed handler**

This reuses the existing `handleProcessCompleted` logic (all 15 command kinds are already extracted). The new handler:

1. Delegates command processing to the same internal helpers
2. Adds drain check: if `pid in state.drainingPids`, kill the process after processing commands
3. Increments `tickCount`
4. Removes pid from `inflight`
5. Absorbs `detectSelectedBlueprint` logic (check blackboard for `selected_blueprint` key)

The key insight: `llm_turn_completed` is essentially `process_completed` + drain check + tick increment. Reuse the command processing internals.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/state-machine/transition.ts test/os/state-machine/transition.test.ts
git commit -m "feat: llm_turn_completed handler — drain check, tick increment, blueprint detection"
```

---

### Task 9: Remove handleBoot submit_metacog — boot uses pendingTriggers only

**Files:**
- Modify: `src/os/state-machine/transition.ts`
- Test: `test/os/state-machine/transition.test.ts`

**Step 1: Write the failing test**

```typescript
test("boot does not emit submit_metacog effect (timer handles it via triggers)", () => {
  const state = makeState();
  const [s1, effects] = transition(state, bootEvent());

  expect(effects.find(e => e.type === "submit_metacog")).toBeUndefined();
  // Boot sets pendingTriggers: ["boot"] — metacog timer will pick it up
  expect(s1.pendingTriggers).toContain("boot");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: FAIL — boot still emits submit_metacog

**Step 3: Remove submit_metacog from handleBoot**

In `handleBoot()`, remove the `effects.push({ type: "submit_metacog", ... })` block. The `pendingTriggers: ["boot"]` (already added in our earlier fix) is sufficient — the metacog timer will see the trigger and emit `run_metacog`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/state-machine/transition.test.ts -v`
Expected: PASS

**Step 5: Fix any broken tests that expected submit_metacog from boot**

**Step 6: Commit**

```bash
git add src/os/state-machine/transition.ts test/os/state-machine/transition.test.ts
git commit -m "refactor: boot no longer emits submit_metacog — uses pendingTriggers boot trigger"
```

---

## Phase 3: Build KernelInterpreter + runKernel()

### Task 10: Event queue

**Files:**
- Create: `src/os/event-queue.ts`
- Test: `test/os/event-queue.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "vitest";
import { EventQueue } from "../../../src/os/event-queue.js";

describe("EventQueue", () => {
  test("enqueue and dequeue", async () => {
    const queue = new EventQueue();
    const event = { type: "boot", goal: "test", timestamp: Date.now(), seq: 0 } as any;

    queue.enqueue(event);
    const dequeued = await queue.dequeue();

    expect(dequeued).toEqual(event);
  });

  test("dequeue blocks until event is available", async () => {
    const queue = new EventQueue();
    const event = { type: "boot", goal: "test", timestamp: Date.now(), seq: 0 } as any;

    // Dequeue starts waiting
    const promise = queue.dequeue();

    // Enqueue after a short delay
    setTimeout(() => queue.enqueue(event), 10);

    const dequeued = await promise;
    expect(dequeued).toEqual(event);
  });

  test("FIFO ordering", async () => {
    const queue = new EventQueue();
    queue.enqueue({ type: "a", timestamp: 1, seq: 0 } as any);
    queue.enqueue({ type: "b", timestamp: 2, seq: 1 } as any);

    const first = await queue.dequeue();
    const second = await queue.dequeue();

    expect((first as any).type).toBe("a");
    expect((second as any).type).toBe("b");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/event-queue.test.ts -v`
Expected: FAIL

**Step 3: Implement EventQueue**

Create `src/os/event-queue.ts`:

```typescript
import type { KernelEvent } from "./state-machine/events.js";

export class EventQueue {
  private queue: KernelEvent[] = [];
  private waiters: Array<(event: KernelEvent) => void> = [];

  enqueue(event: KernelEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.queue.push(event);
    }
  }

  dequeue(): Promise<KernelEvent> {
    const event = this.queue.shift();
    if (event) {
      return Promise.resolve(event);
    }
    return new Promise<KernelEvent>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/event-queue.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/event-queue.ts test/os/event-queue.test.ts
git commit -m "feat: EventQueue — async FIFO queue for kernel event loop"
```

---

### Task 11: KernelInterpreter

**Files:**
- Create: `src/os/kernel-interpreter.ts`
- Test: `test/os/kernel-interpreter.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, test, expect, vi } from "vitest";
import { KernelInterpreter } from "../../../src/os/kernel-interpreter.js";

describe("KernelInterpreter", () => {
  function makeMockBrain() {
    return {
      startThread: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ finalResponse: '{"topology": null, "memory": [], "halt": null, "assessment": "ok", "citedHeuristicIds": []}' }),
      }),
    } as any;
  }

  function makeMockEmitter() {
    return {
      emit: vi.fn(),
      saveSnapshot: vi.fn(),
      writeLiveState: vi.fn(),
    } as any;
  }

  function makeMockQueue() {
    return {
      enqueue: vi.fn(),
    } as any;
  }

  test("emit_protocol calls emitter.emit", async () => {
    const emitter = makeMockEmitter();
    const interpreter = new KernelInterpreter(makeMockBrain(), emitter, makeMockQueue());

    await interpreter.interpret({ type: "emit_protocol", action: "os_boot", message: "test", seq: 0 } as any, {} as any);

    expect(emitter.emit).toHaveBeenCalled();
  });

  test("schedule_timer enqueues timer_fired event after delay", async () => {
    const queue = makeMockQueue();
    const interpreter = new KernelInterpreter(makeMockBrain(), makeMockEmitter(), queue);

    await interpreter.interpret({ type: "schedule_timer", timer: "metacog", delayMs: 10, seq: 0 } as any, {} as any);

    // Wait for timer to fire
    await new Promise(r => setTimeout(r, 50));

    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: "timer_fired", timer: "metacog" })
    );
  });

  test("cancel_timer prevents timer_fired event", async () => {
    const queue = makeMockQueue();
    const interpreter = new KernelInterpreter(makeMockBrain(), makeMockEmitter(), queue);

    await interpreter.interpret({ type: "schedule_timer", timer: "metacog", delayMs: 100, seq: 0 } as any, {} as any);
    await interpreter.interpret({ type: "cancel_timer", timer: "metacog", seq: 1 } as any, {} as any);

    await new Promise(r => setTimeout(r, 150));

    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  test("halt calls cleanup", async () => {
    const interpreter = new KernelInterpreter(makeMockBrain(), makeMockEmitter(), makeMockQueue());

    // Should not throw
    await interpreter.interpret({ type: "halt", reason: "test", seq: 0 } as any, {} as any);
  });

  test("persist_snapshot calls emitter.saveSnapshot", async () => {
    const emitter = makeMockEmitter();
    const interpreter = new KernelInterpreter(makeMockBrain(), emitter, makeMockQueue());

    await interpreter.interpret({ type: "persist_snapshot", runId: "run-1", seq: 0 } as any, {} as any);

    expect(emitter.saveSnapshot).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/kernel-interpreter.test.ts -v`
Expected: FAIL

**Step 3: Implement KernelInterpreter**

Create `src/os/kernel-interpreter.ts`:

```typescript
import type { Brain, BrainThread } from "../types.js";
import type { KernelEffect } from "./state-machine/effects.js";
import type { KernelEvent } from "./state-machine/events.js";
import type { KernelState } from "./state-machine/state.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";
import type { EventQueue } from "./event-queue.js";
import { OsMetacognitiveAgent } from "./metacog-agent.js";

export class KernelInterpreter {
  private readonly brain: Brain;
  private readonly emitter: OsProtocolEmitter | null;
  private readonly queue: EventQueue;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly threads = new Map<string, BrainThread>();
  private metacog: OsMetacognitiveAgent | null = null;

  constructor(brain: Brain, emitter: OsProtocolEmitter | null, queue: EventQueue) {
    this.brain = brain;
    this.emitter = emitter;
    this.queue = queue;
  }

  async interpret(effect: KernelEffect, state: KernelState): Promise<void> {
    switch (effect.type) {
      case "emit_protocol":
        this.emitter?.emit({
          action: (effect as any).action,
          status: (effect as any).status ?? "completed",
          message: (effect as any).message ?? "",
        });
        break;

      case "schedule_timer": {
        const e = effect as any;
        const existing = this.timers.get(e.timer);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.queue.enqueue({
            type: "timer_fired",
            timer: e.timer,
            timestamp: Date.now(),
            seq: 0,  // seq assigned by caller
          } as KernelEvent);
          this.timers.delete(e.timer);
        }, e.delayMs);
        (timer as NodeJS.Timeout).unref?.();
        this.timers.set(e.timer, timer);
        break;
      }

      case "cancel_timer": {
        const e = effect as any;
        const timer = this.timers.get(e.timer);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(e.timer);
        }
        break;
      }

      case "run_llm": {
        const e = effect as any;
        const proc = state.processes.get(e.pid);
        if (!proc) break;
        this.startLlmCall(e.pid, proc, state);
        break;
      }

      case "run_metacog": {
        const e = effect as any;
        this.startMetacogCall(e.context, state);
        break;
      }

      case "run_awareness": {
        const e = effect as any;
        this.startAwarenessCall(e.context, state);
        break;
      }

      case "run_ephemeral": {
        const e = effect as any;
        this.startEphemeralCall(e.pid, e.objective, state);
        break;
      }

      case "run_shell": {
        const e = effect as any;
        this.startShellProcess(e.pid, e.command, e.args, e.workingDir);
        break;
      }

      case "run_subkernel": {
        const e = effect as any;
        this.startSubkernel(e.pid, e.goal, e.maxTicks, state);
        break;
      }

      case "persist_snapshot":
        if (this.emitter) {
          // Build snapshot from state and save
          this.emitter.saveSnapshot(this.buildSnapshot(state));
        }
        break;

      case "persist_memory":
        // Delegate to memory store — TODO wire memoryStore
        break;

      case "halt":
        this.cleanup();
        break;

      default:
        // Unknown effect — no-op
        break;
    }
  }

  cleanup(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const thread of this.threads.values()) thread.abort?.();
    this.threads.clear();
  }

  // --- Private I/O methods ---

  private startLlmCall(pid: string, proc: any, state: KernelState): void {
    // Get or create thread for this process
    let thread = this.threads.get(pid);
    if (!thread) {
      thread = this.brain.startThread({ model: proc.model });
      this.threads.set(pid, thread);
    }
    // Fire-and-forget — enqueue completion event when done
    void thread.run(proc.objective).then(
      (result) => {
        this.queue.enqueue({
          type: "llm_turn_completed",
          pid,
          success: true,
          response: result.finalResponse,
          tokensUsed: result.usage?.outputTokens ?? 0,
          commands: this.parseCommands(result.finalResponse),
          timestamp: Date.now(),
          seq: 0,
        } as KernelEvent);
      },
      (err) => {
        this.queue.enqueue({
          type: "llm_turn_completed",
          pid,
          success: false,
          response: err instanceof Error ? err.message : String(err),
          tokensUsed: 0,
          commands: [],
          timestamp: Date.now(),
          seq: 0,
        } as KernelEvent);
      },
    );
  }

  private startMetacogCall(context: any, state: KernelState): void {
    if (!this.metacog) {
      this.metacog = new OsMetacognitiveAgent(
        state.config.kernel.metacogModel,
        state.goal,
        this.brain,
        "/tmp",
      );
    }
    void this.metacog.evaluate(context).then(
      (response) => {
        this.queue.enqueue({
          type: "metacog_response_received",
          response,
          timestamp: Date.now(),
          seq: 0,
        } as KernelEvent);
      },
      () => {
        // Metacog failed — enqueue empty response so inflight clears
        this.queue.enqueue({
          type: "metacog_response_received",
          response: '{"assessment":"metacog error","topology":null,"memory":[],"halt":null,"citedHeuristicIds":[]}',
          timestamp: Date.now(),
          seq: 0,
        } as KernelEvent);
      },
    );
  }

  private startAwarenessCall(_context: any, _state: KernelState): void {
    // TODO: wire awareness daemon LLM call
    // For now, enqueue empty response
    this.queue.enqueue({
      type: "awareness_response_received",
      adjustments: [],
      notes: [],
      flaggedHeuristics: [],
      timestamp: Date.now(),
      seq: 0,
    } as KernelEvent);
  }

  private startEphemeralCall(pid: string, objective: string, state: KernelState): void {
    // TODO: wire ephemeral LLM call
    // Similar to startLlmCall but with ephemeral thread
  }

  private startShellProcess(pid: string, command: string, args: string[], workingDir?: string): void {
    // TODO: wire shell process execution
  }

  private startSubkernel(pid: string, goal: string, maxTicks: number | undefined, state: KernelState): void {
    // TODO: wire sub-kernel execution
  }

  private parseCommands(response: string): any[] {
    try {
      const parsed = JSON.parse(response);
      return Array.isArray(parsed?.commands) ? parsed.commands : [];
    } catch {
      return [];
    }
  }

  private buildSnapshot(state: KernelState): any {
    return {
      runId: state.runId,
      tickCount: state.tickCount,
      goal: state.goal,
      processes: [...state.processes.values()],
      blackboard: Object.fromEntries(
        [...state.blackboard.entries()].map(([k, v]) => [k, v.value])
      ),
      progressMetrics: {
        activeProcessCount: [...state.processes.values()].filter(p => p.state === "running").length,
        stalledProcessCount: [...state.processes.values()].filter(p => p.state === "idle" || p.state === "sleeping").length,
        totalTokensUsed: [...state.processes.values()].reduce((s, p) => s + p.tokensUsed, 0),
        wallTimeElapsedMs: Date.now() - state.startTime,
        tickCount: state.tickCount,
      },
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/kernel-interpreter.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/kernel-interpreter.ts test/os/kernel-interpreter.test.ts
git commit -m "feat: KernelInterpreter — thin I/O shell, ~300 lines, zero decisions"
```

---

### Task 12: runKernel entry point

**Files:**
- Create: `src/os/run-kernel.ts`
- Test: `test/os/run-kernel.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, vi } from "vitest";
import { runKernel } from "../../../src/os/run-kernel.js";

describe("runKernel", () => {
  test("runs event loop until halt", async () => {
    const mockBrain = {
      startThread: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({
          finalResponse: JSON.stringify({
            assessment: "goal achieved",
            topology: null,
            memory: [],
            halt: { status: "achieved", summary: "done" },
            citedHeuristicIds: [],
          }),
        }),
      }),
    } as any;

    const config = {
      enabled: true,
      kernel: {
        tickIntervalMs: 100,
        maxConcurrentProcesses: 3,
        metacogCadence: 3,
        metacogModel: "test-model",
        processModel: "test-model",
        tokenBudget: 100000,
        processTokenBudgetEnabled: false,
        wallTimeLimitMs: 30000,
        telemetryEnabled: false,
        tickSignalCadences: [1, 5, 10],
        watchdogIntervalMs: 60000,
        housekeepIntervalMs: 500,
        metacogIntervalMs: 60000,
        snapshotIntervalMs: 10000,
        goalCompleteGracePeriodMs: 5000,
      },
      scheduler: {
        strategy: "priority" as const,
        maxConcurrentProcesses: 3,
        tickIntervalMs: 100,
        metacogCadence: 3,
        metacogTriggers: [],
      },
      ipc: { blackboardMaxKeys: 100 },
      memory: {
        snapshotCadence: 10,
        heuristicDecayRate: 0.05,
        heuristicPruneThreshold: 0.1,
        maxHeuristics: 100,
        consolidationIntervalTicks: 100,
        basePath: "/tmp/test-memory",
      },
      processes: { maxDepth: 5, maxTotalProcesses: 50, defaultPriority: 50 },
      ephemeral: { enabled: false, maxPerProcess: 3, maxConcurrent: 3, defaultModel: "test" },
      systemProcess: { enabled: false, maxSystemProcesses: 5, stdoutBufferLines: 100 },
      childKernel: { enabled: false, maxChildKernels: 3, defaultMaxTicks: 50, ticksPerParentTurn: 5, maxDepth: 1 },
      awareness: { enabled: false, cadence: 2, historyWindow: 50, model: "test" },
      observation: { enabled: false },
    } as any;

    const state = await runKernel("say hello", config, mockBrain, null);

    expect(state.halted).toBe(true);
    expect(state.goal).toBe("say hello");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/os/run-kernel.test.ts -v`
Expected: FAIL

**Step 3: Implement runKernel**

Create `src/os/run-kernel.ts`:

```typescript
import type { Brain } from "../types.js";
import type { OsConfig } from "./types.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";
import type { KernelState } from "./state-machine/state.js";
import { makeKernelState } from "./state-machine/state.js";
import { transition } from "./state-machine/transition.js";
import { createEventSequencer } from "./state-machine/events.js";
import { EventQueue } from "./event-queue.js";
import { KernelInterpreter } from "./kernel-interpreter.js";
import { randomUUID } from "node:crypto";

export async function runKernel(
  goal: string,
  config: OsConfig,
  brain: Brain,
  emitter: OsProtocolEmitter | null,
): Promise<KernelState> {
  const queue = new EventQueue();
  const interpreter = new KernelInterpreter(brain, emitter, queue);
  const nextSeq = createEventSequencer();

  let state = makeKernelState({
    goal: "",
    runId: randomUUID(),
    config,
  });

  // Seed boot event
  queue.enqueue({
    type: "boot",
    goal,
    workingDir: process.cwd(),
    hasNewEpisodicData: false,
    awarenessEnabled: config.awareness?.enabled ?? false,
    awarenessModel: config.awareness?.model,
    timestamp: Date.now(),
    seq: nextSeq(),
  } as any);

  // Schedule initial metacog timer
  interpreter.interpret({
    type: "schedule_timer",
    timer: "metacog",
    delayMs: 5000,
    seq: 0,
  } as any, state);

  // Schedule housekeep timer
  interpreter.interpret({
    type: "schedule_timer",
    timer: "housekeep",
    delayMs: config.kernel.housekeepIntervalMs ?? 500,
    seq: 0,
  } as any, state);

  // Event loop
  while (!state.halted) {
    const event = await queue.dequeue();
    // Assign seq if not set
    if (!event.seq) (event as any).seq = nextSeq();

    const [newState, effects] = transition(state, event);
    state = newState;

    for (const effect of effects) {
      await interpreter.interpret(effect, state);
    }

    // Write live state for Lens after each transition
    emitter?.writeLiveState(buildSnapshot(state));
  }

  interpreter.cleanup();
  return state;
}

function buildSnapshot(state: KernelState): any {
  return {
    runId: state.runId,
    tickCount: state.tickCount,
    goal: state.goal,
    processes: [...state.processes.values()],
    blackboard: Object.fromEntries(
      [...state.blackboard.entries()].map(([k, v]) => [k, v.value])
    ),
    progressMetrics: {
      activeProcessCount: [...state.processes.values()].filter(p => p.state === "running").length,
      stalledProcessCount: [...state.processes.values()].filter(p => p.state === "idle" || p.state === "sleeping").length,
      totalTokensUsed: [...state.processes.values()].reduce((s, p) => s + p.tokensUsed, 0),
      wallTimeElapsedMs: Date.now() - state.startTime,
      tickCount: state.tickCount,
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/os/run-kernel.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/os/run-kernel.ts test/os/run-kernel.test.ts
git commit -m "feat: runKernel() — the pure kernel entry point, ~60 lines"
```

---

## Phase 4: Wire Entry Point + End-to-End Test

### Task 13: Wire entry.ts to use runKernel

**Files:**
- Modify: `src/os/entry.ts`
- Test: manual end-to-end test

**Step 1: Read current entry.ts**

Read `src/os/entry.ts` to understand the current `runOsMode()` function signature and how it creates the kernel.

**Step 2: Replace OsKernel instantiation with runKernel call**

In `runOsMode()`, replace:
```typescript
const kernel = new OsKernel(osConfig, client, cwd, emitter, browserMcpConfig);
const snapshot = await kernel.run(input.goal);
```

With:
```typescript
import { runKernel } from "./run-kernel.js";
const state = await runKernel(input.goal, osConfig, client, emitter);
const snapshot = buildSnapshotFromState(state);
```

Keep the emitter setup, config loading, and snapshot return unchanged. The `OsKernel` import can be removed.

**Step 3: Build and type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 5: Manual end-to-end test**

```bash
# Build
npm run build

# Start serve with lens
node dist/cli.js serve --lens --provider claude &

# Kick off a test run
curl -s http://127.0.0.1:3100/runs -X POST -H "Content-Type: application/json" \
  -d '{"goal": "Create a simple Python script that prints hello world", "provider": "claude"}'

# Monitor via lens
# Open localhost:5173/?ws=ws://127.0.0.1:3200
```

Verify:
- Boot event fires (no goal-orchestrator)
- Metacog fires within ~5s
- Metacog declares initial topology
- Workers spawn from topology
- Workers complete and produce results
- Lens shows all events
- Kernel halts when goal is achieved

**Step 6: Commit**

```bash
git add src/os/entry.ts
git commit -m "feat: wire runKernel() as entry point — OsKernel no longer used"
```

---

### Task 14: Property-based invariant tests for pure kernel

**Files:**
- Modify: `test/os/state-machine/invariants.test.ts`

**Step 1: Add new invariant tests**

```typescript
describe("Pure kernel invariants", () => {
  test("INVARIANT: metacog_response_received always clears metacogInflight", () => {
    fc.assert(fc.property(
      arbKernelState(),
      arbMetacogResponse(),
      (state, response) => {
        const inflightState = { ...state, metacogInflight: true };
        const [newState] = transition(inflightState, {
          type: "metacog_response_received",
          response: JSON.stringify(response),
          timestamp: Date.now(),
          seq: 0,
        } as any);
        return newState.metacogInflight === false;
      }
    ));
  });

  test("INVARIANT: run_metacog never emitted when metacogInflight", () => {
    fc.assert(fc.property(
      arbKernelState(),
      (state) => {
        const inflightState = { ...state, metacogInflight: true };
        const [, effects] = transition(inflightState, {
          type: "timer_fired",
          timer: "metacog",
          timestamp: Date.now(),
          seq: 0,
        } as any);
        return !effects.some(e => e.type === "run_metacog");
      }
    ));
  });

  test("INVARIANT: drain_process pid is killed on llm_turn_completed", () => {
    // For any state with a draining pid, completing that pid's turn kills it
    fc.assert(fc.property(
      arbKernelState(),
      (state) => {
        // Add a draining process
        const pid = "drain-test-pid";
        const processes = new Map(state.processes);
        processes.set(pid, {
          pid, name: "drain-target", state: "running", type: "lifecycle",
          objective: "test", priority: 50, spawnedAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(), tickCount: 1, tokensUsed: 100,
          model: "test", workingDir: "/tmp", children: [], parentPid: null,
          onParentDeath: "orphan", restartPolicy: "never",
        } as any);
        const drainingPids = new Set([pid]);
        const testState = { ...state, processes, drainingPids };

        const [newState] = transition(testState, {
          type: "llm_turn_completed",
          pid,
          success: true,
          response: "done",
          tokensUsed: 0,
          commands: [{ kind: "idle" }],
          timestamp: Date.now(),
          seq: 0,
        } as any);

        const proc = newState.processes.get(pid);
        return proc?.state === "dead" && !newState.drainingPids.has(pid);
      }
    ));
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run test/os/state-machine/invariants.test.ts -v`
Expected: PASS

**Step 3: Commit**

```bash
git add test/os/state-machine/invariants.test.ts
git commit -m "test: property-based invariants for pure kernel — metacog exclusion, drain safety"
```

---

## Phase 5: Delete OsKernel

### Task 15: Remove OsKernel class

**Files:**
- Delete or gut: `src/os/kernel.ts`
- Modify: any files that import from `kernel.ts`

**Step 1: Search for all imports of OsKernel**

Run: `rg "OsKernel|from.*kernel\.js" src/ --files-with-matches`

**Step 2: Update or remove each import**

- `src/os/entry.ts` — already updated in Task 13 to use `runKernel()`
- Any test files importing OsKernel — update to use `runKernel()` or `transition()` directly
- Remove the `OsKernel` export from barrel files if any

**Step 3: Delete the OsKernel class from kernel.ts**

Keep only:
- Any pure helper functions that are still referenced
- Type re-exports if needed

Or delete `kernel.ts` entirely if nothing references it.

**Step 4: Build and type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete OsKernel class — pure kernel is the only path"
```

---

### Task 16: Final end-to-end verification

**Step 1: Build**

Run: `npm run build`
Expected: Clean build

**Step 2: Start server with lens**

```bash
node dist/cli.js serve --lens --provider claude &
```

**Step 3: Kick off test run**

```bash
curl -s http://127.0.0.1:3100/runs -X POST -H "Content-Type: application/json" \
  -d '{"goal": "Create a Python script that generates the first 20 Fibonacci numbers and writes them to fibonacci.txt, then verify the file exists", "provider": "claude"}'
```

**Step 4: Monitor via Lens UI**

Open `localhost:5173/?ws=ws://127.0.0.1:3200`

Verify complete lifecycle:
1. Boot fires (metacog-daemon + awareness-daemon spawned, no goal-orchestrator)
2. Metacog timer fires at ~5s
3. Metacog declares initial topology (par/seq of tasks)
4. Workers spawn from topology reconciliation
5. Workers execute LLM turns, produce blackboard writes
6. Metacog re-evaluates, adjusts topology if needed
7. Workers complete, metacog sees all done
8. Metacog declares halt with "achieved"
9. Kernel halts cleanly
10. Lens shows full event timeline

**Step 5: Run full test suite one final time**

Run: `npx vitest run`
Expected: All tests pass

**Step 6: Commit final state**

```bash
git add -A
git commit -m "chore: pure kernel extraction complete — verified end-to-end"
```
