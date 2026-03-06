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
