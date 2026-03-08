# Declarative Topology Algebra — Design Document

## Goal

Replace the metacognitive system's 16 imperative commands and 4 DAG mutation types with a declarative topology algebra. Metacog declares the desired work graph using 4 composable primitives. A pure reconciler diffs current state against the desired topology and produces typed effects. The goal-orchestrator process is eliminated — metacog is the orchestrator.

## Why

The current metacog system works but isn't elegant. 16 command types, a 300-line prompt teaching a bespoke API, fragile DAG mutation logic, scattered supervisor calls. The topology algebra collapses all of this into one idea: **declare the graph you want, let the math produce the diff.**

Benefits:
- **Provable** — the reconciler is a pure function. Totality, idempotency, and completeness are testable properties.
- **Simpler for LLMs** — 4 primitives instead of 16 commands. Describe a shape, don't issue surgical mutations.
- **Long-horizon scaling** — each metacog evaluation re-declares remaining work. Adaptive replanning is natural.
- **Cycle-free by construction** — the tree algebra can't express cycles.
- **Composable** — `seq`, `par`, `gate` nest arbitrarily. Sub-kernels compose vertically.

## Architecture

```
LLM (metacog)
    ↓ declares
TopologyExpr (the algebra)
    ↓ validated by
validateTopology() → proof of soundness
    ↓ optimized by
optimizeTopology() → structural transforms + warnings
    ↓ reconciled by
reconcile(current, desired) → effects[]    (pure, inside transition)
    ↓ interpreted by
kernel I/O shell (spawn, kill, wire edges)
```

Data flow per metacog evaluation:

1. Metacog daemon wakes (trigger or cadence)
2. Transition emits `submit_metacog` effect
3. Kernel runs metacog LLM with current state context
4. LLM returns `{ topology, memory, halt }`
5. Kernel validates the topology expression (microseconds)
6. Kernel creates event: `{ type: "topology_declared", topology, memory, halt }`
7. `transition(state, event)` calls `reconcile(state.processes, topology)`
8. Reconciler produces typed effects: spawn, kill, activate, add_edge, remove_edge
9. `interpretTransitionEffects` executes the I/O
10. `applyStateChanges` copies the new state (trivial)

## Metacog Output Grammar

After the change, metacog's entire output is three fields:

```typescript
interface MetacogOutput {
  topology: TopologyExpr | null;   // null = no changes this cycle
  memory: MemoryCommand[];         // learning commands (unchanged)
  halt: HaltCommand | null;        // stop the kernel
}
```

### What disappeared

| Before (16 commands) | After |
|---|---|
| spawn | `task()` in topology |
| kill | absent from topology = killed |
| fork | new `task()` with similar config |
| defer | `gate()` in topology |
| cancel_defer | remove the gate |
| rewrite_dag (4 types) | declare the new shape |
| spawn_system | `task()` with `backend: "system"` |
| spawn_kernel | `task()` with `backend: "kernel"` |
| reprioritize | `task()` with new `priority` |
| noop | `topology: null` |
| delegate_evaluation | `task()` with eval objective |
| halt | `halt` field |
| learn | `memory` field |
| define_blueprint | `memory` field |
| evolve_blueprint | `memory` field |
| record_strategy | `memory` field |

## The Topology Algebra

Four primitives, all composable:

```typescript
type TopologyExpr =
  | { type: "task"; name: string; objective: string;
      model?: string; priority?: number; backend?: TaskBackend }
  | { type: "seq"; children: TopologyExpr[] }
  | { type: "par"; children: TopologyExpr[] }
  | { type: "gate"; condition: GateCondition; child: TopologyExpr }

type TaskBackend =
  | { kind: "llm" }                                      // default
  | { kind: "system"; command: string; args?: string[] }  // shell process
  | { kind: "kernel"; goal: string; maxTicks?: number }   // sub-kernel

type GateCondition =
  | { type: "blackboard_key_exists"; key: string }
  | { type: "blackboard_key_match"; key: string; value: unknown }
  | { type: "blackboard_value_contains"; key: string; substring: string }
  | { type: "process_dead"; name: string }
  | { type: "all_of"; conditions: GateCondition[] }
  | { type: "any_of"; conditions: GateCondition[] }
```

Key properties:
- `task` is the only leaf node. Everything else is composition.
- `seq` creates dependency edges. B can't start until A completes.
- `par` creates no edges between children. All run independently.
- `gate` creates a conditional node. The child subtree is spawned only when the condition is met. Replaces `defer`.
- `backend` supports shell processes and sub-kernels within the same algebra.
- Tasks are matched by `name` during reconciliation. Names must be unique.

### What you can express

```
seq(A, B)                          — A then B
par(A, B)                          — A and B simultaneously
seq(par(A, B), C)                  — A and B in parallel, then C
gate(cond, A)                      — A when condition is met
par(A, gate(cond, B))              — A starts now, B starts when ready
seq(par(A, B), gate(cond, C), D)   — scouts, then gated work, then finalize
```

