# Codebase Scout Report: scout:codebase

Standalone TypeScript/Node runtime for a “cognitive kernel” (process table + scheduler + IPC + metacog + executors), plus observability (“Lens”), an HTTP API, and an MCP control-plane.

## Repo Layout (as of 2026-03-07)

**Top-Level:**
- `src/` — TypeScript source (`61` `.ts` files)
- `test/` — vitest suite (`23` `.test.ts` files)
- `dist/` — compiled JS + `.d.ts` output (publishable artifact)
- `packages/` — workspaces: `cognitive-lens` + `cognitive-lens-ui`
- `docs/` — design docs + UI prototypes (not runtime code)
- `scripts/` — local utilities (golden-run capture, lens output, Neon tests)
- `.cognitive-kernels/` — local runtime artifacts (blackboard markdown, results, etc.)

**Workspaces:**
- `packages/lens/` (`cognitive-lens`) — framework-agnostic client library, published from `dist/`
- `packages/lens-ui/` (`cognitive-lens-ui`) — Lit + Vite UI components + Storybook

## Entry Points / Public Surface

**Published package (`cognitive-kernels`):**
- `src/index.ts` — public exports (Brain providers, `runOsMode`, kernel/config/types, runs API + MCP control-plane)
- `package.json` `bin`:
  - `cognitive-kernels` → `dist/cli.js` (`src/cli.ts`)
  - `cognitive-kernels-mcp` → `dist/mcp-cli.js` (`src/mcp-cli.ts`)

**CLI commands:**
- `cognitive-kernels os ...` → boots OS-mode kernel via `runOsMode()` (`src/os/entry.ts`)
- `cognitive-kernels serve ...` → starts Runs HTTP API, optional Neon-backed storage, optional Lens WS server (`src/cli.ts`)
- `cognitive-kernels-mcp ...` → starts MCP server for controlling runs (`src/mcp/control-plane.ts`)

## Core Modules (src/)

**`src/os/` (kernel runtime)**
- Orchestrates process execution: `OsKernel` (`kernel.ts`)
- Scheduling + topology: `scheduler.ts`, `dag-engine.ts`, `seed-blueprints.ts`
- IPC primitives: blackboard + signals in `ipc-bus.ts`
- Executors + routing: `process-executor.ts`, `executor-router.ts`, `llm-executor.ts`, `shell-executor.ts`, `subkernel-executor.ts`
- Metacognition + optimization: `metacog-agent.ts`, `self-optimizer.ts`, `perf-analyzer.ts`, `counterfactual-simulator.ts`, `awareness-daemon.ts`
- Protocol/telemetry: `protocol-emitter.ts`, `telemetry.ts`

**`src/brain/` (provider abstraction)**
- `create-brain.ts` + provider implementations (`claude-brain.ts`, `codex-brain.ts`)

**`src/runs/` (run management + monitoring views)**
- `run-manager.ts` — run lifecycle management + optional persistence
- `monitoring.ts` — builds topology/timeline/dashboard views from snapshots

**`src/lens/` (observability)**
- WebSocket server/client + session management (`server.ts`, `client.ts`, `session.ts`)
- Snapshot diffing + UI view models (`snapshot-differ.ts`, `view-models.ts`, `stream-segmenter.ts`, `narrative.ts`)

**`src/api/` (HTTP API)**
- Hono app/server + request schemas/types (`app.ts`, `server.ts`, `schemas.ts`, `types.ts`)

**`src/db/` (persistence)**
- Neon/Postgres-backed storage + schema (`storage-backend.ts`, `connection.ts`, `schema.ts`, `pg-store.ts`, `protocol-emitter-pg.ts`)

**`src/mcp/`**
- MCP control-plane server (`control-plane.ts`)

**`src/utils/`**
- Small utilities (currently includes `fibonacci.ts`)

## Architecture Docs / Patterns

**Plans/Design:**
- `docs/plans/2026-03-07-event-driven-kernel.md` — refactor plan: tick-loop → event-driven, serialized mutations via `AsyncMutex` (`src/os/async-mutex.ts`)
- `docs/plans/2026-03-06-fully-db-backed-runs.md` — “runs” persistence direction
- `docs/plans/2026-03-06-lens-design-system*.md` — Lens UI design system notes

**UI Prototype:**
- `docs/ui/run-inspector.html` — single-file run inspector prototype (topology + blackboard views)
- `docs/prompts/run-inspector-ui.md` — product/UX spec for the inspector

---
*Updated by codebase-scout on 2026-03-07.*
