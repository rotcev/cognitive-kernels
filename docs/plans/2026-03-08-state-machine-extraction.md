# State Machine Extraction — Design Document

**Date**: 2026-03-08
**Status**: Approved
**Branch**: `state-machine-extraction`

## Vision

Refactor the cognitive kernel into a deterministic event-driven state machine where:
- A pure transition function `(State, Event) → (State, Effect[])` defines all kernel behavior
- All external actions (LLM, shell, browser, timers) are modeled as effects handled by the runtime
- The event log enables replay, time-travel debugging, and property-based verification
- Process topologies become algebraically analyzable and optimizable

The end goal is mathematical provability: given the same initial state and event sequence, the kernel always produces the same final state and effect list.

## Core Type Algebra

Three types define the entire system:

### KernelState

Complete kernel state — everything needed to determine the next transition:

```typescript
type KernelState = {
  processes: ProcessTableState;
  blackboard: BlackboardState;
  dag: DagState;
  deferrals: Map<string, DeferEntry>;
  scheduler: SchedulerState;
  memory: MemoryState;
  metacog: MetacogState;
  inflight: Set<string>;
  timers: LogicalTimerState;
  config: OsConfig;
  halted: boolean;
  haltReason: string | null;
  startTime: number;
  goalWorkDoneAt: number;
};
```

### KernelEvent

Everything that can happen TO the kernel:

```typescript
type KernelEvent =
  | { type: "boot"; goal: string }
  | { type: "process_completed"; result: OsProcessTurnResult }
  | { type: "ephemeral_completed"; id: string; result: EphemeralResult }
  | { type: "metacog_evaluated"; response: MetacogResponse }
  | { type: "awareness_evaluated"; adjustment: AwarenessAdjustment }
  | { type: "timer_fired"; timer: "housekeep" | "metacog" | "watchdog" | "snapshot" }
  | { type: "shell_output"; pid: string; stdout: string; stderr: string; exitCode?: number }
  | { type: "external_command"; command: "halt" | "pause" | "resume" }
  ;
```

### KernelEffect

Everything the kernel wants the outside world to do:

```typescript
type KernelEffect =
  | { type: "submit_llm"; pid: string; prompt: string; model: string }
  | { type: "submit_ephemeral"; id: string; prompt: string; model: string }
  | { type: "submit_metacog"; context: MetacogContext }
  | { type: "submit_awareness"; context: AwarenessContext }
  | { type: "start_shell"; pid: string; command: string; args: string[] }
  | { type: "start_subkernel"; pid: string; goal: string; config: OsConfig }
  | { type: "schedule_timer"; timer: string; delayMs: number }
  | { type: "cancel_timer"; timer: string }
  | { type: "persist_snapshot"; snapshot: OsSystemSnapshot }
  | { type: "persist_memory"; key: string; value: unknown }
  | { type: "emit_event"; event: ProtocolEvent }
  | { type: "halt"; snapshot: OsSystemSnapshot }
  ;
```

### The Transition Function

```typescript
function transition(state: KernelState, event: KernelEvent): [KernelState, KernelEffect[]]
```

Total function — for every valid `(state, event)` pair, produces exactly one `(state', effects)` pair. No exceptions, no I/O, no randomness.

## Runtime Loop

The impure shell that bridges the pure kernel and the real world:

```typescript
class KernelRuntime {
  private state: KernelState;
  private eventQueue: AsyncQueue<KernelEvent>;

  async run(goal: string): Promise<OsSystemSnapshot> {
    let [state, effects] = transition(this.state, { type: "boot", goal });
    this.state = state;
    await this.interpret(effects);

    while (!this.state.halted) {
      const event = await this.eventQueue.take();
      [state, effects] = transition(this.state, event);
      this.state = state;
      await this.interpret(effects);
    }

    return snapshot(this.state);
  }

  private async interpret(effects: KernelEffect[]): Promise<void> {
    for (const effect of effects) {
      // Each effect type has a handler that eventually pushes a KernelEvent
      // submit_llm → process_completed
      // schedule_timer → timer_fired
      // start_shell → shell_output
      // This creates the closed event loop.
    }
  }
}
```

Every effect eventually produces an event. This closed loop is the system's fundamental invariant.

## Replay & Verification

```typescript
// Deterministic replay: same events → same state → same effects, always
function replay(events: KernelEvent[]): KernelState {
  let state = initialState();
  for (const event of events) {
    const [newState, _effects] = transition(state, event);
    state = newState;
  }
  return state;
}
```

Provable properties (via property-based testing with fast-check):
- **DAG acyclicity**: After every transition, the DAG contains no cycles
- **Dead process safety**: A dead process is never in the inflight set
- **Token budget termination**: If budget is exceeded, the next transition produces a halt effect
- **Progress**: If runnable processes exist and no halt condition, effects include process submissions
- **Blackboard consistency**: A key's value matches the most recent write
- **Halt convergence**: Under bounded token budget, the kernel always eventually halts

## Lens Integration

Lens benefits automatically and gets richer:
- `emit_event` effects flow through to Lens as before (zero breakage)
- `KernelEvent` stream provides complete, typed, ordered execution history
- Replay enables time-travel scrubbing in the UI (scrub to any point, see exact state)
- Effect visualization: what the kernel decided (effects) vs. what happened (events)

## Migration Strategy: Incremental Strangler

