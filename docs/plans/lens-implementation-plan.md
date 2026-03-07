# The Lens — Implementation Plan

> The cognitive kernel is an artificial organism. The Lens is how you see inside it.

The Lens is a new architectural layer that sits between the cognitive kernel's raw telemetry and the human observer. It transforms protocol events, system snapshots, and blackboard state into legible, real-time views — pushed to connected clients over WebSocket.

The kernel produces **intelligence**. The Lens produces **legibility**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser UI                              │
│   WebSocket client, renders topology/DAG/events/terminal    │
└──────────────────────────┬──────────────────────────────────┘
                           │ ws:// push + REST queries
┌──────────────────────────▼──────────────────────────────────┐
│                       THE LENS                              │
│                   src/lens/                                  │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  WebSocket   │  │  Snapshot    │  │  Stream           │  │
│  │  Server      │  │  Differ      │  │  Segmenter        │  │
│  │  (push)      │  │  (deltas)    │  │  (per-process)    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                 │                    │             │
│  ┌──────▼─────────────────▼────────────────────▼──────────┐ │
│  │                 Lens Core                              │ │
│  │  Subscribes to emitter events + snapshot writes        │ │
│  │  Maintains per-run view state                          │ │
│  │  Computes derived views (role, metrics, narrative)     │ │
│  └──────┬─────────────────────────────────────────────────┘ │
│         │                                                   │
│  ┌──────▼───────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  Narrative    │  │  Command     │  │  Role             │ │
│  │  Generator    │  │  Palette     │  │  Classifier       │ │
│  │  (LLM)       │  │  (NL query)  │  │  (rule-based)     │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           │ subscribes to events
┌──────────────────────────▼──────────────────────────────────┐
│              MCP Control Plane / REST API                    │
│           (existing: start, list, get, pause)                │
└──────────────────────────┬──────────────────────────────────┘
                           │ manages child processes
┌──────────────────────────▼──────────────────────────────────┐
│                   COGNITIVE KERNEL (OS)                      │
│        tick loop, processes, metacog, blackboard             │
│        OsProtocolEmitter → events + snapshots                │
└─────────────────────────────────────────────────────────────┘
```

---

## Phases

### Phase 1: Foundation — Event Bus + WebSocket Server

**Goal:** Establish the real-time push channel. A browser client connects, subscribes to a run, and receives live events as they happen.

**Why first:** Everything else depends on this. Without push, we're just polling files.

#### 1.1 — Internal Event Bus (in-process)

**File:** `src/lens/event-bus.ts`

The kernel's `OsProtocolEmitter` currently writes to filesystem + DB. We need it to also emit events to an in-process `EventEmitter` so the Lens can subscribe without polling.

```typescript
// Minimal change to OsProtocolEmitter
interface EmitterOptions {
  // ... existing options ...
  internalBus?: EventEmitter;  // NEW: optional in-process event bus
}

// In emitEvent():
if (this.internalBus) {
  this.internalBus.emit('event', { runId, event });
}

// In writeLiveState():
if (this.internalBus) {
  this.internalBus.emit('snapshot', { runId, snapshot });
}
```

The event bus is a simple typed `EventEmitter`:

```typescript
type LensEvent =
  | { type: 'event'; runId: string; event: RuntimeProtocolEvent }
  | { type: 'snapshot'; runId: string; snapshot: OsSystemSnapshot }
  | { type: 'run_status'; runId: string; status: KernelRun['status'] }
```

**Kernel-side change:** ~15 lines. Add optional `internalBus` to emitter constructor, emit on it in two places.

**Run manager change:** When spawning a run in-process (not as child process), pass the bus. When spawning as child process, the Lens falls back to filesystem watching.

#### 1.2 — WebSocket Server

**File:** `src/lens/server.ts`

A lightweight WebSocket server (using `ws` package — one dependency) that:
- Accepts connections on a configurable port (default 3200)
- Clients send `{ subscribe: runId }` to start receiving events for a run
- Server pushes events as they arrive from the internal bus
- Handles multiple concurrent clients per run
- Heartbeat ping/pong for connection health

```typescript
interface LensServer {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  broadcastToRun(runId: string, message: LensMessage): void;
}

