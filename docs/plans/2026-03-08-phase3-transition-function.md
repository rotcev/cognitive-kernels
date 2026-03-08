# Phase 3: Extract Transition Function — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the kernel's pure decision logic into `transition(state, event) → [state, effects]` — the deterministic core that enables replay, verification, and algebraic optimization.

**Architecture:** Define `KernelState` as a plain data snapshot of the kernel's deterministic state (no promises, timers, or I/O handles). Create `transition()` that handles events by producing new state + effect descriptors. The kernel class becomes a thin bridge: extract state → call transition → apply state → interpret effects. Start with `shouldHalt` (simplest), then `process_completed` (most complex), then `timer_fired` (housekeeping).

**Tech Stack:** TypeScript, vitest, existing kernel test infrastructure

---

### Task 1: Define KernelState type

**Files:**
- Create: `src/os/state-machine/state.ts`
- Create: `test/os/state-machine/state.test.ts`

Define the plain-data state type that captures everything the transition function needs to make decisions. This is NOT the full kernel — it excludes runtime handles (timers, promises, mutex, executor, emitter).

```typescript
import type { OsProcess, OsDagTopology, OsConfig } from "../types.js";

/** Plain-data blackboard entry. */
export type BlackboardEntry = {
  value: unknown;
  writtenBy: string | null;
  version: number;
};

/** A deferred spawn waiting for a condition. */
export type DeferEntry = {
  id: string;
  descriptorName: string;
  condition: DeferCondition;
  registeredByPid: string;
  registeredAtTick: number;
  maxWaitTicks: number;
  maxWaitMs: number;
  registeredAt: number; // wall-clock
};

export type DeferCondition =
  | { type: "blackboard_key_exists"; key: string }
  | { type: "process_dead_by_name"; name: string }
  | { type: "all_of"; conditions: DeferCondition[] }
  ;

/** The deterministic kernel state — everything needed to compute the next transition. */
export type KernelState = {
  // Identity
  goal: string;
  runId: string;
  config: OsConfig;

  // Process table (plain data — no methods)
  processes: Map<string, OsProcess>;
  inflight: Set<string>;
  activeEphemeralCount: number;

  // IPC / Blackboard
  blackboard: Map<string, BlackboardEntry>;

  // Scheduling
  tickCount: number;

  // DAG topology
  dagTopology: OsDagTopology;

  // Deferrals
  deferrals: Map<string, DeferEntry>;

  // Halt logic
  halted: boolean;
  haltReason: string | null;
  goalWorkDoneAt: number;
  startTime: number;
  consecutiveIdleTicks: number;
  lastProcessCompletionTime: number;
  housekeepCount: number;
};

/** Create initial state for a boot event. */
export function initialState(config: OsConfig, runId: string): KernelState;
```

Tests: verify `initialState()` produces valid defaults, type construction works.

### Task 2: Create transition function skeleton with boot handler

**Files:**
- Create: `src/os/state-machine/transition.ts`
- Create: `test/os/state-machine/transition.test.ts`

Create the transition function shell. Handle `boot` event — produce initial processes (goal-orchestrator, metacog-daemon) and return effects (emit_protocol for spawn, schedule_timer for boot timers).

```typescript
import type { KernelState } from "./state.js";
import type { KernelEvent } from "./events.js";
import type { KernelEffect } from "./effects.js";

export type TransitionResult = [KernelState, KernelEffect[]];

export function transition(state: KernelState, event: KernelEvent): TransitionResult {
  switch (event.type) {
    case "boot": return handleBoot(state, event);
    default: return [state, []]; // unhandled events are no-ops for now
  }
}
```

The `handleBoot` function:
1. Set `state.goal`
2. Create goal-orchestrator process entry in `state.processes`
3. Create metacog-daemon process entry
4. Return effects: `emit_protocol` (spawn events), `submit_llm` (schedule orchestrator)

Tests: boot produces 2 processes, correct effects, state.goal is set.

### Task 3: Extract shouldHalt as halt_check handler

**Files:**
- Modify: `src/os/state-machine/transition.ts`
- Modify: `test/os/state-machine/transition.test.ts`

