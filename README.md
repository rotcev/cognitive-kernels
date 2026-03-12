# cognitive-kernels

An operating system for minds.

## Cognitive programming

Programming used to mean telling a machine what to do. Cognitive programming
means telling a system of minds how to think together.

You don't write procedures. You write physics — the rules that govern how
minds coordinate, constrain, and verify each other. The topology algebra
(`seq`, `par`, `gate`) structures thought. The blackboard gives minds shared
memory. The metacog decomposes goals and orchestrates workers. You define
the invariants. The system figures out the motion.

When it underperforms, you don't read stack traces. You study behavior. A
reviewer inventing requirements nobody asked for. A coordinator scheduling
work in the wrong order. A worker drifting from the goal. These are
cognitive bugs — you fix them by calibrating the constraints minds operate
under.

When you optimize, you don't profile code. You restructure how minds
coordinate. Pipeline work so they stay busy instead of idle. Consolidate
review so one mind evaluates a batch instead of many minds evaluating one
each. Defer verification until there's something real to verify. These are
the same decisions a human manager makes. Except the team runs at machine
speed.

The kernel is four ideas: a deterministic transition function that mediates
all state. Scoped blackboards that give minds isolation without losing
coherence. A topology algebra that structures work. Protocol events that
make everything observable. Products built on top define what the minds
should care about — build instructions, research strategies, review
criteria, creative briefs. The domain changes. The kernel doesn't.

## Architecture

- The state machine is implemented as a pure transition core (`events` -> `transition` -> new `state`) with side effects emitted as declarative effect records, which separates deterministic orchestration logic from IO execution.
- The interpreter is the imperative adapter layer that consumes emitted effects, invokes executors/IPC/timers, and re-feeds completion events into the state machine, creating a closed event loop with clear boundaries between policy and runtime mechanics.
- The Lens observability layer is a contract-first projection pipeline that transforms kernel snapshots/events into typed view models and deltas (process graph, blackboard IO, narratives) for streaming to clients, so UIs consume stable telemetry without coupling to kernel internals.

## Core ideas

- `Brain` is the provider-agnostic abstraction over Claude or Codex/OpenAI.
- `runOsMode()` boots the kernel with a goal and optional TOML config.
- `src/os/` stays close to the original OS-mode implementation so future diffs are tractable.

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Use

```ts
import { runOsMode } from "cognitive-kernels";

await runOsMode({
  goal: "Investigate a problem and coordinate workers",
  cwd: process.cwd(),
  provider: "codex",
});
```

## Cohesion model

Multi-agent systems typically struggle with coherence — independent workers produce
contradictory or redundant output because they can't see each other. Cognitive kernels
solve this structurally through the shared blackboard, mediated by a deterministic
transition function.

**Sequential cohesion** — When the metacog declares a topology with dependencies
(e.g. `seq([research, write-report])`), the DAG edges are stored in `dagTopology`.
On each LLM turn, the interpreter walks the DAG backwards from the current process
and injects only ancestor results into the prompt. Downstream workers see exactly
what their upstream dependencies produced — no more, no less.

**Parallel cohesion** — Workers write intermediate progress to `progress:<name>`
keys on the blackboard as they work. On each subsequent turn, parallel siblings see
each other's progress through the same upstream context injection (which falls back
to global scope when no dependency edges exist). Workers self-organize turn-by-turn:
one discovers an API, its sibling sees that and focuses elsewhere, a third adjusts
its approach based on both. No coordinator needed — the shared blackboard is the
coordination mechanism.

**Safety guarantee** — All blackboard reads and writes go through
`transition(state, event) → [state', effects]`. One event at a time, pure function,
no races. Workers physically cannot corrupt each other's state because the kernel
mediates every mutation. This is what makes the shared-memory approach viable —
it's not optimistic concurrency, it's structural impossibility of conflict.

## Future directions

- **Progressive elaboration** — Currently the orchestrator waits for all scouts/readers
  in a phase to complete before spawning downstream work. The kernel already supports
  the primitives for progressive elaboration (per-process signals, partial blackboard
  reads, conditional deferrals), but the orchestrator doesn't use them yet. A future
  improvement would have the orchestrator begin downstream work as partial results
  arrive — e.g. start writing architecture sections as individual scout data lands on
  the blackboard, rather than waiting for the full picture. This turns the DAG from a
  strict phase-gated pipeline into a streaming dataflow graph, maximizing throughput
  when subtasks have uneven completion times.
