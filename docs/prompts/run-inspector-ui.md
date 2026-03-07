# Cognitive Kernels Run Inspector — UI Prototype Prompt

## What You Are Building

A single-file HTML/CSS/JavaScript prototype for a **run topology inspector** — a real-time dashboard for observing and interacting with autonomous multi-agent systems. This is not a generic admin panel. It is a precision instrument for understanding what a swarm of AI agents is doing, why, and how to intervene.

**This must be treated as a gift.** Every pixel matters. Every interaction should feel intentional. The quality bar is: someone sees this and wants to use it immediately, before you even explain what it does.

## The Conceptual Model You Are Visualizing

This is not a task runner. This is not a job queue. Understanding what you're looking at is essential to designing the right UI.

**The core idea**: Operating systems as cognitive architecture. The concepts we invented for managing computational processes — scheduling, IPC, memory isolation, context switching, deadlock detection — are structurally identical to what a mind does when it manages parallel trains of thought. This system treats process management itself as a form of reasoning.

**What makes it different from "agents managing agents"**:
- No single agent is "the smart one." The intelligence is in the *topology and dynamics* of how agents are composed — which agent runs when, what context flows between them, and when to halt or retry.
- The process topology is a **first-class learnable object**. The algorithm isn't running inside the process — the algorithm *is* the process management.
- Agents can introspect on their own process tree, rewrite their orchestration DAG mid-execution, recognize patterns in process history, and learn scheduling heuristics across runs.
- The metacog (root process) is the executive process — analogous to what consciousness researchers call the **Global Workspace** — it decides which sub-processes get broadcast to which others, and when.

**What this means for the UI**: The user isn't watching a pipeline execute. They're watching a *mind think*. The topology view should convey that the tree structure IS the reasoning strategy, not just a container for it. When a process spawns a child, that's a cognitive decision. When it checkpoints, that's deliberate resource management. When the DAG restructures mid-run, that's the system learning. The UI should make these dynamics legible and even beautiful — the way watching a well-orchestrated system work can be mesmerizing.

**Heuristics are memories**: The heuristics panel shows learned scheduling patterns — things like "every time I run a QA checkpoint after 3 parallel agents, the third one has merge issues — I should serialize the last two." These accumulate across runs. They represent the system getting smarter over time. Display them with the reverence they deserve — they're the closest thing this system has to wisdom.

## Design Philosophy

### Aesthetic: Terminal Meets Instrument Panel

