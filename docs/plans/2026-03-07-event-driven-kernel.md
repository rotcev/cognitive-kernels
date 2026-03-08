# Event-Driven Kernel Stability Plan

**Date**: 2026-03-08
**Status**: Analysis complete, ready for implementation
**Context**: The event-driven kernel (Tasks 1-8 of the original plan) is implemented and running. This plan addresses the stability issues discovered during live runs.

---

## Deep Run Failure Analysis

### Data Sources
- **Run `96a79be3`** — 793 events, 6.5 minutes, user-canceled (most complete data)
- **Run `caec2260`** — failed exit=1, EPIPE crash (now fixed)
- **Run `d122e2cd`** — completed but metacog false-halted (now fixed)
- **Run `c4a62c5e`** — completed but no deliverable, all processes stalled early
- **Run `c169696e`** — failed exit=1, unknown crash
- **Run `a96b4b0a`** — failed exit=1, unknown crash

### Failure Mode Catalog

#### FM-1: Tick Inflation (CRITICAL — root cause of most issues)

**Symptom:** In run `96a79be3`, 235 ticks fired in 6.5 minutes (~1 tick per 1.7s).

**Root cause:** `housekeep()` fires every 500ms via `setInterval` and calls
`scheduler.tick()` each time, inflating `tickCount` at ~2/sec. In the old
tick-based model, one tick = one full scheduling+execution cycle (30-120s).
The event-driven model fires ticks 60-240x faster.

**Cascade effects:**
- `maxWaitTicks` deferrals expire in seconds instead of minutes
- Intervention evaluations run 190 times (every tick 46→235, emitting 190 `os_intervention_outcome` events)
- `ticksSinceMetacog > 5` fires after 2.5s instead of 2.5 minutes
- `consecutiveIdleTicks >= 3` triggers stall recovery after 1.5s
- Deadlock force-wake cooldown (`ticksSinceLastForceWake >= 5`) = 2.5s
- All tick-based timing is ~100x too aggressive

**Evidence:** 190 `os_intervention_outcome` events with `outcome=degraded`,
one per tick from 46→235. A single `reprioritize` intervention generated 190
protocol events over ~95 seconds. Pure noise.

#### FM-2: Mutex Contention Starves Metacog (CRITICAL)

**Symptom:** Only 1 metacog evaluation in 6.5 minutes of run `96a79be3`.

**Root cause:** Three operations compete for one `AsyncMutex`:
| Operation | Frequency | Priority |
|---|---|---|
| `safeHousekeep()` | every 500ms | low |
| `safeMetacogCheck()` | self-scheduling (~60s) | **high** |
| `onProcessComplete()` | on LLM completion | **high** |

Housekeep fires every 500ms and acquires the mutex each time. When metacog's
timer fires, it `await this.mutex.acquire()` — but housekeep re-acquires
first from the FIFO queue. Combined with the metacog LLM evaluation itself
taking time, metacog gets starved.

**Impact:** The metacog is the kernel's steering mechanism. Without it, the
kernel runs open-loop — no course correction, no process prioritization, no
halt evaluation. This explains why runs feel "stuck" even when processes
are active.

#### FM-3: Intervention Evaluation Spam (MODERATE)

**Symptom:** 190 `os_intervention_outcome` protocol events in run `96a79be3`.

**Root cause:** The intervention evaluation system (kernel.ts:648-724) runs
every housekeep cycle. With tick inflation at 2/sec:
1. Interventions hit `ticksToEvaluate` deadline in seconds
2. Cleanup filter keeps evaluated interventions for 20 ticks (10s)
3. Each housekeep re-emits the outcome event for already-evaluated interventions

**Impact:** Event stream noise, wasted CPU, bloated protocol logs. The 190
events are all identical — same intervention, same "degraded" outcome.

#### FM-4: Deferral Expiry Drops Work Silently (MODERATE)

**Symptom:** Not directly observed in available runs, but the code path is clear.