type LensMessage =
  | { type: 'event'; event: RuntimeProtocolEvent }
  | { type: 'snapshot_delta'; delta: SnapshotDelta }
  | { type: 'narrative'; text: string }
  | { type: 'full_snapshot'; snapshot: LensSnapshot }
```

#### 1.3 — Filesystem Watcher Fallback

**File:** `src/lens/file-watcher.ts`

For runs spawned as child processes (the current model), the Lens watches:
- `{runDir}/os-live.json` — snapshot changes (fs.watch or chokidar)
- `{runDir}/protocol.ndjson` — new events (tail -f style, track file offset)

This bridges the gap until runs can emit to the internal bus directly. It's also the right approach for observing runs started by other processes.

#### 1.4 — CLI Integration

**Changes to:** `src/cli.ts`

Add a `lens` command:
```
cognitive-kernels lens [--port 3200] [--runs-root path]
```

The Lens server starts, watches for active runs, and serves WebSocket connections. Can run standalone or be co-started with `serve`.

**Deliverables:**
- [ ] `src/lens/event-bus.ts` — Typed EventEmitter for internal events
- [ ] `src/lens/server.ts` — WebSocket server with run subscription
- [ ] `src/lens/file-watcher.ts` — Filesystem fallback for child-process runs
- [ ] `src/lens/index.ts` — Main entry, wires bus + server + watcher
- [ ] Modify `OsProtocolEmitter` — Add optional `internalBus` emission
- [ ] Add `lens` CLI command
- [ ] Add `ws` dependency

**Test:** Start a run, connect via WebSocket, verify events stream in real-time.

---

### Phase 2: Snapshot Diffing + View Models

**Goal:** Don't send the full snapshot every tick. Compute deltas. Also, construct the view models the UI actually needs.

#### 2.1 — Snapshot Differ

**File:** `src/lens/snapshot-differ.ts`

The `OsSystemSnapshot` is a structured JSON object. On each new snapshot:
1. Diff against the previous snapshot for that run
2. Produce a `SnapshotDelta` containing only what changed

```typescript
interface SnapshotDelta {
  tick: number;
  timestamp: string;
  processes?: {
    added: LensProcess[];
    removed: string[];  // pids
    changed: ProcessDelta[];  // pid + changed fields only
  };
  dag?: {
    addedEdges: LensEdge[];
    removedEdges: LensEdge[];
  };
  blackboard?: {
    updated: { key: string; value: any; writer: string; tick: number }[];
    removed: string[];
  };
  metrics?: Partial<LensMetrics>;
  events?: RuntimeProtocolEvent[];  // new events since last push
}
```

**Algorithm:** Deep structural diff on snapshot objects. For processes, compare by PID. For blackboard, compare by key. For DAG, compare edge sets.

#### 2.2 — View Models (LensSnapshot)

**File:** `src/lens/view-models.ts`

Transform raw `OsSystemSnapshot` into the shape the UI actually needs:

```typescript
interface LensSnapshot {
  runId: string;
  tick: number;
  elapsed: number;  // ms since run start

  processes: LensProcess[];
  dag: { nodes: LensDagNode[]; edges: LensEdge[] };
  blackboard: Record<string, LensBBEntry>;
  heuristics: LensHeuristic[];
  deferrals: LensDeferral[];
  metrics: LensMetrics;
  narrative: string | null;
}

interface LensProcess {
  pid: string;
  name: string;
  state: string;
  role: 'kernel' | 'sub-kernel' | 'shell';  // computed
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
  wakeOnSignals?: string[];
  selfReports: { tick: number; summary: string }[];
  blackboardIO: LensBBIOEntry[];  // computed: keys read + written
}

interface LensBBIOEntry {
  key: string;
  direction: 'read' | 'write';
  tick: number;
  valuePreview: string;  // truncated string representation
}

