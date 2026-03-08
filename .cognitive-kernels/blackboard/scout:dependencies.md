# Dependency Scout Report: scout:dependencies

**Timestamp:** 2026-03-07  
**Repo Root:** `/Users/shawndavies/dev/cognitive-kernels`

## Stack summary
- Node.js + TypeScript (ESM) monorepo using npm workspaces (`packages/*`)
- Runtime pieces: kernel runner + CLI, MCP (stdio), Hono HTTP API, WebSocket Lens server, optional Neon/Postgres via Drizzle
- UI workspace: `packages/lens-ui` (Lit + Vite library build + Storybook)

## Tooling
- Package manager: npm (`package-lock.json`, plus `packages/lens-ui/package-lock.json`)
- Build: `tsc -p tsconfig.json` (root), `tsc` (packages/lens), `vite build && tsc --emitDeclarationOnly` (packages/lens-ui)
- Test: Vitest (`vitest run --passWithNoTests`)

## Key dependencies (root)
- LLM: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`
- MCP: `@modelcontextprotocol/sdk`
- DB: `drizzle-orm` + `drizzle-kit`, `@neondatabase/serverless` (via `DATABASE_URL`)
- API: `hono`, `zod`
- Transport/config: `ws`, `dotenv`, `smol-toml`

## Infra/config notes
- Drizzle config: `drizzle.config.ts` (Postgres dialect, migrations to `./drizzle`, `DATABASE_URL`)
- Common env vars: `DATABASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- No CI workflows or Docker/Terraform configs detected at repo root

Full expanded write-up lives in `scout:dependencies`.