**Root cause:** When `maxWaitTicks` is exceeded (kernel.ts:4495), the deferral
is deleted and the process is NEVER spawned. With tick inflation, a
`maxWaitTicks: 500` deferral expires in ~250s instead of the intended ~500
scheduling cycles. Work is silently lost.

In run `96a79be3`, the `contract-observer` deferral waited 181 ticks (90s)
and triggered successfully — but only because its condition was met before
expiry. This is fragile.

#### FM-5: Ephemeral Process Completion Latency (LOW)

**Root cause:** `drainPendingEphemerals()` is fire-and-forget (`void`) outside
the mutex (kernel.ts:1845). Ephemeral completions write to blackboard but the
IPC flush that would wake dependent processes doesn't happen until the next
housekeep cycle (up to 500ms). If the next housekeep is blocked on the mutex,
latency grows.

#### FM-6: EPIPE Crash (FIXED)

Suppressed in `uncaughtException` handler. No longer crashes the kernel.

#### FM-7: Metacog False Halt (FIXED)

Kernel-side guard rejects `halt/achieved` when goal processes are alive or
deferrals are pending. Metacog prompt tells it it has no tools.

---

## Root Cause Summary

All active failure modes trace to **one root cause**: `housekeep()` conflates a
500ms wall-clock timer with the semantic concept of a "tick". When it calls
`scheduler.tick()` every 500ms, it inflates tickCount 60-240x, breaking every
tick-based mechanism in the kernel.

**Secondary root cause:** The mutex is a single bottleneck shared between three
operations of vastly different priority and frequency. Housekeep's high frequency
(500ms) starves metacog (low frequency, high importance).

---

## Stability Plan

### Phase 1: Non-Blocking Housekeep (highest impact, smallest change)

**Goal:** Housekeep should never block metacog or process completion.

**Change:** Make housekeep `tryAcquire` the mutex. If held, skip this cycle —
the mutex holder (`onProcessComplete` or `safeMetacogCheck`) already does
equivalent work (flush IPC, rebuild DAG, reschedule).

Add `tryAcquire()` to `AsyncMutex`:
```typescript
tryAcquire(): (() => void) | null {
  if (this.locked) return null;
  this.locked = true;
  return () => this.release();
}
```

Update `safeHousekeep()`:
```typescript
private async safeHousekeep(): Promise<void> {
  if (this.halted) return;
  const release = this.mutex.tryAcquire();
  if (!release) return; // mutex busy — skip this cycle
  try {
    this.housekeep();
    this.emitter?.writeLiveState(this.snapshot());
    if (this.shouldHalt()) { this.haltResolve?.(); return; }
    this.doSchedulingPass();
  } catch (err) { /* ... */ }
  finally { release(); }
}
```

**Impact:** Metacog and process completion always get the mutex promptly.
Housekeep runs when the kernel is idle — exactly when stall detection and
deadlock recovery matter most.

### Phase 2: Fix Tick Semantics

**Goal:** Make `tickCount` meaningful in the event-driven model.

**Change:** Only increment tickCount when a process result is processed (in
`onProcessComplete`), not on every housekeep fire. Introduce a separate
`housekeepCount` for timer-frequency operations.

```typescript
// In housekeep():
// REMOVE: this.scheduler.tick()
// ADD: this.housekeepCount += 1

// In onProcessComplete() (after processOneResult):
this.scheduler.tick(); // meaningful tick: actual work happened
```

**Tick signal cadences** (`tick:1`, `tick:5`, `tick:10`) move to use
`housekeepCount` so processes waiting on cadence signals still work,
but at wall-clock frequency (correct behavior).

**Impact:** tickCount goes back to ~1 per actual scheduling cycle. All tick-based
logic works at the intended timescale:
- Deferrals: `maxWaitTicks: 500` = ~500 actual cycles, not 250 seconds
- Interventions: `ticksToEvaluate` measures real scheduling rounds
- Metacog cadence: `ticksSinceMetacog > 5` = after 5 real completions