interface LensMetrics {
  totalTokens: number;
  tokenRate: number;  // tokens/sec computed over sliding window
  processCount: number;
  runningCount: number;
  sleepingCount: number;
  deadCount: number;
  checkpointedCount: number;
  dagDepth: number;
  dagEdgeCount: number;
}
```

#### 2.3 — Role Classifier

**File:** `src/lens/role-classifier.ts`

Pure function, no LLM needed:

```typescript
function classifyRole(proc: OsProcess, allProcs: OsProcess[]): 'kernel' | 'sub-kernel' | 'shell' {
  // Daemons are kernel-level (metacog, memory-consolidator, awareness-daemon)
  if (proc.type === 'daemon') return 'kernel';

  // Lifecycle processes with children that are also lifecycle = sub-kernel
  const children = allProcs.filter(p => p.parentPid === proc.pid);
  const hasLifecycleChildren = children.some(c => c.type === 'lifecycle');
  if (hasLifecycleChildren) return 'sub-kernel';

  // Root orchestrator is always a sub-kernel (even before it spawns)
  if (proc.parentPid === null && proc.type === 'lifecycle') return 'sub-kernel';

  return 'shell';
}
```

**Deliverables:**
- [ ] `src/lens/snapshot-differ.ts` — Structural diff of OsSystemSnapshot
- [ ] `src/lens/view-models.ts` — LensSnapshot construction from raw snapshot
- [ ] `src/lens/role-classifier.ts` — kernel/sub-kernel/shell classification
- [ ] Update `server.ts` to push deltas instead of full snapshots
- [ ] Integrate into Lens core: on new snapshot → diff → build view model → push delta

**Test:** Feed two sequential snapshots, verify delta contains only changes. Verify role classification against known topologies.

---

### Phase 3: Per-Process Streams + Terminal View

**Goal:** The UI's terminal view needs per-process log streams. Events are already tagged with `agentId` — segment them.

#### 3.1 — Stream Segmenter

**File:** `src/lens/stream-segmenter.ts`

Maintains a per-process ring buffer of events:

```typescript
class StreamSegmenter {
  private buffers: Map<string, RingBuffer<LensTerminalLine>>;

  // Called on every protocol event
  ingest(event: RuntimeProtocolEvent): void {
    const pid = event.agentId;
    if (!pid) return;
    const line = this.classify(event);
    this.getBuffer(pid).push(line);
  }

  // Classify event into terminal line type
  classify(event: RuntimeProtocolEvent): LensTerminalLine {
    // os_llm_stream with text_delta → 'thinking' or 'output'
    // os_command → 'tool'
    // os_process_spawn/kill/checkpoint → 'system'
    // os_tick → 'info'
    // errors → 'error'
  }

  // Get last N lines for a process
  getLines(pid: string, limit?: number): LensTerminalLine[];

  // Get lines added since cursor
  getLinesSince(pid: string, cursor: number): LensTerminalLine[];
}

interface LensTerminalLine {
  seq: number;
  timestamp: string;
  level: 'system' | 'info' | 'thinking' | 'tool' | 'output' | 'error';
  text: string;
}
```

#### 3.2 — Per-Process Stream Subscription

Extend the WebSocket protocol:

```typescript
// Client sends:
{ subscribe_process: { runId: string; pid: string } }

