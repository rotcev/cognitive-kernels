# cognitive-kernels

Standalone cognitive kernel runtime for reusable AI process substrates.

This repo keeps the kernel, scheduler, memory, and execution substrate, while
dropping older product-specific orchestration layers.

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
