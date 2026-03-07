# cognitive-lens UI Design System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the design system from `docs/ui/run-inspector.html` into a Lit web component library with Storybook, exportable as `cognitive-lens-ui`.

**Architecture:** Lit 3 web components with shadow DOM encapsulation. Shared design tokens via CSS custom properties adopted through a `LensElement` base class. Storybook 8 with `@storybook/web-components-vite` for component development. Vite library-mode build for distribution.

**Tech Stack:** Lit 3, Vite 6, Storybook 8, TypeScript 5.8, Tailwind CSS 4

---

## Phase 1: Project Scaffold

### Task 1: Initialize package and install dependencies

**Files:**
- Create: `cognitive-lens-ui/package.json`
- Create: `cognitive-lens-ui/tsconfig.json`
- Create: `cognitive-lens-ui/vite.config.ts`

**Step 1: Create project directory and package.json**

```bash
mkdir -p cognitive-lens-ui
cd cognitive-lens-ui
```

```json
{
  "name": "cognitive-lens-ui",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./tokens.css": "./dist/tokens.css"
  },
  "files": ["dist"],
  "scripts": {
    "dev": "vite",
    "build": "vite build && tsc --emitDeclarationOnly",
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build"
  },
  "dependencies": {
    "lit": "^3.2.0"
  },
  "devDependencies": {
    "@storybook/addon-essentials": "^8.6.0",
    "@storybook/web-components": "^8.6.0",
    "@storybook/web-components-vite": "^8.6.0",
    "storybook": "^8.6.0",
    "typescript": "^5.8.0",
    "vite": "^6.2.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "declaration": true,
    "declarationDir": "dist",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "useDefineForClassFields": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.stories.ts"]
}
```

**Step 3: Create vite.config.ts**

```ts
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["lit", "lit/decorators.js", "lit/directives/class-map.js", "lit/directives/style-map.js"],
    },
  },
});
```

**Step 4: Install dependencies**

```bash
cd cognitive-lens-ui && npm install
```

**Step 5: Commit**

```bash
git add cognitive-lens-ui/package.json cognitive-lens-ui/tsconfig.json cognitive-lens-ui/vite.config.ts cognitive-lens-ui/package-lock.json
git commit -m "feat(lens-ui): scaffold project with Lit, Vite, Storybook"
```

---

### Task 2: Set up Storybook with dark theme

**Files:**
- Create: `cognitive-lens-ui/.storybook/main.ts`
- Create: `cognitive-lens-ui/.storybook/preview.ts`
- Create: `cognitive-lens-ui/.storybook/theme.ts`

**Step 1: Create .storybook/main.ts**

```ts
import type { StorybookConfig } from "@storybook/web-components-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.ts"],
  addons: ["@storybook/addon-essentials"],
  framework: {
    name: "@storybook/web-components-vite",
    options: {},
  },
};

export default config;
```

**Step 2: Create .storybook/theme.ts**

```ts
import { create } from "storybook/theming";

export default create({
  base: "dark",
  brandTitle: "cognitive-lens",
  brandUrl: "#",

  // Colors
  colorPrimary: "#00ff88",
  colorSecondary: "#00ff88",

  // UI
  appBg: "#050505",
  appContentBg: "#000000",
  appPreviewBg: "#000000",
  appBorderColor: "#1a1a1a",
  appBorderRadius: 2,

  // Text
  textColor: "#e0e0e0",
  textInverseColor: "#000000",
  textMutedColor: "#707070",

  // Toolbar
  barTextColor: "#707070",
  barSelectedColor: "#00ff88",
  barHoverColor: "#00ff88",
  barBg: "#050505",

  // Form
  inputBg: "#0a0a0a",
  inputBorder: "#1a1a1a",
  inputTextColor: "#e0e0e0",
  inputBorderRadius: 2,

  // Font
  fontBase: "'DM Sans', system-ui, sans-serif",
  fontCode: "'IBM Plex Mono', monospace",
});
```

**Step 3: Create .storybook/preview.ts**

```ts
import type { Preview } from "@storybook/web-components";
import theme from "./theme";
import "../src/tokens/tokens.css";

const preview: Preview = {
  parameters: {
    docs: { theme },
    backgrounds: {
      default: "lens-root",
      values: [
        { name: "lens-root", value: "#000000" },
        { name: "lens-panel", value: "#050505" },
        { name: "lens-surface", value: "#0a0a0a" },
      ],
    },
    layout: "centered",
  },
};

export default preview;
```

**Step 4: Verify Storybook starts**

```bash
cd cognitive-lens-ui && npx storybook dev -p 6006
```

Expected: Storybook opens at http://localhost:6006 with dark theme, no stories yet.

**Step 5: Commit**

```bash
git add cognitive-lens-ui/.storybook/
git commit -m "feat(lens-ui): configure Storybook 8 with dark theme"
```

---

### Task 3: Create design tokens and LensElement base class