// Server pushes:
{ type: 'terminal_line'; pid: string; line: LensTerminalLine }
```

Clients can subscribe to multiple processes simultaneously. When a process is selected in the UI, subscribe to its stream. Unsubscribe on deselect.

#### 3.3 — Blackboard I/O Audit Log

**Kernel-side change:** `src/os/ipc-bus.ts`

Add lightweight read tracking to the blackboard:

```typescript
// In bbRead():
if (entry && readerPid) {
  if (!entry.readBy) entry.readBy = [];
  if (!entry.readBy.includes(readerPid)) {
    entry.readBy.push(readerPid);
  }
}
```

This is ~5 lines in the IPC bus. The `readBy` array is then included in the snapshot, and the Lens can build per-process I/O tables from it.

Additionally, track in the snapshot which keys each process wrote (already available from `writtenBy` on each BB entry) and which it read (from `readBy`).

**Deliverables:**
- [ ] `src/lens/stream-segmenter.ts` — Per-process event ring buffers
- [ ] Extend WebSocket protocol with process stream subscription
- [ ] Modify IPC bus to track `readBy` on blackboard entries
- [ ] Build `LensBBIOEntry[]` per process in view model construction
- [ ] Update Lens core to route events through segmenter

**Test:** Emit a series of events for different agents, verify segmenter separates them correctly. Subscribe to a process stream via WebSocket, verify only that process's events arrive.

---

### Phase 4: Narrative Generator

**Goal:** Generate human-readable status summaries that explain what the organism is doing, in plain language. This is the "consciousness narration" layer.

#### 4.1 — Narrative Engine

**File:** `src/lens/narrative-generator.ts`

```typescript
class NarrativeGenerator {
  private brain: Brain;  // uses Haiku — fast and cheap
  private cache: Map<string, { text: string; tick: number }>;
  private cadence: number;  // generate every N ticks (default: 5)

  async generate(snapshot: LensSnapshot): Promise<string> {
    // Skip if we generated recently
    const cached = this.cache.get(snapshot.runId);
    if (cached && snapshot.tick - cached.tick < this.cadence) {
      return cached.text;
    }

    const prompt = this.buildPrompt(snapshot);
    const narrative = await this.brain.complete(prompt);
    this.cache.set(snapshot.runId, { text: narrative, tick: snapshot.tick });
    return narrative;
  }

  buildPrompt(snapshot: LensSnapshot): string {
    // Compact representation of current state
    // Ask for 1-2 sentence narrative with HTML markup for highlighting
    // Include: active processes, what they're doing, blockers, progress
  }
}
```

**Prompt strategy:**
```
You are narrating the internal state of a cognitive system for a human observer.
Given the current system snapshot, write 1-2 sentences describing what's happening.

Rules:
- Use <span class="n-agent">name</span> for process names
- Use <span class="n-state n-state-{state}">{state}</span> for states
- Use <span class="n-key">key</span> for blackboard keys
- Use <span class="n-number">N</span> for significant numbers
- Be specific about what each active process is doing right now
- Mention blockers or waiting conditions if relevant
- No preamble. Just the narrative.

Current state:
- Tick: {tick}, Elapsed: {elapsed}
- Goal: {goal}
- Processes: {compact process list with states and current activity}
- Recent events: {last 5 events}
- Blackboard updates: {recent writes}
```

#### 4.2 — Significant Change Detection

Don't regenerate narrative on every tick. Detect significant changes:
- Process state transition (running → checkpoint, sleeping → running)
- New process spawned or killed
- Blackboard key written for the first time
- Metacog evaluation completed
- Error or stall detected

On significant change, regenerate immediately regardless of cadence.

**Deliverables:**
- [ ] `src/lens/narrative-generator.ts` — LLM-powered narrative engine
- [ ] Significant change detector (triggers immediate narrative refresh)
- [ ] Wire narrative into LensSnapshot and push to clients
- [ ] Prompt engineering for concise, well-marked-up narratives

**Test:** Feed a snapshot sequence, verify narratives are generated at cadence and on significant changes. Verify HTML markup is present and correct.

---

### Phase 5: Command Palette + Message Injection

**Goal:** Let the human observer ask questions about the organism's state and send messages to individual processes.

#### 5.1 — Command Palette Handler

**File:** `src/lens/command-palette.ts`

```typescript
class CommandPaletteHandler {
  private brain: Brain;  // Haiku or Sonnet depending on query complexity

  async query(runId: string, question: string, snapshot: LensSnapshot): Promise<string> {
    const prompt = this.buildPrompt(question, snapshot);
    return this.brain.complete(prompt);
  }