Five phases, each a separate PR, each keeps 183+ tests green.

### Phase 1: Event Logging

Passive observation, zero behavior change.

- Define `KernelEvent` union type in `src/os/state-machine/events.ts`
- Add `eventLog: KernelEvent[]` to kernel class
- At every entry point (`onProcessComplete`, `safeHousekeep`, `doMetacogCheck`, `submitProcess`), record the triggering event
- No behavior changes — events are passive observers

**Files touched**: `kernel.ts` (add logging calls), new `src/os/state-machine/events.ts`
**Deliverable**: Complete typed event log of every run
**Risk**: None — additive only

### Phase 2: Effect Capture

Intercept side effects, still execute them immediately.

- Define `KernelEffect` union type in `src/os/state-machine/effects.ts`
- Replace direct side effects with effect descriptors collected into an array:
  - `this.submitProcess(proc)` → `effects.push({ type: "submit_llm", ... })`
  - `this.emitter?.emit(...)` → `effects.push({ type: "emit_event", ... })`
  - `setTimeout(...)` → `effects.push({ type: "schedule_timer", ... })`
- An `interpretEffects()` adapter immediately executes each effect (behavior unchanged)
- Effect log joins event log for full observability

**Files touched**: `kernel.ts` (wrap side effects), new `src/os/state-machine/effects.ts`
**Deliverable**: Every side effect is visible, trackable, and interceptable
**Risk**: Low — same behavior, different routing

### Phase 3: Extract Transition Function

The pure core emerges.

- Create `src/os/state-machine/transition.ts`
- Extract logic from `processOneResult()`, `housekeep()`, `shouldHalt()`, `executeProcessCommands()`, `doSchedulingPass()` into `transition(state, event) → [state, effects]`
- Define `KernelState` type that composes existing subsystem states
- Kernel class becomes a thin wrapper: receive event → call transition → interpret effects
- State reads come from `KernelState`, not `this.*`

**Files touched**: new `src/os/state-machine/transition.ts`, new `src/os/state-machine/state.ts`, `kernel.ts` (delegate to transition)
**Deliverable**: Pure transition function, independently unit-testable
**Risk**: Medium — largest refactoring step, but existing tests provide safety net

### Phase 4: Build Runtime

Invert control — the runtime drives the kernel, not the other way around.

- Create `src/os/state-machine/runtime.ts` with `KernelRuntime` class
- Implement `AsyncQueue<KernelEvent>` for event delivery
- Implement `interpret()` — each effect type maps to an async handler that pushes events
- Old `OsKernel` class becomes a compatibility shim (delegates to runtime)
- Existing tests work through shim; new tests target runtime directly

**Files touched**: new `src/os/state-machine/runtime.ts`, `kernel.ts` (shim), `entry.ts` (wire runtime)
**Deliverable**: Event-driven runtime with pure core, old API preserved
**Risk**: Medium — control flow inversion, but shim preserves backward compat

### Phase 5: Replay, Properties, Verification

The payoff — mathematical provability begins.

- Create replay harness: `src/os/state-machine/replay.ts`
- Record event logs during runs (already captured in Phase 1)
- Replay harness feeds recorded events through `transition()`, verifies determinism
- Property-based tests with fast-check: random `KernelEvent` sequences, verify invariants
- Invariant library: `src/os/state-machine/invariants.ts` — composable property checks
- Foundation for algebraic topology optimization (Phase 6+)

**Files touched**: new `src/os/state-machine/replay.ts`, new `src/os/state-machine/invariants.ts`, new `test/os/state-machine/` test directory
**Deliverable**: Provable properties, replay debugging, verification foundation
**Risk**: Low — additive, tests existing behavior

## Future Phases (Out of Scope for This Plan)

- **Phase 6: Algebraic Topology DSL** — Declarative topology language, optimizer rewrites
- **Phase 7: Adaptive Topologies** — LLM emits partial graphs with decision points, runtime materializes progressively
- **Phase 8: Learned Orchestration** — Process topology becomes a first-class learnable object

## File Structure

```
src/os/state-machine/
  events.ts        — KernelEvent union type
  effects.ts       — KernelEffect union type
  state.ts         — KernelState type + initialState()
  transition.ts    — Pure transition function
  runtime.ts       — Impure runtime loop (event queue + effect interpretation)
  replay.ts        — Deterministic replay harness
  invariants.ts    — Composable property checks for verification

test/os/state-machine/
  events.test.ts
  transition.test.ts
  runtime.test.ts
  replay.test.ts
  invariants.test.ts
```

## Design Decisions & Rationale

1. **Pure transition function (not class)** — Functions are easier to reason about, compose, and verify than classes with mutable state.

2. **Strangler pattern** — Each phase keeps tests green. No big-bang rewrite risk.

3. **Existing subsystems kept as-is** — ProcessTable, Scheduler, IPC, DAG are already mostly pure. They become components of KernelState. Refactoring them to pure data is a future optimization that doesn't change the transition function's contract.

4. **Event queue as the single input** — Total ordering on events enables causal reasoning and deterministic replay.

5. **Effects as data** — Effect descriptors can be inspected, logged, mocked, and eventually optimized (e.g., batching multiple emit_event effects).

6. **Closed event-effect loop** — Every effect eventually produces an event. This invariant ensures the system always makes progress or halts.