Add `halt_check` event handler. This is the pure version of `kernel.shouldHalt()`. Logic:

1. If already halted → return `[state, []]`
2. Check wall-clock limit exceeded → return `[{...state, halted: true, haltReason: "wall_time_exceeded"}, [halt effect]]`
3. Check token budget exceeded → halt
4. Never halt if `inflight.size > 0 || activeEphemeralCount > 0` → no-op
5. Check all processes dead → halt with `"all_processes_dead"`
6. Check deferrals exist → don't halt
7. Grace period: if only daemons remain:
   - Set `goalWorkDoneAt` if not set
   - If grace period expired → halt with `"goal_work_complete"`
   - Otherwise → no-op
8. Default → no-op

Tests:
- Token budget exceeded → halts
- Inflight work → never halts
- Only daemons with grace period → halts after expiry
- Grace period reset when lifecycle processes reappear

### Task 4: Extract process completion handler

**Files:**
- Modify: `src/os/state-machine/transition.ts`
- Modify: `test/os/state-machine/transition.test.ts`

Add `process_completed` event handler. This is the pure version of `processOneResult()`. Core logic:

1. Find process by pid in state
2. Update `tickCount`, `tokensUsed`, `lastActiveAt`
3. Check per-process token budget
4. If failed: mark process dead, emit kill effect
5. Execute commands (spawn_child → add process to state + submit_llm effect, bb_write → update blackboard, idle → update process state, etc.)
6. Return updated state + effects

NOTE: This is the most complex handler. Start with a subset of commands:
- `idle` — update process state to idle
- `exit` — mark process dead
- `spawn_child` — add child process to state, return submit_llm effect
- `bb_write` — update blackboard

Other commands (spawn_graph, spawn_ephemeral, spawn_system, spawn_kernel, checkpoint) can be added later — they'll still work through the kernel's existing path via the strangler pattern.

Tests:
- Process completion updates token count
- Failed process gets killed
- `idle` command transitions process state
- `spawn_child` adds child to state
- `bb_write` updates blackboard

### Task 5: Wire kernel to use transition for halt_check

**Files:**
- Modify: `src/os/kernel.ts`

Replace `shouldHalt()` internals with:
1. Extract current `KernelState` snapshot from kernel fields
2. Call `transition(state, { type: "halt_check", ... })`
3. Apply state changes back to kernel fields
4. Interpret effects (if halt effect, trigger halt)
5. Return the halt result

This is the first strangler connection — the kernel delegates one decision path to the pure transition function.

Add a private method `extractState(): KernelState` that snapshots the kernel's current deterministic state into a plain data object.

### Task 6: Integration test — transition roundtrip

**Files:**
- Modify: `test/os/state-machine/transition.test.ts`

Test that:
1. `boot` → `process_completed` → `halt_check` sequence produces correct final state
2. State is deterministic: same events always produce same state
3. Effect types match expectations (submit_llm after boot, halt after budget exceeded)

### Task 7: Build and verify

Build + full test suite. All 204+ tests pass.

---

## Design Notes

**Why plain data, not subsystem instances?**
The transition function must be deterministic. Subsystem classes have methods that may depend on `this` context. Plain data (Maps, Sets, arrays) can be serialized, compared, and replayed. The kernel class bridges: it reads subsystem state into `KernelState`, calls transition, then applies changes back.

**Why start with halt_check?**
It's the simplest pure function — reads state, returns state + maybe a halt effect. No complex mutation chains. Perfect for establishing the pattern.

**Why not extract everything at once?**
The kernel has 5000+ lines of logic. Extracting all of it in one shot risks breaking the 204 existing tests. The strangler pattern works: each event handler we add to transition is one less code path in the kernel class. Eventually the kernel is just the runtime shell.

**Mathematical provability starts here:**
Once `transition()` handles an event, that handler is a pure function we can property-test with fast-check. `∀ state, event: transition(state, event)` preserves invariants (DAG acyclicity, dead process safety, budget termination). Phase 5 builds on this foundation.