**Files:**
- Create: `cognitive-lens-ui/src/tokens/tokens.css`
- Create: `cognitive-lens-ui/src/tokens/base.ts`
- Create: `cognitive-lens-ui/src/index.ts`

**Step 1: Create tokens.css**

Extract all CSS custom properties from `docs/ui/run-inspector.html` lines 13-60, plus the base reset styles (scrollbar, selection, font loading). This is the standalone token file consumers can import.

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=DM+Sans:wght@400;500;600&display=swap');

:host, :root {
  /* Background scale */
  --lens-bg-root: #000000;
  --lens-bg-panel: #050505;
  --lens-bg-surface: #0a0a0a;
  --lens-bg-elevated: #111111;
  --lens-bg-hover: #1a1a1a;
  --lens-bg-active: #0d1f14;

  /* Borders */
  --lens-border: #1a1a1a;
  --lens-border-bright: #2a2a2a;

  /* Accent */
  --lens-accent: #00ff88;
  --lens-accent-dim: rgba(0,255,136,0.15);
  --lens-accent-glow: rgba(0,255,136,0.06);

  /* Text */
  --lens-text: #e0e0e0;
  --lens-text-secondary: #707070;
  --lens-text-dim: #484848;

  /* Status colors */
  --lens-green: #00ff88;
  --lens-green-dim: #0a3d22;
  --lens-amber: #ffb020;
  --lens-amber-dim: #3d2e0a;
  --lens-cyan: #00d4ff;
  --lens-cyan-dim: #0a2a3d;
  --lens-magenta: #ff44cc;
  --lens-magenta-dim: #3d0a2e;
  --lens-red: #ff4444;
  --lens-red-dim: #3d0a0a;
  --lens-blue: #4488ff;
  --lens-blue-dim: #0a1a3d;
  --lens-gray: #555555;
  --lens-gray-dim: #1a1a1a;

  /* Typography */
  --lens-font-mono: 'IBM Plex Mono', 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  --lens-font-sans: 'DM Sans', system-ui, -apple-system, sans-serif;

  /* Layout */
  --lens-topbar-h: 40px;
  --lens-bottombar-h: 32px;
  --lens-sidebar-w: 280px;
  --lens-rightpanel-w: 360px;
  --lens-narrative-h: 36px;

  /* Radius */
  --lens-radius-sm: 2px;
  --lens-radius-md: 4px;

  /* Transitions */
  --lens-transition-fast: 150ms ease;
  --lens-transition-med: 200ms ease;
}
```

**Step 2: Create base.ts — LensElement base class**

```ts
import { LitElement, css, CSSResultGroup } from "lit";

// Shared base styles adopted by every lens component
export const lensBaseStyles = css`
  :host {
    box-sizing: border-box;
    font-family: var(--lens-font-sans);
    font-size: 13px;
    line-height: 1.4;
    color: var(--lens-text);
    -webkit-font-smoothing: antialiased;
  }

  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  ::selection {
    background: var(--lens-accent-dim);
    color: var(--lens-accent);
  }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #222; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #333; }

  *:focus-visible {
    outline: 1px solid var(--lens-accent);
    outline-offset: 1px;
  }
`;

/**
 * Base class for all lens components.
 * Adopts shared token styles + base reset.
 */
export class LensElement extends LitElement {
  static styles: CSSResultGroup = [lensBaseStyles];
}
```

**Step 3: Create barrel index.ts**

```ts
// Tokens
export { LensElement, lensBaseStyles } from "./tokens/base.js";

// (components will be added as they're built)
```

**Step 4: Commit**

```bash
git add cognitive-lens-ui/src/
git commit -m "feat(lens-ui): add design tokens and LensElement base class"
```

---

### Task 4: Create mock data factories

**Files:**
- Create: `cognitive-lens-ui/src/mock/factories.ts`
- Create: `cognitive-lens-ui/src/mock/types.ts`

**Step 1: Create types.ts — the UI-facing types (copied from lens types, no kernel imports)**

```ts
export type ProcessState = "running" | "sleeping" | "idle" | "dead" | "checkpoint" | "suspended";
export type ProcessRole = "kernel" | "sub-kernel" | "worker" | "shell";
export type ProcessType = "lifecycle" | "daemon" | "event";
export type TerminalLevel = "system" | "info" | "thinking" | "tool" | "output" | "error";
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
export type RunStatus = "running" | "completed" | "failed" | "paused" | "canceled";

export interface LensProcess {
  pid: string;
  name: string;
  type: ProcessType;
  state: ProcessState;
  role: ProcessRole;
  parentPid: string | null;
  children: string[];
  objective: string;
  priority: number;
  tickCount: number;
  tokensUsed: number;
  tokenBudget: number | null;
  model: string;
  spawnedAt: string;
  lastActiveAt: string;
  exitCode?: number;
  exitReason?: string;
  checkpoint?: { reason: string; savedAt: string };
}