- **Dark mode only.** True black (#000) or near-black backgrounds. Not "dark gray pretending to be dark mode."
- **Monospace typography** for data, system text, PIDs, timestamps. A clean sans-serif (Inter, system-ui) for labels and UI chrome.
- **Terminal color palette**: greens, ambers, cyans, magentas — but muted and purposeful, not garish. Status colors should feel like cockpit indicators, not christmas lights.
- **Information density is a feature**, not a problem. Power users want to see everything at once. But density must be organized — clear visual hierarchy, alignment grids, consistent spacing.
- **Subtle animations**: state transitions should be smooth but fast (150-200ms). Nothing should bounce, slide, or call attention to itself. Think: the cursor blink in a terminal.
- **No rounded corners on data containers.** Sharp edges. Thin 1px borders in muted colors. Rounded corners only on interactive elements (buttons, inputs) and keep them small (2-4px).

### UX Principles

- **Glanceable**: At a glance, you know: how many runs, which are active, any problems.
- **Drillable**: Click anything to go deeper. Process name -> process detail. Event -> full event payload.
- **Keyboard-first**: Power users navigate with keyboard. Tab between panels, arrow keys in lists, Escape to go back.
- **No dead ends**: Every view has context. You always know where you are and how to get back.

## Layout Structure

### Top Bar (Fixed, ~40px)
- Left: Product name (configurable — this will be white-labeled). Small, understated.
- Center: Current run selector (dropdown or breadcrumb showing run ID + goal snippet).
- Right: Connection status indicator (green dot = live, amber = stale, red = disconnected). Clock showing elapsed time for active run.

### Main Area (Three-Column Layout)

#### Left Sidebar (~280px, collapsible)
**Run List Panel**
- List of all runs, most recent first
- Each entry shows: status badge (colored dot), run ID (first 8 chars), goal (truncated), created time (relative, e.g. "3m ago")
- Active runs pulse subtly (not annoyingly)
- Click to select. Selected run loads in main panels.
- Status filters at top: All | Running | Completed | Failed

#### Center Panel (Flexible Width)
**Process Topology View** — the heart of the UI

This is a **tree view** showing the process hierarchy:

```
metacog                          running    1,247 tokens
  +-- repo-mapper                running      892 tokens
  |     +-- file-scanner         dead [0]     341 tokens
  |     +-- dep-analyzer         sleeping     156 tokens
  +-- test-runner                idle         445 tokens
  +-- code-writer                running    2,103 tokens
        +-- module-a-impl        running    1,200 tokens
        +-- module-b-impl        checkpoint   903 tokens
```

Each process node shows:
- **Expand/collapse** for children (animated, fast)
- **Process name** (monospace, prominent)
- **State badge**: color-coded pill (green=running, amber=sleeping/idle, blue=checkpoint, gray=dead, red=suspended)
- **Token count** (right-aligned, dimmer)
- **Priority indicator** (if non-default)
- **Elapsed time** since spawn

**On hover**: Show a tooltip with full PID, objective, model, spawn time, parent.

**On click**: Expand a **process detail drawer** (slides in from the right or expands inline) showing:
- Full objective text
- Current state + state history
- Token usage breakdown (budget vs used, as a thin progress bar)
- Children list
- Self-reports (if any)
- Blackboard keys written
- Exit code/reason (if dead)
- **Message input** (see Interjection below)

**Dependency edges**: If processes have dependency relationships (not just parent-child), show them as subtle dotted lines or a separate small panel below the tree. These matter — they represent the *flow of context* between cognitive sub-processes. A dependency edge from "architect" to "implementer" isn't just a task dependency, it's a decision about what information one train of thought needs from another.

**DAG Restructuring Indicator**: When the simulated updates change the topology (new spawn, process death, reparenting), briefly highlight the changed area with a subtle flash or pulse. The user should notice when the system is reorganizing its own thinking — that's the most interesting thing happening.

**Visual DAG View** (toggle between Tree View and DAG View with a tab or keybinding):

In addition to the text-based tree, provide a **canvas-rendered interactive directed acyclic graph**. This is where the "process topology IS the algorithm" idea becomes visceral:

- Nodes are circles or rounded rectangles, color-coded by state (same palette as tree badges)
- Parent-child edges are solid lines, dependency edges are dotted/dashed
- Edges are animated: a subtle particle/pulse flowing along the edge in the direction of data flow (parent -> child for spawns, dependency source -> dependent for context flow)
- Node size can optionally scale with token usage (larger = more tokens consumed)
- The metacog node is visually distinct — slightly larger, centered or at the top, with a subtle glow indicating it's the executive process
- **Interactive**: drag nodes to rearrange, scroll to zoom, click a node to select it (loads detail drawer same as tree view)
- **Real-time**: when a new process spawns, the node appears with a brief expansion animation. When a process dies, it fades to gray. When the DAG restructures, edges animate to their new positions.
- Layout algorithm: hierarchical top-down (root at top) by default, with option to switch to force-directed layout
- Use `<canvas>` or inline SVG — no external graph libraries. Keep it simple: the graph won't have more than ~20 nodes typically.
- Show edge labels on hover (e.g., "architecture design" for a dependency edge)

**Blackboard View** (a full dedicated view accessible via tabs at the top of the center panel: "Topology | DAG | Blackboard | Heuristics | Deferrals"):

The blackboard is the system's shared memory — the "global workspace" where processes publish findings for others to read. This is critically important to understand what the system knows. It deserves a proper full-panel view, not just a sidebar.

Layout: two-column. Left column is the key list, right column is the value inspector.

```
KEYS                                    VALUE INSPECTOR
------------------------------          ----------------------------------
> auth.architecture        architect    {
> auth.jwt_structure       architect      jwt_strategy: "RS256",
  auth.jwt_module_status   jwt-handler    refresh: "rotation",
  auth.middleware_plan      architect      middleware: "express",
  auth.middleware_progress  auth-mw        routes: [
  auth.token_schema        jwt-handler      "/auth/login",
                                             "/auth/register",
                                             ...
                                           ]
                                         }
```

- Left column: key name (monospace), writer process name (dim, right-aligned), click to inspect
- Right column: full JSON with syntax highlighting (strings=green, numbers=cyan, keys=white, brackets=dim)
- Show which process wrote each key as a colored tag matching the process state color
- Highlight recently-changed keys with a brief pulse/glow on the left side
- Search/filter bar at top of key list
- Show write timestamp on hover ("written at tick 15, 2m ago")
- If a key's value has changed during the run, show a small "updated" indicator with how many times it's been written

**Heuristics View** (tab in center panel: "Topology | DAG | Blackboard | Heuristics | Deferrals"):
Learned scheduling patterns that persist across runs. These are the system's accumulated wisdom. Display them as a list:
```
[0.89] "Spawn architect before implementer to establish design constraints"
       context: multi-module implementation | reinforced 3x | scope: global

[0.76] "Checkpoint long-running processes before cross-process validation"
       context: test-driven workflows | reinforced 1x | scope: local
```
- Confidence score as a subtle bar or number
- Show reinforcement count (how many times this heuristic has been validated)
- Scope badge: "global" (applies everywhere) vs "local" (specific to this type of run)
- These should feel weighty — they represent learning across runs

**Deferrals View** (tab in center panel):
Processes that are deliberately waiting for conditions to be met:
```
test-writer    waiting for blackboard_key_exists: auth.jwt_module_status    14 ticks
               "Waiting for JWT module implementation to complete before writing tests"
```
- Show the condition type and what it's waiting on
- Tick counter showing how long it's been waiting
- Visual indicator if a deferral has been waiting "too long" (e.g., > 20 ticks)

#### Right Panel (~350px, collapsible)
**Live Event Feed** — scrolling list of protocol events

Each event line:
```
14:32:45.123  os_tick         completed  tick=42
14:32:44.891  os_llm_stream   started    [code-writer] "Let me analyze..."
14:32:44.500  os_spawn        completed  module-b-impl spawned by code-writer
14:32:43.200  os_command      completed  [metacog] defer: wait for repo-mapper
```

- Timestamp (monospace, dim)
- Action type (color-coded by category: spawns=cyan, ticks=dim, LLM=green, commands=amber, errors=red)
- Agent name in brackets when relevant
- Message (truncated, click to expand)
- **Auto-scroll** when at bottom, pause when user scrolls up (show "Jump to latest" button)
- **Filter bar** at top: toggle event categories on/off

### Status Narrative (just above the center panel, or integrated into the top bar)

A single line of natural-language text that summarizes what the system is doing right now. This is the most important piece of UX for non-expert users — it translates the raw topology into human understanding.

Examples (rotate these in the prototype, changing every ~8 seconds with a subtle typewriter or fade-in transition):

```
"The system is implementing JWT authentication — the architect has finished designing the token structure and two implementation agents are now writing code in parallel."

"jwt-handler has checkpointed to let the test-writer validate its work before continuing. auth-middleware is still writing route protection logic."

"Waiting on a dependency: test-writer is sleeping until the JWT module signals completion. 3 of 6 processes are actively working."

"The metacog is monitoring progress — implementation is 60% complete. It may spawn additional agents if the middleware work stalls."

"Architecture phase complete. The system learned a new heuristic: 'spawn architect before implementer' (confidence: 0.89). Now in implementation phase."
```

Design:
- Monospace or slightly smaller sans-serif text, dim but readable (e.g., `--color-text-secondary`)
- Preceded by a small blinking dot or `>` cursor to feel alive, like a terminal status line
- One or two sentences max. Never more.
- Transitions between summaries should be smooth — fade out old, fade in new. Not jarring.
- This is the thing a manager glances at to know "is it working?" without understanding process trees

### Bottom Bar (Fixed, ~32px)
- Left: Aggregate stats — "12 processes | 3 running | 24,591 tokens | tick 42"
- Right: Keyboard shortcut hints ("Cmd+K: Command | Tab: Navigate | Esc: Back")

## Command Palette (Cmd+K)

A **centered modal overlay** (think VS Code command palette or Linear's Cmd+K):

- Dark, translucent backdrop
- Input field at top with "Ask about this run..." placeholder
- Below the input: recent/suggested actions:
  - "Show token usage breakdown"
  - "Why is dep-analyzer sleeping?"
  - "What has code-writer done so far?"
  - "Show all blackboard keys"
  - "Summarize progress toward goal"
- When the user types a question, show a response area below (simulated for the prototype — show a typing indicator then a pre-written response)
- The AI assistant should feel like it has deep knowledge of the run — it references specific process names, events, and state

**This is a FUTURE feature** — for the prototype, make it visually complete and interactive (opens, closes, accepts input, shows a canned response) but it doesn't need to actually call an AI.

## User Interjection Panel

When a user clicks a process in the topology and opens its detail drawer, there should be a **message input area** at the bottom:

```
+--------------------------------------------------+
| Send message to [code-writer]                     |
| +----------------------------------------------+ |
| |                                               | |
| | Type a message to this agent...               | |
| |                                               | |
| +----------------------------------------------+ |
| [Send]                                   Cmd+Enter|
+--------------------------------------------------+
```

- The input makes it clear WHICH agent you're messaging (show the process name)
- Send button + Cmd+Enter shortcut
- After "sending", show the message in a chat-like thread above the input (sent messages on the right, agent responses on the left — simulated for prototype)
- There should also be an option to **broadcast to all agents** (a toggle or separate action)
- For the prototype, show a simulated acknowledgment: "Message queued for delivery on next tick"

This communicates to stakeholders that the system supports human-in-the-loop intervention at the individual agent level.

## White-Label Considerations

Design with these in mind (don't over-engineer, just don't hard-code):

- Product name in the top bar should come from a config object at the top of the JS
- Primary accent color should be a CSS custom property (`--accent`, `--accent-dim`)
- No product-specific branding baked into the design — keep it neutral/professional
- The color palette should work if someone swaps green for blue or orange

```javascript
const CONFIG = {
  productName: "Cognitive Kernels",
  accentColor: "#00ff88",
  accentDim: "#00ff8833",
  // ... other brand tokens
};
```

## Mock Data

Use this realistic mock data throughout. It should feel like an actual multi-agent coding session:

```javascript
const MOCK_RUNS = [
  {
    id: "b54ef6df-1a2b-3c4d-5e6f-7890abcdef12",
    status: "running",
    pid: 42891,
    createdAt: new Date(Date.now() - 180000).toISOString(),
    updatedAt: new Date(Date.now() - 2000).toISOString(),
    startedAt: new Date(Date.now() - 178000).toISOString(),
    command: "node",
    args: ["dist/cli.js", "os", "--goal", "Implement authentication system with JWT tokens and refresh flow"],
    input: {
      goal: "Implement authentication system with JWT tokens and refresh flow",
      cwd: "/Users/dev/my-app",
      provider: "claude",
    },
  },
  {
    id: "a3c91f02-9e8d-7c6b-5a4f-3210fedcba98",
    status: "completed",
    pid: null,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date(Date.now() - 3300000).toISOString(),
    startedAt: new Date(Date.now() - 3598000).toISOString(),
    endedAt: new Date(Date.now() - 3300000).toISOString(),
    exitCode: 0,
    command: "node",
    args: ["dist/cli.js", "os"],
    input: {
      goal: "Set up database schema and migrations for user management",
      cwd: "/Users/dev/my-app",
      provider: "claude",
    },
  },
  {
    id: "ff120e45-dead-beef-cafe-123456789abc",
    status: "failed",
    pid: null,
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    updatedAt: new Date(Date.now() - 7000000).toISOString(),
    endedAt: new Date(Date.now() - 7000000).toISOString(),
    exitCode: 1,
    error: "Token budget exhausted after 150 ticks",
    command: "node",
    args: ["dist/cli.js", "os"],
    input: {
      goal: "Refactor entire codebase to use dependency injection",
      cwd: "/Users/dev/my-app",
      provider: "claude",
    },
  },
];

const MOCK_PROCESSES = [
  {
    pid: "proc-metacog-001",
    type: "daemon",
    state: "running",
    name: "metacog",
    parentPid: null,
    objective: "Orchestrate implementation of JWT authentication system. Spawn specialists, monitor progress, adjust strategy based on outcomes.",
    priority: 100,
    spawnedAt: new Date(Date.now() - 175000).toISOString(),
    lastActiveAt: new Date(Date.now() - 3000).toISOString(),
    tickCount: 42,
    tokensUsed: 3247,
    tokenBudget: 50000,
    model: "claude-sonnet-4-20250514",
    workingDir: "/Users/dev/my-app",
    children: ["proc-arch-002", "proc-impl-003", "proc-test-006"],
    onParentDeath: "orphan",
    restartPolicy: "always",
    selfReports: [
      { tick: 38, summary: "Architecture phase complete. Implementation 60% done. Test writer waiting on auth module." },
    ],
  },
  {
    pid: "proc-arch-002",
    type: "lifecycle",
    state: "dead",
    name: "architect",
    parentPid: "proc-metacog-001",
    objective: "Design the authentication system architecture: JWT structure, refresh token rotation, middleware placement.",
    priority: 90,
    spawnedAt: new Date(Date.now() - 170000).toISOString(),
    lastActiveAt: new Date(Date.now() - 120000).toISOString(),
    tickCount: 15,
    tokensUsed: 4521,
    model: "claude-sonnet-4-20250514",
    workingDir: "/Users/dev/my-app",
    children: [],
    exitCode: 0,
    exitReason: "Architecture design committed to blackboard",
    blackboardKeysWritten: ["auth.architecture", "auth.jwt_structure", "auth.middleware_plan"],
    onParentDeath: "cascade",
    restartPolicy: "never",
  },
  {
    pid: "proc-impl-003",
    type: "lifecycle",
    state: "running",
    name: "implementer",
    parentPid: "proc-metacog-001",
    objective: "Implement the authentication system based on the architecture in blackboard key auth.architecture",
    priority: 80,
    spawnedAt: new Date(Date.now() - 115000).toISOString(),
    lastActiveAt: new Date(Date.now() - 5000).toISOString(),
    tickCount: 28,
    tokensUsed: 8932,
    tokenBudget: 20000,
    model: "claude-sonnet-4-20250514",
    workingDir: "/Users/dev/my-app/src",
    children: ["proc-jwt-004", "proc-middleware-005"],
    onParentDeath: "cascade",
    restartPolicy: "on-failure",
    selfReports: [
      { tick: 20, summary: "JWT module complete. Starting middleware implementation." },
      { tick: 27, summary: "Middleware 80% done. Waiting on refresh token rotation logic from jwt-handler." },
    ],
  },
  {
    pid: "proc-jwt-004",
    type: "lifecycle",
    state: "checkpoint",
    name: "jwt-handler",
    parentPid: "proc-impl-003",
    objective: "Implement JWT token generation, validation, and refresh token rotation in src/auth/jwt.ts",
    priority: 75,
    spawnedAt: new Date(Date.now() - 100000).toISOString(),
    lastActiveAt: new Date(Date.now() - 30000).toISOString(),
    tickCount: 18,
    tokensUsed: 5200,
    tokenBudget: 8000,
    model: "claude-sonnet-4-20250514",
    workingDir: "/Users/dev/my-app/src/auth",
    children: [],
    checkpoint: {
      reason: "Paused to allow test-writer to validate current JWT implementation before adding refresh rotation",
      savedAt: new Date(Date.now() - 30000).toISOString(),
    },
    blackboardKeysWritten: ["auth.jwt_module_status", "auth.token_schema"],
    onParentDeath: "cascade",
    restartPolicy: "on-failure",
  },
  {
    pid: "proc-middleware-005",
    type: "lifecycle",
    state: "running",
    name: "auth-middleware",
    parentPid: "proc-impl-003",
    objective: "Implement Express middleware for JWT validation, route protection, and role-based access control",
    priority: 70,
    spawnedAt: new Date(Date.now() - 80000).toISOString(),
    lastActiveAt: new Date(Date.now() - 8000).toISOString(),
    tickCount: 12,
    tokensUsed: 3100,
    tokenBudget: 6000,
    model: "claude-sonnet-4-20250514",
    workingDir: "/Users/dev/my-app/src/middleware",
    children: [],
    onParentDeath: "cascade",
    restartPolicy: "on-failure",
  },
  {
    pid: "proc-test-006",
    type: "lifecycle",
    state: "sleeping",
    name: "test-writer",
    parentPid: "proc-metacog-001",
    objective: "Write comprehensive tests for the authentication system as modules are completed",
    priority: 60,
    spawnedAt: new Date(Date.now() - 110000).toISOString(),
    lastActiveAt: new Date(Date.now() - 45000).toISOString(),
    sleepUntil: null,
    wakeOnSignals: ["auth.jwt_module_status"],
    tickCount: 8,
    tokensUsed: 2100,
    tokenBudget: 10000,
    model: "claude-sonnet-4-20250514",
    workingDir: "/Users/dev/my-app/test",
    children: [],
    onParentDeath: "cascade",
    restartPolicy: "on-failure",
  },
];

const MOCK_DAG_TOPOLOGY = {
  nodes: MOCK_PROCESSES.map(p => ({
    pid: p.pid,
    name: p.name,
    type: p.type,
    state: p.state,
    priority: p.priority,
    parentPid: p.parentPid,
  })),
  edges: [
    { from: "proc-metacog-001", to: "proc-arch-002", relation: "parent-child" },
    { from: "proc-metacog-001", to: "proc-impl-003", relation: "parent-child" },
    { from: "proc-metacog-001", to: "proc-test-006", relation: "parent-child" },
    { from: "proc-impl-003", to: "proc-jwt-004", relation: "parent-child" },
    { from: "proc-impl-003", to: "proc-middleware-005", relation: "parent-child" },
    { from: "proc-arch-002", to: "proc-impl-003", relation: "dependency", label: "architecture design" },
    { from: "proc-jwt-004", to: "proc-test-006", relation: "dependency", label: "jwt module ready" },
  ],
};

const MOCK_EVENTS = [
  { action: "os_tick", status: "completed", timestamp: new Date(Date.now() - 3000).toISOString(), message: "tick=42 active=3 sleeping=1 dead=1 checkpointed=1", eventSource: "os" },
  { action: "os_llm_stream", status: "started", timestamp: new Date(Date.now() - 4500).toISOString(), agentId: "proc-middleware-005", agentName: "auth-middleware", message: '{"type":"text_delta","text":"Now I need to implement the role-based access control check..."}', eventSource: "os" },
  { action: "os_command", status: "completed", timestamp: new Date(Date.now() - 8000).toISOString(), agentId: "proc-impl-003", agentName: "implementer", message: "write_blackboard: auth.middleware_progress = 80%", eventSource: "os" },
  { action: "os_llm_stream", status: "started", timestamp: new Date(Date.now() - 12000).toISOString(), agentId: "proc-middleware-005", agentName: "auth-middleware", message: '{"type":"tool_started","toolName":"edit_file","toolUseId":"tu_001","provider":"claude"}', eventSource: "os" },
  { action: "os_process_checkpoint", status: "completed", timestamp: new Date(Date.now() - 30000).toISOString(), agentId: "proc-jwt-004", agentName: "jwt-handler", message: "Checkpoint created: waiting for test validation", eventSource: "os" },
  { action: "os_spawn", status: "completed", timestamp: new Date(Date.now() - 80000).toISOString(), agentId: "proc-impl-003", agentName: "implementer", message: "Spawned auth-middleware (proc-middleware-005)", eventSource: "os" },
  { action: "os_spawn", status: "completed", timestamp: new Date(Date.now() - 100000).toISOString(), agentId: "proc-impl-003", agentName: "implementer", message: "Spawned jwt-handler (proc-jwt-004)", eventSource: "os" },
  { action: "os_process_exit", status: "completed", timestamp: new Date(Date.now() - 120000).toISOString(), agentId: "proc-arch-002", agentName: "architect", message: "Process exited with code 0: Architecture design committed to blackboard", eventSource: "os" },
  { action: "os_command", status: "completed", timestamp: new Date(Date.now() - 125000).toISOString(), agentId: "proc-arch-002", agentName: "architect", message: "write_blackboard: auth.architecture = {jwt_strategy: 'RS256', refresh: 'rotation', middleware: 'express'}", eventSource: "os" },
  { action: "os_spawn", status: "completed", timestamp: new Date(Date.now() - 170000).toISOString(), agentId: "proc-metacog-001", agentName: "metacog", message: "Spawned architect (proc-arch-002)", eventSource: "os" },
];

const MOCK_PROGRESS = {
  goalAlignmentScore: 0.72,
  activeProcessCount: 3,
  stalledProcessCount: 1,
  totalTokensUsed: 27101,
  tokenBudgetRemaining: 72899,
  wallTimeElapsedMs: 178000,
  tickCount: 42,
};

const MOCK_DEFERRALS = [
  {
    id: "defer-001",
    name: "test-writer",
    condition: { type: "blackboard_key_exists", key: "auth.jwt_module_status" },
    waitedTicks: 14,
    reason: "Waiting for JWT module implementation to complete before writing tests",
  },
];

const MOCK_BLACKBOARD = {
  "auth.architecture": {
    jwt_strategy: "RS256",
    refresh: "rotation",
    middleware: "express",
    routes: ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"],
  },
  "auth.jwt_structure": {
    header: { alg: "RS256", typ: "JWT" },
    payload: ["sub", "email", "role", "iat", "exp"],
    expiry: "15m",
    refreshExpiry: "7d",
  },
  "auth.middleware_plan": {
    layers: ["token-extraction", "validation", "role-check"],
    protected_routes: ["/api/*"],
    public_routes: ["/auth/login", "/auth/register", "/health"],
  },
  "auth.jwt_module_status": "implementation_complete_pending_review",
  "auth.token_schema": { accessToken: "string", refreshToken: "string", expiresIn: "number" },
  "auth.middleware_progress": "80%",
};

const MOCK_HEURISTICS = [
  {
    id: "h-001",
    heuristic: "Spawn architect before implementer to establish design constraints",
    confidence: 0.89,
    context: "multi-module implementation",
    scope: "global",
    reinforcementCount: 3,
  },
  {
    id: "h-002",
    heuristic: "Checkpoint long-running processes before cross-process validation",
    confidence: 0.76,
    context: "test-driven workflows",
    scope: "local",
    reinforcementCount: 1,
  },
];
```

## Simulated Real-Time Updates

For the prototype, simulate live updates with `setInterval`:

- Every 2 seconds: increment tick count, update `lastActiveAt` on running processes, shift token counts slightly
- Every 5 seconds: add a new event to the event feed (cycle through a few canned events)
- Every 10 seconds: randomly change a process state (e.g., sleeping -> running, or running -> checkpoint)
- Every 30 seconds: spawn a new child process under one of the running processes (animate the new node appearing in the DAG view, and the new tree entry sliding in)
- Every 45 seconds: simulate a DAG restructure — add or remove a dependency edge, showing the system adapting its own orchestration strategy

These should feel organic, not mechanical. Randomize timing slightly (+/- 500ms). The DAG view should make topology changes especially visible — edges animating, nodes repositioning — because those moments represent the system learning and adapting in real time.

## Technical Requirements

- **Single HTML file.** All CSS and JS inline. No external dependencies, no CDN imports, no build tools.
- **No frameworks.** Vanilla HTML, CSS, JavaScript. No React, no Vue, no Svelte, no Tailwind, no Bootstrap.
- **CSS custom properties** for all colors, spacing, and typography. This is the foundation for the future design system extraction.
- **CSS Grid and Flexbox** for layout. No floats, no tables-for-layout.
- **Semantic HTML** where it matters (nav, main, aside, section, article).
- **Smooth transitions** on state changes (CSS transitions, not JS animations).
- **Responsive enough** that it works at 1280px+ widths. This is a desktop tool, not mobile.

## What "Gift Quality" Means

- The loading state is beautiful (not a spinner — a subtle pulse or terminal-style initialization sequence)
- Empty states have personality ("No runs yet. Start one to see the topology come alive.")
- Error states are informative and styled, not browser defaults
- Hover states on every interactive element
- Focus rings for keyboard navigation (styled, not browser defaults)
- Text selection colors match the theme
- Scrollbar styling matches the theme (thin, dark)
- The favicon is a small terminal-style icon (inline SVG data URI)
- The page title updates to show the active run status

## What NOT To Do

- No gradients (except very subtle ones on glass-effect panels if tasteful)
- No shadows (use borders and background color shifts for depth)
- No icons from icon libraries — use Unicode symbols or simple inline SVGs if needed
- No "card" layouts with padding and rounded corners everywhere
- No loading skeletons — use the terminal aesthetic (blinking cursor, progress text)
- No tooltips that use browser title attributes — build custom ones
- No alert() or confirm() — build custom modals
- Do not use tailwind or any css framework
