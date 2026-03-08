# Pure State Machine Kernel — Completion Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the hybrid kernel. Every state decision flows through `transition(state, event) → [state', effects]`. The kernel class becomes a thin I/O shell that feeds events in and interprets effects out. No bridge diffing, no scattered supervisor calls, no decision-making outside transition.

**Architecture:**
```
Events (from timers, LLM completions, external commands)
    ↓
transition(state, event) → [state', effects]    ← ALL decisions here
    ↓                         ↓
applyState(state')         interpretEffects(effects)
  (trivial field copy)       (ALL I/O here)
```

**Non-goals:** Sub-kernel migration (deferred per user). Metacog/awareness LLM invocation (async I/O stays in kernel — transition just decides *when* to invoke, effects trigger it). Telemetry collection (observability, not decision-making).

**Key principle:** If the transition wants something to happen, it emits a typed effect. If it needs information, it reads from KernelState. The kernel never makes decisions — it only translates between the real world and the state machine.

---

## Wave 1: Typed Effect System (foundation for everything else)

The current `emit_protocol` effect is a catch-all that carries structured data as message strings. The interpreter parses these strings to figure out what to do. This is fragile and makes the effect system untrustworthy. Fix this first because every subsequent wave depends on typed effects.

### Task 1.1: Add missing effect types to `effects.ts`

**Files:**
- Modify: `src/os/state-machine/effects.ts`

Add these effect types to the `KernelEffect` union:

```typescript
/** Activate a process (idle/sleeping → running in scheduler). */
export type ActivateProcessEffect = BaseEffect & {
  type: "activate_process";
  pid: string;
};

/** Set a process to idle state. */
export type IdleProcessEffect = BaseEffect & {
  type: "idle_process";
  pid: string;
  wakeOnSignals?: string[];
};

/** Emit an IPC signal. */
export type SignalEmitEffect = BaseEffect & {
  type: "signal_emit";
  signal: string;
  sender: string;
  payload?: Record<string, unknown>;
};

/** Emit a child:done signal to the parent. */
export type ChildDoneSignalEffect = BaseEffect & {
  type: "child_done_signal";
  childPid: string;
  childName: string;
  parentPid: string;
  exitCode?: number;
  exitReason?: string;
};

/** Flush IPC bus and activate woken processes. */
export type FlushIPCEffect = BaseEffect & {
  type: "flush_ipc";
};

/** Rebuild the DAG topology from the current process table. */
export type RebuildDAGEffect = BaseEffect & {
  type: "rebuild_dag";
};

/** Select and submit runnable processes for LLM execution. */
export type SchedulePassEffect = BaseEffect & {
  type: "schedule_pass";
};
```

Update the `KernelEffect` union to include all new types.

### Task 1.2: Wire new effects into `interpretTransitionEffects`

**Files:**
- Modify: `src/os/kernel.ts` (interpretTransitionEffects method)

Add cases for each new effect type:

```typescript
case "activate_process": {
  const proc = this.table.get(effect.pid);
  if (proc && (proc.state === "idle" || proc.state === "sleeping")) {
    this.supervisor.activate(effect.pid);
  }
  break;
}
case "idle_process": {
  this.supervisor.idle(effect.pid, effect.wakeOnSignals ? { signals: effect.wakeOnSignals } : {});
  break;
}
case "signal_emit": {
  this.ipcBus.emitSignal(effect.signal, effect.sender, effect.payload);
  this.tickSignals.push(effect.signal);
  break;
}
case "child_done_signal": {
  this.emitChildDoneSignal(effect.childPid, effect.childName, effect.parentPid, effect.exitCode, effect.exitReason);
  break;
}
case "flush_ipc": {
  const { wokenPids } = this.ipcBus.flush();
  for (const pid of wokenPids) {
    const proc = this.table.get(pid);
    if (proc && proc.state === "idle") {
      this.supervisor.activate(pid);
    }
  }
  break;
}
case "rebuild_dag": {
  this.dagEngine.buildFromProcesses(this.table.getAll());
  break;
}
case "schedule_pass": {
  this.doSchedulingPass();
  break;
}
```