export interface LensMetrics {
  totalTokens: number;
  tokenRate: number;
  processCount: number;
  runningCount: number;
  sleepingCount: number;
  deadCount: number;
  wallTimeElapsedMs: number;
  tickCount: number;
}

export interface LensBBEntry {
  key: string;
  value: unknown;
  writer: string;
  readBy: string[];
}

export interface LensHeuristic {
  id: string;
  heuristic: string;
  confidence: number;
  context: string;
  scope: "global" | "local";
  reinforcementCount: number;
}

export interface LensDeferral {
  id: string;
  name: string;
  conditionType: string;
  conditionKey: string;
  waitedTicks: number;
  reason: string;
}

export interface LensTerminalLine {
  seq: number;
  timestamp: string;
  pid: string;
  processName: string;
  level: TerminalLevel;
  text: string;
}

export interface LensEvent {
  action: string;
  status: string;
  timestamp: string;
  agentName?: string;
  message: string;
}

export interface LensDagNode {
  pid: string;
  name: string;
  type: ProcessType;
  state: ProcessState;
  role: ProcessRole;
  priority: number;
  parentPid: string | null;
}

export interface LensDagEdge {
  from: string;
  to: string;
  relation: "parent-child" | "dependency";
  label?: string;
}

export interface LensRun {
  id: string;
  status: RunStatus;
  goal: string;
  createdAt: string;
  elapsed: number;
}

export interface LensSnapshot {
  runId: string;
  tick: number;
  goal: string;
  elapsed: number;
  processes: LensProcess[];
  dag: { nodes: LensDagNode[]; edges: LensDagEdge[] };
  blackboard: Record<string, LensBBEntry>;
  heuristics: LensHeuristic[];
  deferrals: LensDeferral[];
  metrics: LensMetrics;
}
```

**Step 2: Create factories.ts — realistic mock data generators from prototype**

Translate the `MOCK_*` constants from `docs/ui/run-inspector.html` (lines 1723-1900) into factory functions. Keep the same realistic data. Include `mockSnapshot()` that assembles a full snapshot.

```ts
import type {
  LensProcess, LensMetrics, LensBBEntry, LensHeuristic,
  LensDeferral, LensTerminalLine, LensEvent, LensDagNode,
  LensDagEdge, LensRun, LensSnapshot,
} from "./types.js";

export function mockProcesses(): LensProcess[] {
  return [
    {
      pid: "proc-metacog-001", type: "daemon", state: "running", name: "metacog",
      parentPid: null, role: "kernel",
      objective: "Orchestrate implementation of JWT authentication system.",
      priority: 100, tickCount: 42, tokensUsed: 3247, tokenBudget: 50000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 175000).toISOString(),
      lastActiveAt: new Date(Date.now() - 3000).toISOString(),
      children: ["proc-arch-002", "proc-impl-003", "proc-test-006"],
    },
    {
      pid: "proc-arch-002", type: "lifecycle", state: "dead", name: "architect",
      parentPid: "proc-metacog-001", role: "worker",
      objective: "Design the authentication system architecture.",
      priority: 90, tickCount: 15, tokensUsed: 4521, tokenBudget: null,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 170000).toISOString(),
      lastActiveAt: new Date(Date.now() - 120000).toISOString(),
      children: [], exitCode: 0, exitReason: "Architecture design committed to blackboard",
    },
    {
      pid: "proc-impl-003", type: "lifecycle", state: "running", name: "implementer",
      parentPid: "proc-metacog-001", role: "sub-kernel",
      objective: "Implement the authentication system based on the architecture.",
      priority: 80, tickCount: 28, tokensUsed: 8932, tokenBudget: 20000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 115000).toISOString(),
      lastActiveAt: new Date(Date.now() - 5000).toISOString(),
      children: ["proc-jwt-004", "proc-middleware-005"],
    },
    {
      pid: "proc-jwt-004", type: "lifecycle", state: "checkpoint", name: "jwt-handler",
      parentPid: "proc-impl-003", role: "worker",
      objective: "Implement JWT token generation and refresh rotation.",
      priority: 75, tickCount: 18, tokensUsed: 5200, tokenBudget: 8000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 100000).toISOString(),
      lastActiveAt: new Date(Date.now() - 30000).toISOString(),
      children: [],
      checkpoint: { reason: "Paused for test validation", savedAt: new Date(Date.now() - 30000).toISOString() },
    },
    {
      pid: "proc-middleware-005", type: "lifecycle", state: "running", name: "auth-middleware",
      parentPid: "proc-impl-003", role: "worker",
      objective: "Implement Express middleware for JWT validation and RBAC.",
      priority: 70, tickCount: 12, tokensUsed: 3100, tokenBudget: 6000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 80000).toISOString(),
      lastActiveAt: new Date(Date.now() - 8000).toISOString(),
      children: [],
    },
    {
      pid: "proc-test-006", type: "lifecycle", state: "sleeping", name: "test-writer",
      parentPid: "proc-metacog-001", role: "worker",
      objective: "Write comprehensive tests for the authentication system.",
      priority: 60, tickCount: 8, tokensUsed: 2100, tokenBudget: 10000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 110000).toISOString(),
      lastActiveAt: new Date(Date.now() - 45000).toISOString(),
      children: [],
    },
  ];
}