  buildPrompt(question: string, snapshot: LensSnapshot): string {
    // Full snapshot context + question
    // Instruct to be specific, reference real process names and data
    // Instruct to use terminal-style formatting
  }
}
```

**WebSocket protocol:**
```typescript
// Client sends:
{ command_query: { runId: string; question: string } }

// Server pushes (streamed):
{ type: 'command_response'; text: string; done: boolean }
```

#### 5.2 — Suggested Queries

Generate contextual query suggestions based on current state:
- If a process is sleeping → "Why is {name} sleeping?"
- If token usage is high → "Show token usage breakdown"
- If a process just failed → "What caused {name} to fail?"
- Always available → "Summarize progress toward goal"

```typescript
function generateSuggestions(snapshot: LensSnapshot): string[] {
  const suggestions = ['Summarize progress toward goal'];
  const sleeping = snapshot.processes.filter(p => p.state === 'sleeping');
  sleeping.forEach(p => suggestions.push(`Why is ${p.name} sleeping?`));
  // ... etc
  return suggestions.slice(0, 5);
}
```

#### 5.3 — Message Injection

**File:** `src/lens/message-injector.ts`

Allow the human observer to send a message to a specific process. The message is delivered via the kernel's IPC signal mechanism.

**Kernel-side change:** Add a `human_message` signal type that the IPC bus recognizes:
```typescript
// In IPC bus:
emitSignal('human_message', 'lens', { targetPid, text, timestamp });
```

The target process receives the message on its next tick as part of its signal inbox. The executor includes it in the process's context prompt.

**WebSocket protocol:**
```typescript
// Client sends:
{ send_message: { runId: string; pid: string; text: string } }

// Server pushes:
{ type: 'message_ack'; pid: string; text: string; deliveredAt: string | null }
```

**Deliverables:**
- [ ] `src/lens/command-palette.ts` — NL query handler with LLM
- [ ] `src/lens/message-injector.ts` — Human → process message delivery
- [ ] Contextual query suggestion generator
- [ ] Add `human_message` signal type to IPC bus
- [ ] WebSocket protocol extensions for queries and messages
- [ ] Wire into executor context: include human messages in process prompt

**Test:** Send a query, verify LLM response references actual snapshot data. Send a message to a process, verify it appears in the process's signal inbox on next tick.

---

### Phase 6: UI Integration

**Goal:** Replace mock data in the run inspector HTML with real WebSocket connections.

#### 6.1 — WebSocket Client Module

Replace the `MOCK_*` constants and `simulate*` functions with a real WebSocket client:

```javascript
class LensClient {
  constructor(url) { /* ws:// connection */ }

  subscribe(runId) { /* send subscribe message */ }
  subscribeProcess(runId, pid) { /* per-process terminal stream */ }
  query(runId, question) { /* command palette query */ }
  sendMessage(runId, pid, text) { /* message injection */ }

