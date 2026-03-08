# Developer Experience Scout Report: scout:dx

## Executive Summary

Comparative DX analysis across Node.js, Deno, and Bun as of March 2026:

- **Node.js**: Most mature, largest ecosystem, native TypeScript support (v22.18+), solid debugging, steepest setup curve
- **Deno**: Best built-in tooling (formatter, linter, test runner), strongest security model, npm compatibility solved (v2.0+), smaller ecosystem
- **Bun**: Fastest performance, simplest all-in-one setup, aggressive npm compatibility, weakest debugging ergonomics, Windows support lagging

## 1. Built-In TypeScript Support

### Node.js
- **Native TS Execution:** v22.18+ supports `--experimental-strip-types` flag for direct .ts execution without transpiler
- **Project Corsa:** Microsoft's Go-based TypeScript compiler shipping with TS 7.0 (mid-2026), targeting 10x faster compilation
- **Ecosystem Impact:** By-product is removal of Babel/SWC/Webpack intermediate layer for simple projects
- **Source Maps:** Full support via dev tools for debugging TypeScript directly
- **Pain Point:** Requires separate TypeScript setup for strict type-checking; type stripping is syntax-only

### Deno
- **Native TS Execution:** First-class, zero config. Directly executes .ts files with `deno run file.ts`
- **Integrated Type-Checking:** `deno check` command for explicit type checking; defaults to type-checking on run
- **DX Win:** No transpiler step, no configuration—TypeScript is the default language, not an afterthought
- **Ecosystem Benefit:** Type checking catches errors before execution in development
- **Trade-off:** JSR (Deno's package registry) lacks pre-JSR HTTP imports; npm compatibility via npm: specifier mitigation

### Bun
- **Native TS Execution:** Direct .ts and .tsx execution with zero config
- **No Explicit Type-Checking:** Bun focuses on transpilation speed (~5ms startup), not type safety
- **Trade-off:** Requires external tsc or IDE for strict type validation; developers must remember to type-check separately
- **DX Pain:** False sense of "it works" when types are violated; no built-in compiler checking

**Verdict:** Deno >> Bun > Node.js for native TypeScript experience; Node.js catching up with v22.18+

---

## 2. Toolchain Ecosystem (Test Runner, Bundler, Package Manager)

### Node.js
**Package Manager:**
- npm (default): Stable, 475k+ Stack Overflow references, mature lockfile strategy
- Semantic versioning enforcement, well-documented dependency resolution
- 30+ years of package.json standard; ES module support stable

**Test Runner:**
- Requires third-party: Vitest, Jest, Mocha
- Node 20+ has built-in `node --test` but adoption low; ecosystem still favors Jest/Vitest

**Bundler:**
- Requires third-party: Webpack, Vite, ESBuild, Rollup, Parcel
- Mature ecosystem, but heavy configuration burden for new projects

**Setup Pain:** Developer must choose and wire together test framework, bundler, and package manager—high onboarding friction

### Deno
**Package Manager:**
- Hybrid approach: JSR (Deno's registry) + npm: specifier support (v2.0)
- deno.json for dependency management (no package.json required, but now supported)
- Linting & formatting built-in: `deno lint`, `deno fmt` (no ESLint/Prettier needed)
- No pre-installation scripts by default (security-first); deno approve-scripts for granular control

**Test Runner:**
- Built-in: `deno test` (fully featured, watches files)
- API compatible with standard naming convention (test/*.test.ts)
- DX Win: Zero external dependencies for testing

**Bundler:**
- Built-in: `deno bundle` (simple, optimized)
- No Webpack-grade complexity

**DX Win:** Single command setup (`deno.json` + CLI flags); no tool selection paralysis

**Pain Point:** NPM package incompatibility for packages with native bindings or postinstall scripts; JSR ecosystem still immature

### Bun
**Package Manager:**
- bun install (20-40x faster than npm via binary lockfile + global cache)
- Automatic .env file pickup (no dotenv configuration)
- ~95-99% npm compatibility as of v1.1; major native module gaps (bcrypt, sharp, node-canvas)

**Test Runner:**
- Built-in: `bun test` (Jest-compatible, Jest config support)
- Very fast test execution
- Missing: REPL (inhibits interactive testing/debugging workflow)

**Bundler:**
- Built-in: `bun build` (zero config, hot reload dev server)
- Single-command frontend builds; no Webpack/Vite config files

**DX Win:** Fastest installation, no tool choice paralysis, .env auto-loading
**Pain Point:** Workspace resolution issues (duplicated dependencies in monorepos), native module errors cryptic, Windows support lagging

**Verdict:** Deno (complete built-in toolkit, zero external tool burden) > Bun (fast but ecosystem gaps) > Node.js (requires gluing tools together)

---

## 3. Security Model

### Node.js
- **Default:** Permissive—all code has full access to filesystem, network, environment
- **Recent Addition:** Node 20+ permission model (flag-based), but not default-enabled, adoption low
- **Trade-off:** Matches historical behavior, no breaking changes; developers must opt-in to restrictions

### Deno
- **Default:** Restrictive sandbox—all code runs with NO file, network, or env access by default
- **Explicit Permissions:** Must grant via CLI flags (`--allow-read`, `--allow-net`, `--allow-env`) or deno.json
- **DX Impact:** Developers are forced to reason about capabilities their code needs—higher upfront friction but better security hygiene
- **Dependency Safety:** Untrusted npm packages cannot silently exfiltrate data; all access is logged/explicit

**Security-First Advantage:** Eliminates supply-chain attacks via package compromise (code cannot access more than declared)

### Bun
- **Default:** Permissive (mirrors Node.js)
- **Security Story:** Lagging; no equivalent sandbox model
- **Path:** Bun roadmap mentions permission controls (not yet shipped)

**Verdict:** Deno >> Node.js (with v20 permissions) > Bun for security-first development

---

## 4. Debugging Ergonomics

### Node.js
- **Debugger:** `node --inspect` → Chrome DevTools (v8 Inspector Protocol)
- **Features:** Full breakpoints, step-through, memory profiling, async stack traces, source maps for TypeScript
- **Maturity:** Production-proven, thousands of Stack Overflow guides
- **Ergonomics:** Familiar to frontend developers; visual debugging with browser-like DevTools
- **Pain Point:** External dependency on Chrome/Chromium; VSCode debugger config required for IDE integration

### Deno
- **Debugger:** `deno run --inspect-brk file.ts` → Chrome DevTools
- **Features:** Parity with Node.js (same V8 engine initially, though Deno plans to shift away)
- **Ergonomics:** Works similarly to Node.js, but less documented (475k SO questions for Node vs. 1.1k for Deno)
- **Pain Point:** Smaller community support; issues take longer to resolve

### Bun
- **Debugger:** `bun --inspect script.ts` → WebKit Inspector (debug.bun.sh web interface)
- **Known Issues:**
  - Debugger statements ignored in some scenarios (requires `debugger` in infinite loop or setInterval workaround)
  - IDE integration (VSCode) has breakpoint failures
  - Inspector can appear empty; source code not visible in inspector
  - Profiler available but ergonomics rough
- **Maturity:** Early; debugging infrastructure present but sharp edges
- **Ergonomics:** Visual debugger exists, but reliability lower than Node.js/Deno

**Verdict:** Node.js (most polished, largest support base) ≥ Deno (same tooling, less documentation) >> Bun (functional but unreliable)

---

## 5. Onboarding Friction & Ecosystem Maturity

### Node.js
**Ecosystem Maturity:**
- **475,028** Stack Overflow questions (40x Deno, 1800x Bun)
- npm registry: 1M+ packages, 30+ years of industrial use
- Production-proven: Google, Microsoft, Airbnb, Netflix (all major corporations)
- Hiring pool: Largest JavaScript runtime community

**Onboarding Friction:**
- **High Initial:** Must choose and configure:
  - Package manager (npm, yarn, pnpm, bun)
  - Test framework (Jest, Vitest, Mocha)
  - Bundler (Webpack, Vite, ESBuild)
  - Linter (ESLint)
  - Formatter (Prettier)
  - TypeScript setup (tsconfig.json)
- **Learning Curve:** 3-5 hours for new developers to get "correct" setup
- **Benefit:** Maximum customization once over the hump

### Deno
**Ecosystem Maturity:**
- **1,105** Stack Overflow questions (small, but growing)
- Two registries: JSR (new, Deno-native) + npm: specifiers (2.0+)
- JSR ecosystem immature (pre-JSR Deno libraries not auto-compatible)
- Hiring pool: Niche; fewer Deno specialists on market

**Onboarding Friction:**
- **Low Initial:** Single `deno.json` file, CLI flags only
- **Built-in Everything:** No tool selection paralysis
- **Learning Curve:** 30 minutes for new developers
- **Pain Point:** npm package compatibility issues (native bindings, postinstall scripts) can burn hours debugging
- **Trade-off:** Fast initial setup, slower integration with legacy npm packages

### Bun
**Ecosystem Maturity:**
- **264** Stack Overflow questions (smallest, but rapidly growing)
- npm-compatible (95-99% as of v1.1); no separate registry
- Hiring pool: Emerging; fewer Bun specialists available
- Production use growing (2026 migration stories appearing)

**Onboarding Friction:**
- **Low Initial:** Single binary, `npm` → `bun` direct drop-in
- **DX Win:** Fastest package installation (20-40x npm), .env auto-loaded
- **Pain Points for Complex Apps:**
  - Native module gaps (bcrypt, sharp) require workarounds
  - Workspace monorepo resolution issues (duplicated React, etc.)
  - Windows support immature
  - Debugging unreliable (see §4)
- **Learning Curve:** 15 minutes for Node.js developers, but 3-5 hours debugging compatibility issues for complex codebases

**Hiring Maturity:**
- Node.js: Largest talent pool
- Deno: Growing niche
- Bun: Frontier skill (2026 early-adopter phase)

**Verdict on Friction:** Bun/Deno (lowest initial onboarding) > Node.js (steep setup, but known path)

**Verdict on Ecosystem Maturity:** Node.js (industrial-grade, 30+ years) >> Deno (modern, growing) > Bun (emerging, production-ready but green)

---

## 6. Notable DX Wins & Pain Points Summary

### Node.js

**Wins:**
- Native TS execution (v22.18+)
- Largest community, most documentation
- Proven in production at scale (Fortune 500 companies)
- Chrome DevTools debugging with full ecosystem support
- Project Corsa (10x TypeScript compilation speedup mid-2026)

**Pain Points:**
- Tool selection paralysis (bundler, test runner, linter, formatter)
- Configuration burden (5+ files: tsconfig.json, .eslintrc, etc.)
- Dual CJS/ESM module system complexity
- Native module ecosystem requires C++ build tooling

### Deno

**Wins:**
- Zero-config TypeScript (best native support)
- Complete built-in toolkit (test, lint, format, bundle, audit)
- Security-first sandbox model (prevents supply-chain attacks)
- npm compatibility (v2.0) removes biggest adoption blocker
- Single deno.json file for all config

**Pain Points:**
- npm package incompatibility for native/postinstall-heavy packages
- JSR ecosystem immature (pre-JSR Deno libraries legacy)
- Smaller community (1.1k SO questions; issues resolve slower)
- Deployment support lagging compared to Node.js (fewer hosting providers)

### Bun

**Wins:**
- **Fastest package installation** (20-40x npm)
- Simplest all-in-one binary (no tool selection)
- Direct drop-in npm replacement (no lock-in)
- Auto .env file loading (no dotenv setup)
- Instant transpilation (5ms startup vs 25ms Node.js)
- Cost savings in serverless (Lambda execution time -35%)
- Native SQLite integration

**Pain Points:**
- Debugging unreliable (inspector empty, debugger statements ignored, breakpoints fail in VSCode)
- Native module gaps (bcrypt, sharp, node-canvas fail)
- Workspace resolution broken (duplicated dependencies in monorepos)
- Windows support lagging (Linux/Mac first)
- Type-checking optional, requires separate tsc invocation
- Smaller hiring pool (264 SO questions; fewer community solutions)
- Large codebase migration risks (workspace + native module edge cases)

---

## 7. Synthesis & Recommendation Framework

### Choose Node.js if:
- **Enterprise/Scale:** Production code running at scale, stability paramount
- **Hiring:** Need to hire from largest talent pool
- **Ecosystem Breadth:** Require maximum npm package variety
- **DevOps Support:** Hosting/deployment infrastructure widely available
- **Trade-off Accept:** Willing to invest in tool setup/configuration
- **Timeline:** Existing projects; switching cost prohibitive

### Choose Deno if:
- **Greenfield Projects:** New backend, no legacy npm dependencies
- **Security-First:** Supply-chain attacks (package compromise) are threat model
- **Developer Velocity:** Prefer zero-config development over ecosystem breadth
- **Hiring Pool:** Can onboard developers from Go/Python backgrounds (similar security philosophy)
- **TypeScript-First:** All backend code in TypeScript (not mixed TS/JS)
- **Modern Stack:** Comfortable with young ecosystem, rapid iteration acceptable

### Choose Bun if:
- **Performance-Critical:** Need maximum throughput (52k+ req/sec vs 13k Node.js)
- **Serverless/FaaS:** Lambda cost reduction (-35%) or other per-second billing models
- **Green Code:** New projects with minimal native dependencies (no bcrypt, sharp, etc.)
- **Fast Iteration:** Development speed paramount, testing critical
- **Monorepo Risk Accept:** Can work around workspace + dependency dedup issues
- **Platform Support:** Linux/Mac only (Windows support lagging); CI/CD on Unix

---

## Onboarding Time Estimate (First Productive Hour)

| Runtime | Initial Setup | First Working App | Debugging First Error | Total |
|---------|---------------|-------------------|----------------------|-------|
| **Node.js** | 30 min (tool choice) | 30 min (config) | 30 min (SO search) | **90 min** |
| **Deno** | 5 min (deno.json) | 10 min (deno run) | 20 min (smaller docs) | **35 min** |
| **Bun** | 2 min (bun init) | 5 min (bun run) | 10 min (fast feedback) | **17 min** |

**Caveats:**
- Node.js time drops to 30 min with experienced dev + project template
- Deno time increases 3x+ if npm package compatibility issues surface
- Bun time increases 5x+ for native module edge cases (bcrypt, sharp)

---

## Performance Benchmarks (2026 Data)

| Operation | Node.js | Deno | Bun |
|-----------|---------|------|-----|
| HTTP Throughput | 13k req/sec | 22k req/sec | **52k req/sec** |
| Database (SQLite) | 21.29 queries/sec | 43.50 | **81.37** |
| Startup Time | 25ms | ~25ms | **5ms** |
| Package Install | baseline (npm) | baseline | **20-40x faster** |
| TypeScript Compilation | 77.8s (TS 6.x) | N/A (no separate step) | instant (no type-check) |
| React SSR | ~29k req/sec | ~29k req/sec | **~68k req/sec** |

---

## 2026 Trajectory & Predictions

### Node.js
- Project Corsa (Go compiler) ships mid-2026 → 10x TypeScript compilation speedup
- Deprecation: AMD/UMD/SystemJS removal in TS 7.0; ES modules standardization
- Adoption: Continues to dominate enterprise; incremental improvements (not revolutionary)

### Deno
- npm compatibility (v2.0) is major inflection point; migration path now clear
- Planned: Shift away from V8 to own JS engine (post-2026)
- Adoption: Growing rapidly in new greenfield projects; enterprise adoption slow

### Bun
- Maturation phase: Debugging, Windows support, native module compatibility in focus
- Serverless adoption accelerating (cost savings + performance)
- Adoption: Early majority phase; large codebases still risky, small/medium projects increasingly viable

---

## Key Artifacts & Sources

- [State of TypeScript 2026](https://devnewsletter.com/p/state-of-typescript-2026/)
- [Better Stack: Node.js vs Deno vs Bun](https://betterstack.com/community/guides/scaling-nodejs/nodejs-vs-deno-vs-bun/)
- [Snyk Runtime Comparison](https://snyk.io/blog/javascript-runtime-compare-node-deno-bun/)
- [Bun Docs: Debugger](https://bun.com/docs/runtime/debugger)
- [Node.js Debugging Guide](https://nodejs.org/en/learn/getting-started/debugging)
- [Deno 2.0: npm Compatibility](https://deno.com/blog/package-json-support)

---

*Scout report compiled: 2026-03-07*
*Researcher: helper-process (goal-orchestrator sub-process)*
*Task:** Research and document developer experience across Node.js, Deno, Bun runtimes
