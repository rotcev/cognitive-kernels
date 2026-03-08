# Pure Kernel Extraction — Design Document

## Goal

Replace the 4700-line `OsKernel` class with a mathematically provable architecture: a pure transition function, a thin I/O interpreter (~300 lines), and an event loop (~30 lines). All kernel decisions happen inside `transition()`. The I/O shell has zero decision logic — it executes effects and produces events.

## Why

The current kernel mixes decisions, state management, and I/O in one 4700-line class. Mutable coordination flags (`transitionApprovedMetacog`, `metacogInFlight`, `drainingPids`) bridge gaps between async methods. This creates bugs that are hard to find and impossible to prove absent — the metacog boot timing bug (120s delay, missing trigger, lost approval flag) is a direct consequence.

The topology algebra proved the approach: `reconcile()` is pure, testable, provable. Extending this to the entire kernel makes the system:

- **Deterministic** — same events always produce same state and effects
- **Total** — every valid (state, event) pair produces a valid result
- **Invariant-preserving** — properties like DAG acyclicity, reconciler idempotency, drain safety hold for ALL reachable states
- **Replayable** — record events from production, replay through transition, verify behavior

## Architecture

```
┌──────────────────────────────────────────────┐
│                 Event Queue                   │
│  [boot, timer_fired, llm_completed, ...]     │
└──────────────┬───────────────────────────────┘
               │ dequeue
               ▼
┌──────────────────────────────────────────────┐
│     transition(state, event) → [state', fx]  │
│              PURE FUNCTION                    │
│     No I/O. No async. No mutation.            │
└──────────────┬───────────────────────────────┘
               │ effects[]
               ▼
┌──────────────────────────────────────────────┐
│     for each effect:                          │
│       await interpreter.interpret(effect)     │
│              I/O SHELL                        │
│     No decisions. No state. Just executes.    │
│     Async completions enqueue new events.     │
└──────────────────────────────────────────────┘
```

### OsKernel Dissolves Into Three Things

```
OsKernel (4700 lines, class) — DELETED
        ↓ splits into
┌───────────────────────────────┐
│ transition()  (pure function) │  ← already exists, gets expanded
│ ~3000 lines                   │
├───────────────────────────────┤
│ KernelInterpreter (class)     │  ← new, thin I/O shell
│ ~300 lines                    │
├───────────────────────────────┤
│ runKernel()   (async function)│  ← new entry point, ~30 lines
│ the event loop                │
└───────────────────────────────┘
```

### Entry Point

```typescript
async function runKernel(goal: string, config: OsConfig, brain: Brain): Promise<KernelState> {
  let state = initialState(config);
  const interpreter = new KernelInterpreter(brain, eventQueue);

  enqueue({ type: "boot", goal, ... });

  while (!state.halted) {
    const event = await dequeue();  // blocks until an event arrives
    const [newState, effects] = transition(state, event);
    state = newState;

    for (const effect of effects) {
      await interpreter.interpret(effect, state);
    }
  }

  return state;
}
```

## Effect Taxonomy

Every effect falls into exactly one category:

### State Changes (inside transition, NOT effects)

- Spawn/kill/activate/idle processes → update `state.processes`
- Write/read/delete blackboard → update `state.blackboard`
- Update deferrals, triggers, counters → update state fields

### Effects (require the outside world)

| Effect | Produces Event | Category |
|---|---|---|
| `run_llm { pid }` | `llm_turn_completed { pid, result }` | async |
| `run_metacog { context }` | `metacog_response_received { response }` | async |
| `run_awareness { context }` | `awareness_response_received { adjustments }` | async |
| `run_ephemeral { pid }` | `ephemeral_completed { pid, result }` | async |
| `run_shell { pid, command, args }` | `shell_output_received { pid, output }` | async |
| `run_subkernel { pid, goal }` | `subkernel_completed { pid, result }` | async |
| `schedule_timer { timer, delayMs }` | `timer_fired { timer }` (later) | deferred |
| `cancel_timer { timer }` | — | fire-and-forget |
| `emit_protocol { ... }` | — | fire-and-forget |
| `persist_snapshot { }` | — | fire-and-forget |
| `persist_memory { ... }` | — | fire-and-forget |
| `halt { reason }` | — | fire-and-forget |

