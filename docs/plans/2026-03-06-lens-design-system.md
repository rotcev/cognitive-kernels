# cognitive-lens UI Design System

## Overview

Extract the design system from `docs/ui/run-inspector.html` into a proper Lit web component library with Storybook. The package (`cognitive-lens-ui`) is framework-agnostic, embeddable via shadow DOM, and white-label ready.

## Tech Stack

- **Lit 3** — web components with shadow DOM, reactive properties
- **CSS Custom Properties** — shared token sheet adopted by all components
- **Tailwind CSS 4** — token config + utility generation for light DOM compositions
- **Storybook 8.x** — `@storybook/web-components-vite`
- **Vite** — dev server + library-mode build
- **TypeScript**

## Architecture

### Token System
- All design tokens as CSS custom properties in `tokens.css`
- Tailwind config maps to the same tokens
- Standalone `cognitive-lens.css` export for consumers who build their own components

### Component Encapsulation
- **Shadow DOM** for primitives and domain components — full encapsulation
- **Light DOM** for compositions (SplitLayout, Dashboard) — allows arbitrary children
- `LensElement` base class extends `LitElement`, adopts token stylesheet + base reset

### Design Tokens

**Colors:**
- Background: `--bg-root` (#000) through `--bg-hover` (#1a1a1a)
- Accent: `--accent` (#00ff88) with `--accent-dim`, `--accent-glow`
- Status: green, amber, cyan, magenta, red, blue, gray (each with `-dim` variant)
- Text: `--color-text` (#e0e0e0), `--color-text-secondary` (#707070), `--color-text-dim` (#484848)

**Typography:**
- Mono: IBM Plex Mono (300-600)
- Sans: DM Sans (400-600)
- Base: 13px, line-height 1.4

**Effects:**
- CRT scanline overlay
- Green glow on accents
- Custom scrollbars (6px, dark)

**Spacing:**
- Radius: 2px (sm), 4px (md)
- Transitions: 150ms fast, 200ms medium
- Layout: topbar 40px, bottombar 32px, sidebar 280px, right panel 360px

## Components (25 total)

### Primitives (7) — Shadow DOM
1. `lens-badge` — state (running/sleeping/dead/suspended/checkpoint/idle) + role (kernel/sub-kernel/worker/shell)
2. `lens-button` — variants: filter, tab, action, close
3. `lens-input` — text, search, textarea
4. `lens-panel` — bordered container
5. `lens-card` — elevated container with optional header
6. `lens-table` — monospace key/value data table
7. `lens-tooltip` — positioned tooltip with arrow

### Layout (5) — Mixed
8. `lens-topbar` — brand, run selector, status, connection, metrics
9. `lens-bottombar` — token stats, metrics, shortcuts
10. `lens-sidebar` — run/process list with filters, state dots
11. `lens-tabbar` — horizontal tabs with underline indicator
12. `lens-split-layout` — 3-column grid (light DOM)

### Domain (12) — Shadow DOM
13. `lens-process-tree` — hierarchical tree with expand/collapse, role icons, state
14. `lens-process-drawer` — slide-in panel with Info/Terminal/Blackboard/Messages tabs
15. `lens-dag-view` — canvas stub with property contract (nodes, edges, zoom/pan)
16. `lens-event-feed` — scrolling timeline with type filters, color-coded entries
17. `lens-blackboard` — key list + value panel split view with search
18. `lens-heuristic-card` — confidence bar, scope badge, reinforcement count
19. `lens-deferral-card` — condition, waited ticks, progress
20. `lens-terminal-view` — monospace output with level-colored lines
21. `lens-narrative-bar` — single-line status with typing animation
22. `lens-command-palette` — overlay input with suggestions dropdown
23. `lens-metrics-bar` — sparkline-style metric displays
24. `lens-connection-badge` — green/amber/red dot with label

### Compositions (1) — Light DOM
25. `lens-dashboard` — full assembled view with mock data

## Storybook Organization
- `Primitives/Badge`, `Primitives/Button`, etc.
- `Layout/TopBar`, `Layout/SplitLayout`, etc.
- `Domain/ProcessTree`, `Domain/EventFeed`, etc.
- `Compositions/FullDashboard`

Each story: default state, all variants, interactive controls, dark background.

## Output Structure
```
cognitive-lens-ui/
├── .storybook/           # Storybook config (dark theme)
├── src/
│   ├── tokens/           # CSS custom props, LensElement base, Tailwind config
│   ├── primitives/       # 7 components + stories
│   ├── layout/           # 5 components + stories
│   ├── domain/           # 12 components + stories
│   ├── compositions/     # Dashboard + story
│   ├── mock/             # Factory functions for test data
│   └── index.ts          # Barrel export
├── tailwind.config.ts
├── vite.config.ts
├── package.json
└── tsconfig.json
```

## Package Output
- ESM bundle via Vite library mode
- Standalone `cognitive-lens.css` tokens file
- `import { LensBadge } from 'cognitive-lens-ui'`
- `import 'cognitive-lens-ui/tokens.css'`

## Constraints
- No "cognitive kernels" branding — white-label only
- All data via properties/attributes — no self-fetching
- Dark-only design system
- Framework-agnostic — no React/Vue/Angular deps