export function mockEdges(): LensDagEdge[] {
  return [
    { from: "proc-metacog-001", to: "proc-arch-002", relation: "parent-child" },
    { from: "proc-metacog-001", to: "proc-impl-003", relation: "parent-child" },
    { from: "proc-metacog-001", to: "proc-test-006", relation: "parent-child" },
    { from: "proc-impl-003", to: "proc-jwt-004", relation: "parent-child" },
    { from: "proc-impl-003", to: "proc-middleware-005", relation: "parent-child" },
    { from: "proc-arch-002", to: "proc-impl-003", relation: "dependency", label: "architecture design" },
    { from: "proc-jwt-004", to: "proc-test-006", relation: "dependency", label: "jwt module ready" },
  ];
}

export function mockDagNodes(): LensDagNode[] {
  return mockProcesses().map(p => ({
    pid: p.pid, name: p.name, type: p.type, state: p.state,
    role: p.role, priority: p.priority, parentPid: p.parentPid,
  }));
}

export function mockBlackboard(): Record<string, LensBBEntry> {
  return {
    "auth.architecture": { key: "auth.architecture", value: { jwt_strategy: "RS256", refresh: "rotation", middleware: "express" }, writer: "architect", readBy: ["implementer"] },
    "auth.jwt_structure": { key: "auth.jwt_structure", value: { header: { alg: "RS256", typ: "JWT" }, expiry: "15m", refreshExpiry: "7d" }, writer: "architect", readBy: ["jwt-handler"] },
    "auth.middleware_plan": { key: "auth.middleware_plan", value: { layers: ["token-extraction", "validation", "role-check"] }, writer: "architect", readBy: ["auth-middleware"] },
    "auth.jwt_module_status": { key: "auth.jwt_module_status", value: "implementation_complete_pending_review", writer: "jwt-handler", readBy: ["test-writer"] },
    "auth.token_schema": { key: "auth.token_schema", value: { accessToken: "string", refreshToken: "string", expiresIn: "number" }, writer: "jwt-handler", readBy: [] },
    "auth.middleware_progress": { key: "auth.middleware_progress", value: "80%", writer: "auth-middleware", readBy: ["metacog"] },
  };
}

export function mockHeuristics(): LensHeuristic[] {
  return [
    { id: "h-001", heuristic: "Spawn architect before implementer to establish design constraints", confidence: 0.89, context: "multi-module implementation", scope: "global", reinforcementCount: 3 },
    { id: "h-002", heuristic: "Checkpoint long-running processes before cross-process validation", confidence: 0.76, context: "test-driven workflows", scope: "local", reinforcementCount: 1 },
    { id: "h-003", heuristic: "Serialize final two agents when running 3+ parallel implementations", confidence: 0.64, context: "parallel implementation", scope: "global", reinforcementCount: 2 },
  ];
}

export function mockDeferrals(): LensDeferral[] {
  return [
    { id: "defer-001", name: "test-writer", conditionType: "blackboard_key_exists", conditionKey: "auth.jwt_module_status", waitedTicks: 14, reason: "Waiting for JWT module implementation to complete before writing tests" },
  ];
}

export function mockMetrics(): LensMetrics {
  return {
    totalTokens: 27101, tokenRate: 48, processCount: 6,
    runningCount: 3, sleepingCount: 1, deadCount: 1,
    wallTimeElapsedMs: 178000, tickCount: 42,
  };
}

export function mockEvents(): LensEvent[] {
  return [
    { action: "tick", status: "completed", timestamp: new Date(Date.now() - 3000).toISOString(), message: "tick=42 active=3 sleeping=1 dead=1 checkpointed=1" },
    { action: "llm", status: "started", timestamp: new Date(Date.now() - 4500).toISOString(), agentName: "auth-middleware", message: "Now I need to implement the role-based access control check..." },
    { action: "command", status: "completed", timestamp: new Date(Date.now() - 8000).toISOString(), agentName: "implementer", message: "write_blackboard: auth.middleware_progress = 80%" },
    { action: "checkpoint", status: "completed", timestamp: new Date(Date.now() - 30000).toISOString(), agentName: "jwt-handler", message: "Checkpoint created: waiting for test validation" },
    { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 80000).toISOString(), agentName: "implementer", message: "Spawned auth-middleware (proc-middleware-005)" },
    { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 100000).toISOString(), agentName: "implementer", message: "Spawned jwt-handler (proc-jwt-004)" },
    { action: "exit", status: "completed", timestamp: new Date(Date.now() - 120000).toISOString(), agentName: "architect", message: "Process exited with code 0" },
    { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 170000).toISOString(), agentName: "metacog", message: "Spawned architect (proc-arch-002)" },
  ];
}