### Task 1.3: Replace message-string-parsing in interpreter

**Files:**
- Modify: `src/os/kernel.ts` (interpretTransitionEffects, the `emit_protocol` case)

Remove the fragile regex parsing in the `emit_protocol` case that extracts signal names from message strings. All signal/child-done logic should use the new typed effects instead. The `emit_protocol` case should ONLY call `this.emitter?.emit()` — nothing else.

### Task 1.4: Update transition to emit typed effects

**Files:**
- Modify: `src/os/state-machine/transition.ts`

Everywhere the transition currently emits `emit_protocol` effects for signals, child:done, etc., replace with the corresponding typed effect. Keep `emit_protocol` effects only for protocol logging (the emitter).

Key locations:
- `handleProcessCompleted`: Replace signal emit_protocol with `signal_emit` + `child_done_signal` + `flush_ipc` + `rebuild_dag`
- `handleEphemeralCompleted`: Replace signal emit_protocol with `signal_emit` + `flush_ipc`
- `handleHousekeep`: Replace stall detection force-wake `emit_protocol` with `activate_process`
- `handleShellOutput`: Replace `wake_process` with `activate_process` (rename for consistency)

### Task 1.5: Tests for new effect types

**Files:**
- Modify: `test/os/state-machine/transition.test.ts`
- Modify: `test/os/state-machine/effects.test.ts`
- Modify: `test/os/state-machine/invariants.test.ts`

- Verify transition emits typed effects (not message-string emit_protocol) for all signal/wake scenarios
- Update effect type arbitraries to cover new types
- Update integration tests that check effect output

---

## Wave 2: Process Lifecycle Through Effects

Currently `applyStateChanges()` does smart diffing — it detects idle→running transitions and calls `supervisor.activate()`. This is the bridge hack that caused the haiku bug. All process lifecycle changes should be effects.

### Task 2.1: Transition emits `activate_process` for all wake scenarios

**Files:**
- Modify: `src/os/state-machine/transition.ts`

Every place in transition that sets a process state to `"running"` from `"idle"` or `"sleeping"` must ALSO emit an `activate_process` effect. Currently transition changes the state in the processes Map but relies on applyStateChanges to detect it. Instead:

- `handleHousekeep` stall detection → emit `activate_process` per woken process
- `handleHousekeep` deadlock detection → emit `activate_process` for orchestrator
- `handleHousekeep` sleeper waking → emit `activate_process` per woken sleeper
- `handleHousekeep` checkpoint restoration → emit `activate_process`
- `handleProcessCompleted` parent wake → emit `activate_process`
- `handleShellOutput` parent wake → emit `activate_process` (rename existing `wake_process`)

### Task 2.2: Transition emits `idle_process` for daemon returns

**Files:**
- Modify: `src/os/state-machine/transition.ts`

When metacog/awareness daemons complete a turn and should return to idle, transition should emit `idle_process` effects rather than relying on kernel code to call `supervisor.idle()`.

### Task 2.3: Remove process lifecycle logic from `applyStateChanges()`

**Files:**
- Modify: `src/os/kernel.ts`

Remove the `supervisor.activate()` call from `applyStateChanges()` (the bridge hack). The `prevState` tracking and activation call should be deleted entirely. Process state sync becomes a trivial field copy — no decisions.

### Task 2.4: Remove redundant supervisor calls from kernel methods

**Files:**
- Modify: `src/os/kernel.ts`

Audit all call sites of `this.supervisor.activate()`, `this.supervisor.idle()`, etc. that overlap with transition-driven effects. Remove them if the corresponding transition handler already emits the effect. Key locations:

- `doMetacogCheck()`: supervisor.activate(metacogDaemon) → should be an effect from transition
- `doMetacogCheck()`: supervisor.idle(metacogDaemon) → should be an effect
- Awareness evaluation sites: same pattern
- `housekeepIO()` IPC flush wake loop → handled by `flush_ipc` effect