### Phase 3: Intervention Evaluation Cleanup

**Goal:** Eliminate intervention spam.

**Changes:**
1. Once an intervention outcome is determined and emitted, set `emitted = true` — never re-emit
2. Remove evaluated interventions immediately instead of the 20-tick retention window
3. Only evaluate interventions when `tickCount` changes (not every housekeep)

```typescript
// Replace the retention filter:
this.pendingInterventions = this.pendingInterventions.filter(
  iv => !iv.outcome // keep only unevaluated interventions
);
```

**Impact:** Eliminates 190-event noise bursts. Reduces housekeep CPU cost.

### Phase 4: Deferral Expiry Spawns Instead of Drops

**Goal:** Never silently drop deferred work.

**Change:** When `maxWaitTicks` is exceeded, spawn the process anyway with a
warning annotation. Metacog can kill it if no longer needed.

```typescript
if (ds.maxWaitTicks && (tickNum - ds.registeredByTick) > ds.maxWaitTicks) {
  // Spawn anyway — don't drop work silently
  const proc = this.supervisor.spawn({ ...ds.descriptor, /* ... */ });
  this.supervisor.activate(proc.pid);
  triggered.push(id);
  this.emitter?.emit({
    action: "os_defer", status: "completed",
    message: `expired_but_spawned id=${id} — spawning despite condition not met`,
  });
  continue;
}
```

**Impact:** Work never silently disappears. Worst case: unnecessary process runs
and metacog kills it. Much safer than silently dropping.

### Phase 5: Wall-Clock Safety Nets for Timing Logic

**Goal:** Critical timing should have wall-clock fallbacks.

**Changes:**
- Add `maxWaitMs` to deferrals alongside `maxWaitTicks` — whichever fires first
- Stall detection: use wall clock (`Date.now() - lastProcessCompletionTime > 30s`)
  in addition to `consecutiveIdleTicks`
- Deadlock force-wake cooldown: use wall clock (`Date.now() - lastForceWakeTime > 10s`)
  in addition to tick diff
- Add `registeredAt: Date.now()` to deferrals for wall-clock expiry

**Impact:** Timing logic works correctly regardless of tick cadence.

### Phase 6: Ephemeral Completion Wakeup (optimization)

**Goal:** Reduce latency between ephemeral completion and dependent process wake.

**Change:** In `runOneEphemeral()`, after writing BB results, acquire the mutex
and do a flush+wake+reschedule pass:

```typescript
// After ephemeral writes to BB:
const release = await this.mutex.acquire();
try {
  const { wokenPids } = this.ipcBus.flush();
  for (const pid of wokenPids) { /* activate */ }
  this.dagEngine.buildFromProcesses(this.table.getAll());
  if (this.shouldHalt()) { this.haltResolve?.(); return; }
  this.doSchedulingPass();
} finally { release(); }
```

**Impact:** Dependent processes wake immediately when scout data arrives.

---

## Implementation Order

| Priority | Phase | Risk | Effort |
|---|---|---|---|
| 1 | Phase 1: Non-blocking housekeep | Very low | ~20 lines |
| 2 | Phase 2: Fix tick semantics | Low (audit tick usage) | ~50 lines |
| 3 | Phase 3: Intervention cleanup | Very low | ~10 lines |
| 4 | Phase 4: Deferral expiry fix | Very low | ~5 lines |
| 5 | Phase 5: Wall-clock safety nets | Low | ~30 lines |
| 6 | Phase 6: Ephemeral wakeup | Low | ~20 lines |

**Total estimated change:** ~135 lines across 2 files (`kernel.ts`, `async-mutex.ts`)

## Risk Assessment

- Phases 1+2 together eliminate the two critical failure modes
- Phase 4 is a safety net — even with correct tick semantics, spawning-on-expiry is safer
- No changes affect the LLM execution path — all kernel scheduling/timing fixes
- All changes are backward-compatible with the deprecated `tick()` method
- Each phase can be tested independently with existing integration tests
