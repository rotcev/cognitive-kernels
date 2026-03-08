# Phase 2: Effect Capture — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define `KernelEffect` types and intercept all kernel side effects as effect descriptors, while still executing them immediately via an adapter. Zero behavior change.

**Architecture:** Add a `KernelEffect` discriminated union in `src/os/state-machine/effects.ts`. Add an effect collection mechanism to the kernel — side effects push descriptors to a list, then `interpretEffects()` immediately executes them. This is the strangler step: same behavior, but effects are now visible, trackable, and interceptable.

**Tech Stack:** TypeScript, vitest, existing kernel test infrastructure

---

### Task 1: Define KernelEffect types

**Files:**
- Create: `src/os/state-machine/effects.ts`
- Create: `test/os/state-machine/effects.test.ts`

Define the effect type algebra — every side effect the kernel can produce:

```typescript
type KernelEffect =
  | { type: "submit_llm"; pid: string; name: string; model: string }
  | { type: "submit_ephemeral"; pid: string; ephemeralId: string; name: string; model: string; prompt: string }
  | { type: "submit_metacog"; triggerCount: number }
  | { type: "submit_awareness" }
  | { type: "start_shell"; pid: string; name: string; command: string; args: string[] }
  | { type: "start_subkernel"; pid: string; name: string; goal: string }
  | { type: "schedule_timer"; timer: string; delayMs: number }
  | { type: "cancel_timer"; timer: string }
  | { type: "persist_snapshot"; runId: string }
  | { type: "persist_memory"; operation: string }
  | { type: "emit_protocol"; action: string; message: string }
  | { type: "halt"; reason: string }
  ;
```

Tests: verify all types are constructable, type discrimination works.

### Task 2: Add effect collection to kernel + interpretEffects adapter

**Files:**
- Modify: `src/os/kernel.ts`

Add to the kernel class:
- `private pendingEffects: KernelEffect[] = []`
- `private collectEffect(effect: KernelEffect): void` — push to pendingEffects
- `private interpretEffects(): void` — drain pendingEffects and execute each immediately (the adapter)
- `getEffectLog(): readonly KernelEffect[]` — for testing (append-only copy)

The adapter in `interpretEffects()` does nothing special — it just executes the original code. The point is that effects are now captured as data before execution.

### Task 3: Wrap submitProcess as a submit_llm effect

**Files:**
- Modify: `src/os/kernel.ts` — `doSchedulingPass()` and `submitProcess()`

Instead of `submitProcess()` calling the executor directly, it collects a `submit_llm` effect. The `interpretEffects()` adapter in the scheduling pass then calls the actual executor. For Phase 2, the simplest approach: collect the effect for logging, then immediately execute the original code.

### Task 4: Wrap protocol emitter calls as emit_protocol effects

**Files:**
- Modify: `src/os/kernel.ts`

The kernel has many `this.emitter?.emit(...)` calls. Rather than wrapping all ~50+ emit sites (too invasive for Phase 2), create a thin wrapper:

```typescript
private emitProtocol(action: string, message: string, detail?: Record<string, unknown>): void {
  this.collectEffect({ type: "emit_protocol", action, message });
  this.emitter?.emit({ action, status: "completed", message, ...detail });
}
```

Then progressively replace `this.emitter?.emit(...)` calls with `this.emitProtocol(...)` in key paths only (process spawn, process kill, halt events). Don't try to wrap all 50+ sites in one pass.

### Task 5: Wrap timer setup as schedule_timer effects

**Files:**
- Modify: `src/os/kernel.ts` — `eventLoop()` timer setup

When `eventLoop()` sets up `housekeepTimer`, `snapshotTimer`, `metacogTimer`, `watchdogTimer`, collect `schedule_timer` effects.

### Task 6: Integration test for effect capture

**Files:**
- Modify: `test/os/state-machine/effects.test.ts`

Run a minimal kernel, verify the effect log contains expected effect types (submit_llm, schedule_timer, emit_protocol at minimum).

### Task 7: Build and verify

Build + full test suite. All 194+ tests pass.