The expression is a tree (no cycles by construction). Flattening produces a DAG.

Sub-kernels compose vertically — the parent sees an opaque task, the child has its own metacog and topology:

```
Parent topology (parent metacog)
  └─ task("refactor-module", backend: kernel)
       └─ Child topology (child metacog)
            ├─ task("analyze-deps")
            ├─ task("extract-interfaces")
            └─ task("update-imports")
```

## The Reconciler

Pure function inside `transition()`.

```typescript
function reconcile(
  currentProcesses: Map<string, OsProcess>,
  desiredTopology: TopologyExpr | null,
  blackboard: Map<string, BlackboardEntry>,
  inflight: Set<string>,
): KernelEffectInput[]
```

### Algorithm

1. **Flatten** — walk the topology tree, produce flat set of desired nodes + dependency edges.
2. **Evaluate gates** — check each gate condition against blackboard/process state. If met, include child subtree. If not, skip (re-evaluated next housekeep).
3. **Match** — pair desired nodes to existing alive processes by name:
   - **Matched** — exists and desired. Keep. If config changed (priority, objective), emit update effects.
   - **To spawn** — desired but doesn't exist. Emit spawn + edge effects.
   - **To kill** — exists but not desired. If inflight, emit drain (let turn finish, kill on completion). If idle, kill immediately.
4. **Diff edges** — compare current DAG edges to desired. Add missing, remove stale.
5. **Activate** — for newly spawned or newly unblocked processes, check if all dependencies are satisfied (predecessors completed). If so, emit activate + submit_llm.

### Drain behavior

When a process is inflight (mid-LLM-call) and absent from the new topology, the reconciler emits a `drain_process` effect instead of `kill_process`. The kernel lets the current turn finish, then kills on completion. No wasted tokens.

When a process is inflight and present in the new topology under the same name, it's matched — kept alive, no disruption.

### `flatten()` pseudocode

```
function flatten(expr) → { nodes, edges }
  switch expr.type:
    case "task":
      return { nodes: [expr], edges: [] }
    case "par":
      return merge(children.map(flatten))
    case "seq":
      parts = children.map(flatten)
      edges = []
      for i in 1..parts.length:
        for src in parts[i-1].exitNodes:
          for dst in parts[i].entryNodes:
            edges.push([src, dst])
      return merge(parts) + edges
    case "gate":
      inner = flatten(expr.child)
      inner.entryNodes[0].gateCondition = expr.condition
      return inner
```

## Topology Validation

Pure function, runs at declaration time before reconciliation. Microseconds for any realistic topology.

```typescript
function validateTopology(
  topology: TopologyExpr
): { valid: true } | { valid: false; errors: ValidationError[] }
```

| Property | How | Cost |
|---|---|---|
| Well-formed tree | Type check the expression | O(n) |
| Unique names | Collect names, check duplicates | O(n) |
| Cycle-free DAG | Topological sort on flattened graph | O(n + e) |
| Reachability | BFS/DFS from root | O(n) |
| Gate conditions valid | Type check condition fields | O(n) |
| Max parallelism | Count max concurrent nodes at any depth | O(n) |
| Deadlock-free | No gate depends on output of a node behind the gate | O(n²) |
| Resource bounds | Total nodes < limit, max width < limit | O(n) |

The entire pipeline is provably total: any valid topology + any valid process state → valid effects. Validated before execution, verified by property-based tests.

## Topology Optimizer

Pure function that transforms topology expressions before they hit the reconciler.

```typescript
function optimizeTopology(
  topology: TopologyExpr,
  heuristics: OsHeuristic[],
  history: TopologyHistory,
): { optimized: TopologyExpr; warnings: OptWarning[] }
```

### Phase 1 — Structural optimizations (pure tree transforms)

- **Flatten nesting** — `seq(seq(A, B), C)` → `seq(A, B, C)`
- **Eliminate single-child wrappers** — `par(A)` → `A`
- **Gate hoisting** — `par(gate(X, A), gate(X, B))` → `gate(X, par(A, B))`
- **Dead branch pruning** — tasks gated behind provably unsatisfiable conditions

### Phase 2 — Cost-aware optimizations (uses heuristics)

- **Width limiting** — warn if parallelism exceeds threshold
- **Critical path analysis** — identify longest sequential chain, flag if parallelizable
- **Redundancy detection** — near-identical objectives → warn duplicate work
- **Historical cost estimation** — estimate token cost from learned heuristics

### Phase 3 — Learned rewrites (future)

- **Pattern matching** — historical data shows seq outperforms par for this goal type → suggest rewrite
- **Blueprint application** — stored blueprint matches goal shape → suggest proven topology
- **Bayesian confidence** — weight suggestions by success rate