### Task 2.5: Tests

**Files:**
- Modify: `test/os/state-machine/transition.test.ts`
- Modify: `test/os/event-driven-kernel.test.ts`

- Verify transition emits `activate_process` for deadlock detection, stall detection, sleeper waking
- Verify transition emits `idle_process` for daemon idle transitions
- Integration test: process goes idle → ephemeral completes → orchestrator is force-woken via effect (the haiku bug scenario)

---

## Wave 3: Housekeep I/O Migration

`housekeepIO()` is where most remaining impure decisions live. Move every decision into `handleHousekeep` in the transition function, leaving `housekeepIO()` as a pure effect executor (or eliminate it entirely).

### Task 3.1: Move tick signal emission into transition

**Files:**
- Modify: `src/os/state-machine/transition.ts` (handleHousekeep)
- Modify: `src/os/kernel.ts` (housekeepIO)

The transition already has `housekeepCount`. It should compute which cadence signals fire (`housekeepCount % cadence === 0`) and emit `signal_emit` effects for each. Remove the signal loop from `housekeepIO()`.

### Task 3.2: Move zombie reaping into transition

**Files:**
- Modify: `src/os/state-machine/transition.ts` (handleHousekeep)
- Modify: `src/os/kernel.ts` (housekeepIO)

Zombie reaping is pure state: find dead processes with orphaned children, reparent them. Transition can do this by iterating the processes Map. Remove `supervisor.reapZombies()` from `housekeepIO()`.

### Task 3.3: Move daemon restart logic into transition

**Files:**
- Modify: `src/os/state-machine/transition.ts` (handleHousekeep)
- Modify: `src/os/kernel.ts` (housekeepIO)

Daemon restart policy evaluation is pure: check if a dead daemon has `restartPolicy`, check restart count limits, spawn replacement. Transition can create the new process and emit `submit_llm` effect. Remove `supervisor.handleRestarts()` from `housekeepIO()`.

### Task 3.4: Move strategy application into transition

**Files:**
- Modify: `src/os/state-machine/state.ts` (add scheduler strategy state)
- Modify: `src/os/state-machine/transition.ts` (handleHousekeep)
- Modify: `src/os/kernel.ts` (housekeepIO, extractState)

Strategy selection (`getApplicableStrategies()`) reads from `bootMatchedStrategyIds` and process state — both available in KernelState. Move the logic into transition. Add `matchedStrategyIds: Set<string>` to KernelState.

### Task 3.5: Eliminate `housekeepIO()` or reduce to pure I/O

**Files:**
- Modify: `src/os/kernel.ts`

After Tasks 3.1–3.4, `housekeepIO()` should only contain:
- `this.processDeferrals()` (partially migrated, see Wave 4)
- IPC flush (handled by `flush_ipc` effect)
- DAG rebuild (handled by `rebuild_dag` effect)
- Telemetry (observation, not decision-making — OK to keep)

Remove all decision-making. If everything moved, delete the method and let transition effects handle it all.

### Task 3.6: Tests

**Files:**
- Modify: `test/os/state-machine/transition.test.ts`

- Test tick cadence signal emission at various housekeepCounts
- Test zombie reaping (dead parent → children reparented)
- Test daemon restart (dead daemon with restartPolicy → new process spawned)
- Test strategy application (matched strategies → activeStrategyId updated)

---

## Wave 4: Scheduling Through Transition

Currently `doSchedulingPass()` calls `scheduler.selectRunnable()` (a pure function) and then calls `submitProcess()` for each selected process. The selection logic belongs in transition.

### Task 4.1: Add scheduler state to KernelState

**Files:**
- Modify: `src/os/state-machine/state.ts`
- Modify: `src/os/kernel.ts` (extractState, applyStateChanges)

Add fields that `selectRunnable()` needs:

```typescript
// In KernelState:
schedulerStrategy: "priority" | "round-robin" | "deadline" | "learned";
schedulerMaxConcurrent: number;
schedulerRoundRobinIndex: number;
schedulerHeuristics: OsHeuristic[];
currentStrategies: SchedulingStrategy[];
```

### Task 4.2: Port `selectRunnable()` logic into transition

**Files:**
- Modify: `src/os/state-machine/transition.ts`

Create a pure `selectRunnable()` function inside transition.ts that mirrors `OsScheduler.selectRunnable()`. Call it from handleHousekeep and emit `submit_llm` effects for each selected process.

Alternatively, import `OsScheduler.selectRunnable` if it can be made a pure standalone function (it already is — just needs process array + topology + config).

### Task 4.3: Transition emits `submit_llm` from scheduling

**Files:**
- Modify: `src/os/state-machine/transition.ts`
- Modify: `src/os/state-machine/events.ts` (add inflight info to timer_fired event)

After `selectRunnable()`, transition emits a `submit_llm` effect for each selected process that isn't already inflight. This requires `inflight` (already in KernelState) to be checked.

### Task 4.4: Remove `doSchedulingPass()` decision logic from kernel

**Files:**
- Modify: `src/os/kernel.ts`

`doSchedulingPass()` becomes unnecessary — transition handles selection, effects handle submission. Remove the method or reduce it to a no-op passthrough to `interpretTransitionEffects`. The `schedule_pass` effect type from Wave 1 becomes unnecessary too (remove it).

### Task 4.5: Tests

**Files:**
- Modify: `test/os/state-machine/transition.test.ts`

- Test that handleHousekeep emits `submit_llm` effects for runnable processes
- Test that inflight processes are excluded from selection
- Test maxConcurrent limit
- Test priority ordering

---

## Wave 5: Deferral Processing Completion

Deferral condition evaluation is partially in transition (`evaluateDeferConditionPure`), but the runtime `processDeferrals()` in the kernel still calls `supervisor.spawn()` directly. Complete the migration.

### Task 5.1: Ensure all deferral conditions evaluate purely

**Files:**
- Modify: `src/os/state-machine/transition.ts`

Verify `evaluateDeferConditionPure()` handles all condition types using only KernelState data (blackboard Map, processes Map). Currently handles: `blackboard_key_exists`, `blackboard_key_match`, `blackboard_value_contains`, `process_dead`, `process_dead_by_name`, `all_of`, `any_of`.

Check for any conditions that `evaluateDeferCondition()` in kernel.ts handles that the pure version doesn't. Port any missing ones.

### Task 5.2: Remove `processDeferrals()` from kernel

**Files:**
- Modify: `src/os/kernel.ts`

The transition's `handleHousekeep` and `handleProcessCompleted` already call `processPureDeferrals()`. The kernel's `processDeferrals()` is now redundant. Remove the call from `housekeepIO()` and delete the method.

### Task 5.3: Tests

**Files:**
- Modify: `test/os/state-machine/transition.test.ts`

- Test all deferral condition types with pure evaluation
- Test TTL expiry spawns process
- Test deferral cleanup after trigger

---

## Wave 6: `applyStateChanges()` Simplification

After Waves 1–5, `applyStateChanges()` should be reduced to a trivial field copy. No decisions, no supervisor calls, no IPC operations.

### Task 6.1: Audit and strip `applyStateChanges()`

**Files:**
- Modify: `src/os/kernel.ts`

The method should become:

```typescript
private applyStateChanges(newState: KernelState): void {
  // Scalar fields
  this.halted = newState.halted;
  this.haltReason = newState.haltReason ?? "";
  this.goalWorkDoneAt = newState.goalWorkDoneAt;
  this.startTime = newState.startTime;
  this.consecutiveIdleTicks = newState.consecutiveIdleTicks;
  this.lastProcessCompletionTime = newState.lastProcessCompletionTime;
  this.housekeepCount = newState.housekeepCount;
  this.goal = newState.goal;
  this.activeStrategyId = newState.activeStrategyId;

  // Process table — trivial sync
  for (const [pid, proc] of newState.processes) {
    const existing = this.table.get(pid);
    if (!existing) {
      this.table.addDirect(proc);
    } else {
      // Copy all fields — NO decisions
      Object.assign(existing, proc);
    }
  }

  // Blackboard — write new/updated entries
  for (const [key, entry] of newState.blackboard) {
    this.ipcBus.bbWrite(key, entry.value, entry.writtenBy ?? "kernel");
  }

  // Deferrals
  this.deferrals = new Map(newState.deferrals);

  // Triggers
  this.pendingTriggers = [...newState.pendingTriggers];
  this.metacog.setTriggers(newState.pendingTriggers);
}
```

No `syncProcesses` flag needed. No supervisor calls. No decision-making.

### Task 6.2: Remove `syncProcesses` option

**Files:**
- Modify: `src/os/kernel.ts`

Remove the `{ syncProcesses?: boolean }` option from `applyStateChanges()`. All call sites should pass state unconditionally. Process sync always happens.

### Task 6.3: Tests

**Files:**
- Modify: `test/os/event-driven-kernel.test.ts`

- Integration test: full boot → process completion → halt cycle
- Verify no supervisor calls in applyStateChanges (can mock supervisor and assert no calls)

---

## Wave 7: Remaining Cleanup

### Task 7.1: Move trigger management fully into transition

**Files:**
- Modify: `src/os/kernel.ts`
- Modify: `src/os/state-machine/transition.ts`

The kernel's `addTrigger()` calls (in housekeepIO, dead executive recovery, etc.) should be removed. Instead, transition should detect trigger conditions and add triggers to `pendingTriggers` in the returned state. Key triggers:

- `"goal_drift"` — transition can detect this (ticksSinceMetacog > 5 with living goal work)
- `"process_failed"` — transition already handles this in dead executive recovery

### Task 7.2: Consolidate `wake_process` and `activate_process`

**Files:**
- Modify: `src/os/state-machine/effects.ts`
- Modify: `src/os/state-machine/transition.ts`
- Modify: `src/os/kernel.ts`

Remove the `wake_process` effect type (from shell_output handler) and use `activate_process` everywhere. One effect type for one concept.

### Task 7.3: Move metacog/awareness scheduling decisions into transition

**Files:**
- Modify: `src/os/state-machine/transition.ts` (handleHousekeep)
- Modify: `src/os/kernel.ts`

Currently the kernel decides when to run metacog (`shouldConsultMetacog()`) and awareness (`shouldConsultAwareness()`). These are pure cadence checks that belong in transition. Transition should emit `submit_metacog` / `submit_awareness` effects when it's time. The kernel just executes the LLM call.

### Task 7.4: Property-based invariant: no decision in applyStateChanges

**Files:**
- Modify: `test/os/state-machine/invariants.test.ts`

Add a property test: for any (state, event) pair, the transition result fully determines all observable side effects. Specifically: the effects array contains every I/O action needed — no additional actions should be required by the caller beyond trivial state copying.

---

## Verification

After all waves, the kernel should satisfy these invariants:

1. **transition is total**: every (state, event) pair produces (state', effects). No exceptions.
2. **transition is pure**: same (state, event) always produces same (state', effects). No I/O, no randomness (except PID generation via deterministic seeds if needed).
3. **effects are complete**: the effects array contains every I/O action the kernel needs to take. Nothing is inferred from state diffs.
4. **applyStateChanges is trivial**: no conditionals, no method calls beyond field assignment and table sync.
5. **interpretTransitionEffects is mechanical**: each effect type maps to exactly one I/O operation. No business logic.
6. **replay works**: feeding the same event sequence through transition produces identical state and effects.

Run the full test suite (`npx vitest run`) after each wave. Run a real kernel with `--provider codex` after Waves 2 and 7 to verify end-to-end behavior.