  onSnapshot(callback) { /* full snapshot received */ }
  onDelta(callback) { /* snapshot delta received */ }
  onEvent(callback) { /* protocol event received */ }
  onTerminalLine(callback) { /* per-process terminal line */ }
  onNarrative(callback) { /* narrative update */ }
  onCommandResponse(callback) { /* query response chunk */ }
}
```

#### 6.2 — State Management Refactor

The UI's `state` object currently holds cloned mock data. Refactor:
- `state.processes` ← populated from `LensSnapshot.processes`
- `state.edges` ← populated from `LensSnapshot.dag.edges`
- `state.events` ← appended from real-time events
- `state.blackboard` ← populated from `LensSnapshot.blackboard`
- `state.terminalLogs` ← populated from per-process stream subscription
- Narrative ← pushed from server

#### 6.3 — Graceful Degradation

If the Lens server is unavailable, the UI should:
- Fall back to REST polling (hit the existing MCP/REST API)
- Show a "disconnected" indicator instead of the green connection dot
- Attempt reconnection with exponential backoff

**Deliverables:**
- [ ] WebSocket client module in run-inspector.html
- [ ] Replace mock data with real-time state from Lens
- [ ] Connection status indicator (connected/reconnecting/disconnected)
- [ ] Graceful degradation to REST polling
- [ ] Remove simulation functions, keep as optional demo mode

---

### Phase 7: Polish + Production Hardening

#### 7.1 — Authentication & Multi-Tenancy
- Token-based auth for WebSocket connections
- Run-level access control (can this client observe this run?)

#### 7.2 — Backpressure & Rate Limiting
- If a client can't keep up with events, buffer and batch
- Cap event push rate (e.g., max 20 events/sec to client, batch the rest)
- Snapshot delta rate limiting (max 1 delta/sec even if ticks are faster)

#### 7.3 — Historical Mode
- Connect to a completed run and replay its event stream
- Seek to any tick, scrub through timeline
- Powered by stored events in DB + snapshots

#### 7.4 — Multi-Run Dashboard
- Observe multiple runs simultaneously
- Overview grid showing all active runs with summary metrics
- Click to drill into a specific run

---

## File Structure

```
src/lens/
  index.ts                  — Main entry, wires everything together
  server.ts                 — WebSocket server, connection management
  event-bus.ts              — Typed EventEmitter for internal events
  file-watcher.ts           — Filesystem watcher fallback
  snapshot-differ.ts        — Structural diff of snapshots
  view-models.ts            — LensSnapshot construction
  role-classifier.ts        — kernel/sub-kernel/shell classification
  stream-segmenter.ts       — Per-process event ring buffers
  narrative-generator.ts    — LLM-powered status narratives
  command-palette.ts        — NL query handler
  message-injector.ts       — Human → process message delivery
  types.ts                  — All Lens-specific type definitions
```

## Kernel-Side Changes (Minimal)

| File | Change | Lines |
|---|---|---|
| `src/os/protocol-emitter.ts` | Add optional `internalBus` EventEmitter, emit on it | ~15 |
| `src/os/ipc-bus.ts` | Track `readBy` on blackboard reads | ~5 |
| `src/os/ipc-bus.ts` | Add `human_message` signal type | ~10 |
| `src/os/types.ts` | Add `readBy` to blackboard entry type | ~2 |
| `src/cli.ts` | Add `lens` CLI command | ~20 |

**Total kernel changes: ~50 lines.** The Lens is almost entirely additive.

## Dependencies

| Package | Purpose | Size |
|---|---|---|
| `ws` | WebSocket server | 30KB |
| `chokidar` (optional) | Filesystem watching (cross-platform) | Already common |

## Implementation Order

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 6 (basic UI integration)
                 │                        │
                 └──→ Phase 4 ───────────→┘
                 └──→ Phase 5 ───────────→┘
                                          │
                                     Phase 7
```

Phases 1-3 are sequential (each builds on the last).
Phases 4 and 5 are independent of each other but depend on Phase 2.
Phase 6 can start after Phase 3 with basic integration, then add narrative + command palette as Phases 4-5 complete.
Phase 7 is polish after everything works.

## Design Principles

1. **The kernel doesn't know the Lens exists.** The only kernel change is an optional EventEmitter parameter. If the Lens isn't running, nothing changes.

2. **The Lens is read-only.** It observes. The only write path is message injection, which goes through the existing IPC mechanism — the kernel decides what to do with it.

3. **The Lens is disposable.** You can kill it, restart it, run multiple instances. It rebuilds state from the kernel's snapshots and event streams. No state of its own needs to survive.

4. **Cheap LLM calls for presentation.** Narrative generation and command palette use Haiku. The kernel's cognitive budget is separate from the Lens's presentation budget.

5. **The organism doesn't change because you're watching it.** The Lens observes the kernel's natural behavior. It doesn't alter scheduling, metacog decisions, or process execution. It's a microscope, not a scalpel. (Message injection is the one deliberate exception — and even that goes through normal IPC.)