Observers (browser MCP processes) use `run_llm` — the interpreter reads process config to attach tools. No special effect type.

## Event Types — Complete Set

### From boot
- `boot { goal, config, ... }`

### From timers
- `timer_fired { timer: "housekeep" | "metacog" | "snapshot" | "watchdog" }`

### From async I/O completions
- `llm_turn_completed { pid, result }` — replaces `process_completed`
- `metacog_response_received { response }` — replaces flag coordination dance
- `awareness_response_received { adjustments }` — replaces flag coordination
- `ephemeral_completed { pid, result }`
- `shell_output_received { pid, output, exitCode }`
- `subkernel_completed { pid, result }`

### From external API
- `external_command { command: "halt" | "pause" | "resume" }`

### From interpreter (synchronous feedback)
- `ipc_flushed { wokenPids }`

### Removed
- `metacog_evaluated` — absorbed into `metacog_response_received`
- `awareness_evaluated` — absorbed into `awareness_response_received`
- `process_submitted` — becomes `emit_protocol` effect
- `topology_declared` — absorbed into `metacog_response_received`

## Coordination Flags Eliminated

| Flag | Why it exists today | How it dies |
|---|---|---|
| `transitionApprovedMetacog` | Timer fires in I/O shell, transition approves in pure land, flag bridges the gap | Transition emits `run_metacog` effect directly |
| `transitionApprovedAwareness` | Same pattern for awareness | Transition emits `run_awareness` effect directly |
| `metacogInFlight` | Prevents concurrent metacog evals | State field: `metacogInflight: boolean` |
| `tickInProgress` | Watchdog checks if a tick is running | State field: `inflight` set is the source of truth |
| `drainingPids` | Tracks processes to kill after current turn | State field: `drainingPids: Set<string>` |
| `pendingEphemerals` | Queue of ephemerals waiting to drain | Transition emits `run_ephemeral` effects directly |
| `pendingAwarenessNotes` | Consume-once notes | State field consumed by transition |
| `pendingOscillationWarnings` | Consume-once warnings | State field |
| `pendingBlindSpots` | Consume-once blind spots | State field |
| `metacogFocus` | Consume-once focus area | State field |
| `lastMetacogWakeAt` | Wall-clock timing | State field |

The `halted` reentrancy guard disappears — the event loop stops dequeuing when `state.halted = true`.

## KernelState Expansion

New fields absorbing kernel.ts mutable state:

```typescript
interface KernelState {
  // === Existing fields (unchanged) ===
  goal, runId, config, processes, inflight, blackboard,
  tickCount, pendingTriggers, halted, haltReason, ...

  // === New fields ===

  // Metacog coordination
  metacogInflight: boolean;
  lastMetacogWakeAt: number;
  metacogHistory: MetacogHistoryEntry[];

  // Awareness state
  awarenessNotes: string[];
  oscillationWarnings: OscillationWarning[];
  blindSpots: BlindSpotDetection[];
  metacogFocus: string | null;

  // Drain tracking
  drainingPids: Set<string>;

  // Kill calibration
  killThresholdAdjustment: number;
  killEvalHistory: KillEvalRecord[];

  // Blueprint tracking
  selectedBlueprintInfo: SelectedBlueprintInfo | null;

  // Telemetry
  ephemeralStats: EphemeralStats;
  heuristicApplicationLog: HeuristicApplicationEntry[];

  // Strategy
  bootMatchedStrategyIds: Set<string>;
}
```

**Rule:** If transition needs it to make a decision, it's state. If it's only needed to execute I/O, it stays in the interpreter.

## What Moves Into Transition