Pipeline position:

```
metacog declares topology → validate → optimize → reconcile → effects
```

Phase 1 is implemented now. Phases 2-3 are future work — the slot in the pipeline is wired from day one.

## Boot Sequence

Current: boot → spawn goal-orchestrator → scheduling pass → orchestrator decomposes goal → spawns workers.

New: boot → trigger metacog → metacog sees empty state + goal → declares initial topology → reconciler spawns everything.

The goal-orchestrator process is eliminated. Dead executive recovery logic is eliminated. The `selected_blueprint` blackboard dance is eliminated. Metacog is the orchestrator.

## Metacog Prompt

Shrinks from ~300 lines to ~80. Three sections:

**Identity:**
```
You are the metacognitive controller. You observe the system and
declare the desired work topology. You don't execute work — you
shape the graph of processes that do.
```

**The algebra (~20 lines):**
```
Your output has three fields: topology, memory, halt.

topology: Declare the work graph using these primitives:
  task(name, objective)     — a unit of work
  seq(a, b, ...)            — sequential: b starts when a completes
  par(a, b, ...)            — parallel: all run concurrently
  gate(condition, subgraph) — run subgraph when condition is met

  Set topology to null if no changes needed.
  Only declare remaining work — completed tasks are already done.

memory: Array of learning commands (learn, define_blueprint, ...)
halt: { status, summary } when goal is achieved/unachievable, else null
```

**Strategic heuristics (adapted from current prompt):**
```
- Prefer par() for independent research/exploration
- Use seq() when later work depends on earlier output
- Use gate() instead of polling — never spawn a process to wait
- Keep total active tasks under 8 unless the goal demands more
- Don't restructure topology unless progress has stalled for 3+ cycles
- When restructuring, prefer minimal changes over full replans
```

Context section remains unchanged — same rich state dump (process table, blackboard values, progress metrics, heuristics, intervention history).

## Ephemerals

Unchanged. Ephemerals are fire-and-forget scouts spawned by workers mid-turn via `spawn_ephemeral` command. They don't appear in the topology — they're tactical decisions by individual workers, not planned work. The existing `ephemeral_completed` transition handler remains.

## Error Handling

- **Invalid topology** — JSON schema validation rejects it. Skip this cycle, awareness triggers metacog again.
- **Worker failure** — transition handles `process_completed`. Metacog sees the failure, re-declares topology (retry, restructure, or halt).
- **Null topology** — no-op. Zero effects.
- **Gate never met** — metacog sees stalled gated nodes in subsequent evaluations, can restructure.
- **Name collision** — rejected at validation time.

## Memory Commands (Unchanged)

```typescript
type MemoryCommand =
  | { kind: "learn"; heuristic: string; confidence: number;
      context: string; scope?: HeuristicScope }
  | { kind: "define_blueprint"; blueprint: Omit<TopologyBlueprint, "id" | "stats" | "learnedAt"> }
  | { kind: "evolve_blueprint"; sourceBlueprintId: string;
      mutations: BlueprintMutation; description: string }
  | { kind: "record_strategy"; strategy: SchedulingStrategy }
```

These are kept as-is. Memory is a separate concern from topology.

## Testing Strategy

### Reconciler unit tests
- Empty → topology: spawns everything, wires edges
- Same topology twice: zero effects (idempotent)
- Remove a task: kill effect
- Add a task: spawn + activate effects
- Inflight process removed: drain effect (not kill)
- Inflight process kept: no effects (matched by name)
- Gate condition not met: gated nodes not spawned
- Gate condition met: gated nodes spawned + activated
- Priority change on existing task: update effect
- Seq dependency not yet complete: spawn but don't activate

### Flatten unit tests
- `task(A)` → 1 node, 0 edges
- `seq(A, B, C)` → 3 nodes, edges A→B, B→C
- `par(A, B, C)` → 3 nodes, 0 edges
- `seq(par(A, B), C)` → 3 nodes, edges A→C, B→C
- Nested: `seq(par(A, gate(cond, B)), seq(C, D))` → correct edges at every level

### Validator unit tests
- Valid topologies pass
- Duplicate names rejected
- Empty seq/par rejected
- Nested gates with valid conditions pass
- Deadlock detection (gate depends on gated node's output)

### Property-based tests (fast-check)
- For any topology, flatten produces a valid DAG (no cycles)
- For any (current, desired), reconcile effects are idempotent
- reconcile(empty, T) then reconcile(result, T) → zero effects
- Every spawned process has its dependency edges wired
- No process activated before dependencies satisfied
- Validation accepts all well-formed expressions, rejects all malformed ones

## Non-Goals

- Sub-kernel internal topology management (each sub-kernel has its own metacog)
- Memory/learning system redesign (kept as-is)
- Awareness daemon changes (unchanged)
- Ephemeral system changes (unchanged)