export function mockTerminalLines(): LensTerminalLine[] {
  return [
    { seq: 1, timestamp: new Date(Date.now() - 175000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "system", text: "Process spawned: metacog (daemon, priority=100)" },
    { seq: 2, timestamp: new Date(Date.now() - 174000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "info", text: "Goal: Implement authentication system with JWT tokens" },
    { seq: 3, timestamp: new Date(Date.now() - 173000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "thinking", text: "I need to break this into phases: 1) architecture, 2) implementation, 3) testing." },
    { seq: 4, timestamp: new Date(Date.now() - 170000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "tool", text: "os_spawn: architect (proc-arch-002)" },
    { seq: 5, timestamp: new Date(Date.now() - 120000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "output", text: "Architect exited [0]. Architecture committed to blackboard." },
    { seq: 6, timestamp: new Date(Date.now() - 8000).toISOString(), pid: "proc-middleware-005", processName: "auth-middleware", level: "error", text: "TypeError: Cannot read property 'role' of undefined" },
  ];
}

export function mockRuns(): LensRun[] {
  return [
    { id: "b54ef6df", status: "running", goal: "Implement authentication system with JWT tokens and refresh flow", createdAt: new Date(Date.now() - 180000).toISOString(), elapsed: 178000 },
    { id: "a3c91f02", status: "completed", goal: "Set up database schema and migrations for user management", createdAt: new Date(Date.now() - 3600000).toISOString(), elapsed: 298000 },
    { id: "ff120e45", status: "failed", goal: "Refactor entire codebase to use dependency injection", createdAt: new Date(Date.now() - 7200000).toISOString(), elapsed: 200000 },
  ];
}

export function mockSnapshot(): LensSnapshot {
  const procs = mockProcesses();
  return {
    runId: "b54ef6df",
    tick: 42,
    goal: "Implement authentication system with JWT tokens and refresh flow",
    elapsed: 178000,
    processes: procs,
    dag: { nodes: mockDagNodes(), edges: mockEdges() },
    blackboard: mockBlackboard(),
    heuristics: mockHeuristics(),
    deferrals: mockDeferrals(),
    metrics: mockMetrics(),
  };
}
```

**Step 3: Commit**

```bash
git add cognitive-lens-ui/src/mock/
git commit -m "feat(lens-ui): add mock data types and factories"
```

---

## Phase 2: Primitives

### Task 5: Badge component

**Files:**
- Create: `cognitive-lens-ui/src/primitives/badge.ts`
- Create: `cognitive-lens-ui/src/primitives/badge.stories.ts`

**Step 1: Create badge.ts**

Two badge types: state badge (running/sleeping/dead/etc with color dot) and role badge (kernel/sub-kernel/worker/shell with colored background).

```ts
import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { ProcessState, ProcessRole } from "../mock/types.js";

const stateColors: Record<ProcessState, string> = {
  running: "var(--lens-green)",
  sleeping: "var(--lens-amber)",
  idle: "var(--lens-amber)",
  dead: "var(--lens-gray)",
  checkpoint: "var(--lens-blue)",
  suspended: "var(--lens-red)",
};

const stateDimColors: Record<ProcessState, string> = {
  running: "var(--lens-green-dim)",
  sleeping: "var(--lens-amber-dim)",
  idle: "var(--lens-amber-dim)",
  dead: "var(--lens-gray-dim)",
  checkpoint: "var(--lens-blue-dim)",
  suspended: "var(--lens-red-dim)",
};

const roleColors: Record<ProcessRole, { color: string; bg: string; border: string }> = {
  kernel: { color: "var(--lens-accent)", bg: "var(--lens-accent-dim)", border: "rgba(0,255,136,0.15)" },
  "sub-kernel": { color: "var(--lens-cyan)", bg: "var(--lens-cyan-dim)", border: "rgba(0,212,255,0.15)" },
  worker: { color: "var(--lens-text-secondary)", bg: "var(--lens-bg-elevated)", border: "var(--lens-border)" },
  shell: { color: "var(--lens-text-secondary)", bg: "var(--lens-gray-dim)", border: "var(--lens-border)" },
};

@customElement("lens-badge")
export class LensBadge extends LensElement {
  static styles = [
    lensBaseStyles,
    css`
      :host { display: inline-flex; }

      .state-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: var(--lens-radius-sm);
      }

      .state-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .state-dot.running {
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .role-badge {
        font-family: var(--lens-font-mono);
        font-size: 9px;
        padding: 1px 5px;
        letter-spacing: 0.3px;
        font-weight: 500;
        border-width: 1px;
        border-style: solid;
      }
    `,
  ];

  @property() variant: "state" | "role" = "state";
  @property() state?: ProcessState;
  @property() role?: ProcessRole;

  render() {
    if (this.variant === "role" && this.role) {
      const c = roleColors[this.role];
      return html`<span class="role-badge" style="color:${c.color};background:${c.bg};border-color:${c.border}">${this.role}</span>`;
    }

    if (this.state) {
      const color = stateColors[this.state];
      const bg = stateDimColors[this.state];
      const glow = this.state === "running" ? `box-shadow: 0 0 4px ${color}` : "";
      return html`
        <span class="state-badge" style="color:${color};background:${bg}">
          <span class="state-dot ${this.state}" style="background:${color};${glow}"></span>
          ${this.state}
        </span>
      `;
    }

    return html`<slot></slot>`;
  }
}
```

**Step 2: Create badge.stories.ts**

```ts
import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./badge.js";

const meta: Meta = {
  title: "Primitives/Badge",
  component: "lens-badge",
  tags: ["autodocs"],
};
export default meta;

export const AllStates: StoryObj = {
  render: () => html`
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <lens-badge variant="state" state="running"></lens-badge>
      <lens-badge variant="state" state="sleeping"></lens-badge>
      <lens-badge variant="state" state="idle"></lens-badge>
      <lens-badge variant="state" state="checkpoint"></lens-badge>
      <lens-badge variant="state" state="suspended"></lens-badge>
      <lens-badge variant="state" state="dead"></lens-badge>
    </div>
  `,
};

export const AllRoles: StoryObj = {
  render: () => html`
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <lens-badge variant="role" role="kernel"></lens-badge>
      <lens-badge variant="role" role="sub-kernel"></lens-badge>
      <lens-badge variant="role" role="worker"></lens-badge>
      <lens-badge variant="role" role="shell"></lens-badge>
    </div>
  `,
};
```

**Step 3: Verify in Storybook**

Run `npx storybook dev -p 6006`, navigate to Primitives/Badge, verify all states and roles render correctly with proper colors.

**Step 4: Commit**

```bash
git add cognitive-lens-ui/src/primitives/badge*
git commit -m "feat(lens-ui): add Badge component with state and role variants"
```

---

### Task 6: Button component

**Files:**
- Create: `cognitive-lens-ui/src/primitives/button.ts`
- Create: `cognitive-lens-ui/src/primitives/button.stories.ts`

**Step 1: Create button.ts**

Variants: `filter` (sidebar filter buttons), `tab` (center/drawer tabs), `action` (send, clear), `close` (drawer close X). Extract styles from prototype lines 221-236, 307-324, 560-571, 447-461.

Use `variant` property and render appropriate styling. All buttons are minimal border-style with monospace font.

**Step 2: Create stories with all variants + active/inactive states**

**Step 3: Commit**

---

### Task 7: Input component

**Files:**
- Create: `cognitive-lens-ui/src/primitives/input.ts`
- Create: `cognitive-lens-ui/src/primitives/input.stories.ts`

**Step 1: Create input.ts**

Variants: `text` (default), `search` (bb-search style), `textarea` (message input). Extract from prototype lines 604-615, 545-559, 909-920. All have dark bg, border, monospace, accent focus ring.

**Step 2: Create stories**

**Step 3: Commit**

---

### Task 8: Panel component

**Files:**
- Create: `cognitive-lens-ui/src/primitives/panel.ts`
- Create: `cognitive-lens-ui/src/primitives/panel.stories.ts`

**Step 1: Create panel.ts**

Simple bordered container with `--lens-bg-panel` background. Slot for children. Optional `header` slot.

**Step 2: Commit**

---

### Task 9: Card component

**Files:**
- Create: `cognitive-lens-ui/src/primitives/card.ts`
- Create: `cognitive-lens-ui/src/primitives/card.stories.ts`

**Step 1: Create card.ts**

Bordered card from prototype lines 672-710 (heuristic card base). 1px border, padding 12px 16px, hover brightens border. Optional named slots for `header` and default content.

**Step 2: Commit**

---

### Task 10: Table component

**Files:**
- Create: `cognitive-lens-ui/src/primitives/table.ts`
- Create: `cognitive-lens-ui/src/primitives/table.stories.ts`

**Step 1: Create table.ts**

Monospace data table from prototype lines 1144-1176. Accepts `columns` (array of {key, label}) and `rows` (array of objects). Renders with hover rows, dim headers, border-bottom rows.

**Step 2: Commit**

---

### Task 11: Tooltip component

**Files:**
- Create: `cognitive-lens-ui/src/primitives/tooltip.ts`
- Create: `cognitive-lens-ui/src/primitives/tooltip.stories.ts`

**Step 1: Create tooltip.ts**

From prototype lines 958-976. Fixed position, monospace, dark elevated bg. Accepts `lines` property: array of `{label, value}`. Shows/hides via `open` property and `x`/`y` coordinates.

**Step 2: Commit**

---

## Phase 3: Layout Components

### Task 12: TopBar component

**Files:**
- Create: `cognitive-lens-ui/src/layout/topbar.ts`
- Create: `cognitive-lens-ui/src/layout/topbar.stories.ts`

From prototype lines 99-148. Properties: `brandName`, `runId`, `status` (ConnectionStatus), `elapsed` (string). Fires events: `run-select`.

---

### Task 13: BottomBar component

**Files:**
- Create: `cognitive-lens-ui/src/layout/bottombar.ts`
- Create: `cognitive-lens-ui/src/layout/bottombar.stories.ts`

From prototype lines 857-880. Properties: `metrics` (LensMetrics). Displays process count, running count, tokens, tick, rate.

---

### Task 14: TabBar component

**Files:**
- Create: `cognitive-lens-ui/src/layout/tabbar.ts`
- Create: `cognitive-lens-ui/src/layout/tabbar.stories.ts`

From prototype lines 300-331 and 1113-1141. Properties: `tabs` (array of {id, label}), `activeTab` (string). Fires `tab-change` event. Two variants: `center` (underline) and `drawer` (uppercase, smaller).

---

### Task 15: Sidebar component

**Files:**
- Create: `cognitive-lens-ui/src/layout/sidebar.ts`
- Create: `cognitive-lens-ui/src/layout/sidebar.stories.ts`

From prototype lines 196-291. Properties: `runs` (LensRun[]), `activeRunId`, `filter`. Displays run list with status dots, goal preview, time. Filter bar with All/Running/Done/Failed. Fires `run-select`, `filter-change`.

---

### Task 16: SplitLayout component

**Files:**
- Create: `cognitive-lens-ui/src/layout/split-layout.ts`
- Create: `cognitive-lens-ui/src/layout/split-layout.stories.ts`

From prototype lines 151-164. Light DOM component. CSS grid: `grid-template-columns: var(--lens-sidebar-w) 1fr var(--lens-rightpanel-w)`. Named slots: `sidebar`, `center`, `right`. Full viewport height.

---

## Phase 4: Domain Components

### Task 17: ConnectionBadge component

**Files:**
- Create: `cognitive-lens-ui/src/domain/connection-badge.ts`
- Create: `cognitive-lens-ui/src/domain/connection-badge.stories.ts`

From prototype lines 139-149. Properties: `status` (ConnectionStatus). Green dot + "live", amber "reconnecting", red "disconnected". Pulsing animation on connected.

---

### Task 18: NarrativeBar component

**Files:**
- Create: `cognitive-lens-ui/src/domain/narrative-bar.ts`
- Create: `cognitive-lens-ui/src/domain/narrative-bar.stories.ts`

From prototype lines 166-194. Properties: `text` (string). Displays `> ` cursor (blinking) + text with ellipsis overflow. Monospace 11px.

---

### Task 19: EventFeed component

**Files:**
- Create: `cognitive-lens-ui/src/domain/event-feed.ts`
- Create: `cognitive-lens-ui/src/domain/event-feed.stories.ts`

From prototype lines 755-855. Properties: `events` (LensEvent[]), `filters` (string[]). Renders scrolling list with time column + body. Color-coded action types (tick=dim, spawn=cyan, llm=green, command=amber, exit=gray, checkpoint=blue, error=red). Filter buttons. New event flash animation. "Jump to latest" button.

---

### Task 20: ProcessTree component

**Files:**
- Create: `cognitive-lens-ui/src/domain/process-tree.ts`
- Create: `cognitive-lens-ui/src/domain/process-tree.stories.ts`

From prototype lines 333-412. Properties: `processes` (LensProcess[]), `selectedPid` (string). Hierarchical tree view with indentation, toggle arrows, state badges, role badges, token counts. Fires `process-select`. Spawn flash animation on new nodes.

---

### Task 21: ProcessDrawer component

**Files:**
- Create: `cognitive-lens-ui/src/domain/process-drawer.ts`
- Create: `cognitive-lens-ui/src/domain/process-drawer.stories.ts`

From prototype lines 414-571. Properties: `process` (LensProcess | null), `open` (boolean). Slide-in panel with tabs: Info (metadata fields), Terminal (slot), Blackboard (table), Messages (chat bubbles + input). Token progress bar. Fires `close`, `send-message`, `expand`.

---

### Task 22: BlackboardInspector component

**Files:**
- Create: `cognitive-lens-ui/src/domain/blackboard-inspector.ts`
- Create: `cognitive-lens-ui/src/domain/blackboard-inspector.stories.ts`

From prototype lines 587-658. Properties: `entries` (Record<string, LensBBEntry>). Split view: key list (left, 260px, filterable) + value panel (right, JSON syntax highlighted). Fires `key-select`.

---

### Task 23: HeuristicCard component

**Files:**
- Create: `cognitive-lens-ui/src/domain/heuristic-card.ts`
- Create: `cognitive-lens-ui/src/domain/heuristic-card.stories.ts`

From prototype lines 666-710. Properties: `heuristic` (LensHeuristic). Confidence score badge (accent colored), heuristic text, meta row with scope badge and reinforcement count.

---

### Task 24: DeferralCard component

**Files:**
- Create: `cognitive-lens-ui/src/domain/deferral-card.ts`
- Create: `cognitive-lens-ui/src/domain/deferral-card.stories.ts`

From prototype lines 712-753. Properties: `deferral` (LensDeferral). Name (amber), condition type/key, waited ticks (red if >10 = stale), reason (italic, dim).

---

### Task 25: TerminalView component

**Files:**
- Create: `cognitive-lens-ui/src/domain/terminal-view.ts`
- Create: `cognitive-lens-ui/src/domain/terminal-view.stories.ts`

From prototype lines 1302-1433. Properties: `lines` (LensTerminalLine[]), `autoscroll` (boolean). Header with process selector (slot), autoscroll toggle, clear button. Output area with level-colored lines: system=amber, info=secondary, thinking=magenta italic, tool=cyan, output=green, error=red. Timestamp prefix. Blinking cursor prompt at end.

---

### Task 26: DAGView stub component

**Files:**
- Create: `cognitive-lens-ui/src/domain/dag-view.ts`
- Create: `cognitive-lens-ui/src/domain/dag-view.stories.ts`

Stub component — just define the property interface. Properties: `nodes` (LensDagNode[]), `edges` (LensDagEdge[]), `showDead` (boolean). Renders a canvas element + legend overlay (from prototype lines 978-1036) + controls. The actual canvas rendering is NOT reimplemented — placeholder message in the canvas area.

---

### Task 27: MetricsBar component

**Files:**
- Create: `cognitive-lens-ui/src/domain/metrics-bar.ts`
- Create: `cognitive-lens-ui/src/domain/metrics-bar.stories.ts`

Compact metric displays from the topbar status area. Properties: `metrics` (LensMetrics). Renders token count, process count, token rate as monospace 11px labels.

---

### Task 28: CommandPalette component

**Files:**
- Create: `cognitive-lens-ui/src/domain/command-palette.ts`
- Create: `cognitive-lens-ui/src/domain/command-palette.stories.ts`

From prototype lines 882-956. Properties: `open` (boolean), `suggestions` (array of {icon, label}). Overlay with backdrop blur, centered input, suggestion list. Fires `query`, `select`, `close`. Response area with typing animation.

---

### Task 29: ExpandedProcessView component

**Files:**
- Create: `cognitive-lens-ui/src/domain/expanded-view.ts`
- Create: `cognitive-lens-ui/src/domain/expanded-view.stories.ts`

From prototype lines 1190-1299. Properties: `process` (LensProcess | null), `open` (boolean). Full-screen overlay. Top bar with name + role + state badges + Esc close. Meta grid (pid, model, priority, ticks, tokens). Two-column body: terminal output (left) + blackboard I/O (right). Fires `close`.

---

## Phase 5: Compositions

### Task 30: Full Dashboard composition

**Files:**
- Create: `cognitive-lens-ui/src/compositions/dashboard.ts`
- Create: `cognitive-lens-ui/src/compositions/dashboard.stories.ts`

Light DOM component that assembles all components into the full layout from the prototype. Uses `mockSnapshot()` as default data. Layout: topbar (full width) > narrative bar (full width) > [sidebar | center (tabbar + tab content) | right panel (event feed)] > bottombar (full width).

Storybook story renders at fullscreen with `layout: 'fullscreen'` parameter.

---

## Phase 6: Finalize

### Task 31: Update barrel exports and verify build

**Files:**
- Modify: `cognitive-lens-ui/src/index.ts`

**Step 1: Add all component exports to index.ts**

Export every component class + re-export all types from `mock/types.ts` + re-export `mockSnapshot` and other factories.

**Step 2: Run build**

```bash
cd cognitive-lens-ui && npm run build
```

Expected: Clean build, dist/ contains index.js + tokens.css + type declarations.

**Step 3: Run Storybook build**

```bash
cd cognitive-lens-ui && npm run build-storybook
```

Expected: Static storybook site generated.

**Step 4: Final commit**

```bash
git add cognitive-lens-ui/
git commit -m "feat(lens-ui): complete design system with 25 components and Storybook"
```

---

## Implementation Notes

- **Prototype reference:** `docs/ui/run-inspector.html` — all CSS line numbers referenced above
- **Lens types reference:** `src/lens/types.ts` — the authoritative type definitions
- **Token prefix:** All CSS custom properties use `--lens-` prefix to avoid conflicts when embedded
- **No "cognitive kernels" branding** — only "cognitive-lens" for the package name
- **CRT overlay:** Add to the dashboard composition only (not individual components)
- **Animations:** Preserve pulse-dot, blink-cursor, tab-fade-in, node-spawn, event-flash from prototype
- **Each component must be self-contained** — import only from `../tokens/base.js` and `../mock/types.js`