### New: `handleMetacogResponseReceived`
Absorbs:
- `parseMetacogResponse()` — format detection, JSON parsing
- `handleTopologyDeclared` — validate, optimize, reconcile
- Memory command processing
- Halt command detection
- Metacog history recording
- Sets `metacogInflight = false`

### New: `handleAwarenessResponseReceived`
Absorbs:
- `applyAwarenessAdjustment()` — kill threshold, heuristic flagging, blind spots
- Oscillation warning processing
- Focus area updates

### Enhanced: `handleMetacogTimer`
Absorbs:
- Full metacog scheduling decision (check inflight, cadence, triggers)
- `buildMetacogContext()` becomes pure (reads from state only)
- Emits `run_metacog` effect with complete context payload
- Awareness scheduling: emits `run_awareness` if cadence fires

### Enhanced: `llm_turn_completed` handler
Absorbs:
- `processInjectedCommands()` — injected commands from executors
- Drain check — pid in `drainingPids` → kill
- `detectSelectedBlueprint()` — blueprint detection from blackboard
- Strategy outcome recording

### Eliminated: strategy matching at boot
Moves to first metacog evaluation — metacog selects strategies as part of initial topology declaration.

## Lens Compatibility

Lens is completely unaffected. The protocol emitter is an I/O resource in the interpreter:

```
transition emits: { type: "emit_protocol", action: "os_process_spawn", ... }
    ↓
interpreter calls: emitter.emit(effect.payload)
    ↓
lensBus → WebSocket server → UI
Neon storage → storage poller → cross-process consumers
```

The emitter, lensBus, storage poller, WebSocket server, snapshot differ, narrative generator — none of this changes. All Lens infrastructure lives in `src/lens/` and `src/os/protocol-emitter.ts`, outside the kernel.

Snapshots get cleaner: `state` IS the snapshot. The interpreter passes it to `emitter.saveSnapshot(state)` instead of calling a method on a mutable class.

## Migration Strategy

Build new code beside old. Delete old when new is tested.

**Phase 1: Types**
New state fields, new event types, cleaned-up effect types. No behavior change.

**Phase 2: Expand transition**
Add ~4 new event handlers (`metacog_response_received`, `awareness_response_received`, enhanced `handleMetacogTimer`, enhanced `llm_turn_completed`). Pure `buildMetacogContext()`. Move remaining decision logic out of kernel.ts.

**Phase 3: Build KernelInterpreter + runKernel()**
Fresh code. ~300 lines interpreter, ~30 lines event loop. Wire the event queue, timer management, async completion callbacks.

**Phase 4: Wire entry point + end-to-end test**
`entry.ts` calls `runKernel()`. Run against real LLM provider. Verify Lens, REST API, CLI all work.

**Phase 5: Delete OsKernel**
Remove the class, old methods, coordination flags. `kernel.ts` becomes the interpreter + entry point.

## Testing & Provability

### Layer 1: Transition unit tests
Deterministic. Given state + event → assert exact state' + effects. Expand from ~90 to cover new handlers.

### Layer 2: Property-based invariant tests
fast-check generates random states and event sequences. Prove:

| Invariant | What it proves |
|---|---|
| DAG acyclicity | Topology algebra can never produce cycles |
| Reconciler idempotency | `reconcile(reconcile(s, t), t) = reconcile(s, t)` |
| Effect determinism | Same (state, event) always produces same (state', effects) |
| No orphan processes | Every non-root process has a living parent or is reparented |
| Drain safety | Inflight process is never hard-killed, always drained |
| Halt totality | Every non-halted state eventually reaches halt given finite events |
| Metacog exclusion | `run_metacog` never emitted when `metacogInflight = true` |
| Boot completeness | Boot event always produces initial topology request |

### Layer 3: Replay tests
Record real event logs from production runs. Replay through transition, verify same state sequence. Dry-mode testing: feed arbitrary event sequences through transition without touching the outside world.

## Non-Goals

- Sub-kernel internal management (each sub-kernel has its own event loop)
- Lens redesign (unchanged)
- Memory/learning system redesign (unchanged)
- LLM provider abstraction changes (unchanged)
