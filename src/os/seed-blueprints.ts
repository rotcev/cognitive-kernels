import type { TopologyBlueprint } from "./types.js";

/**
 * Seed blueprints — the initial population of topology patterns.
 * These encode the three patterns that were previously hardcoded
 * in process-executor.ts buildStrategySection().
 *
 * They start with zero stats and earn their track record like
 * any metacog-invented or orchestrator-invented blueprint.
 */

const EMPTY_STATS = {
  uses: 0,
  successes: 0,
  failures: 0,
  avgTokenEfficiency: 0,
  avgWallTimeMs: 0,
  lastUsedAt: "",
  alpha: 1,
  beta: 1,
  tagStats: {} as Record<string, { alpha: number; beta: number; observations: number }>,
};

export const SEED_PARALLEL: TopologyBlueprint = {
  id: "seed-parallel",
  name: "parallel",
  description:
    "N independent workers execute in parallel with no inter-process dependencies. " +
    "Each worker publishes results to the blackboard independently. " +
    "Best for tasks that decompose into independent subtasks with no data flow between them.",
  source: "seed",

  applicability: {
    goalPatterns: ["build", "implement", "create", "generate", "write", "analyze"],
    minSubtasks: 2,
    maxSubtasks: 10,
    requiresSequencing: false,
  },

  roles: [
    {
      name: "worker-{i}",
      type: "lifecycle",
      cardinality: "per-subtask",
      priorityOffset: -2,  // -2 per sibling: 87, 85, 83, ...
      objectiveTemplate: "{subtask}. Write results to blackboard key 'result:{name}'.",
      spawnTiming: "immediate",
    },
  ],
  gatingStrategy: "priority-only",
  priorityStrategy: "gradient-2pt",

  stats: { ...EMPTY_STATS },
  learnedAt: "2026-02-27T00:00:00.000Z",
};

export const SEED_PIPELINE: TopologyBlueprint = {
  id: "seed-pipeline",
  name: "pipeline",
  description:
    "Sequential chain where each stage feeds the next via blackboard and signals. " +
    "Stage A produces output, writes to blackboard and signals completion. Stage B waits for the signal, " +
    "reads the blackboard, processes, and signals the next stage. " +
    "Best for tasks with strict ordering requirements where each step depends on the previous.",
  source: "seed",

  applicability: {
    goalPatterns: ["transform", "migrate", "process", "convert", "pipeline", "chain"],
    minSubtasks: 2,
    maxSubtasks: 6,
    requiresSequencing: true,
  },

  roles: [
    {
      name: "stage-{i}",
      type: "lifecycle",
      cardinality: "per-subtask",
      priorityOffset: -2,  // higher priority for earlier stages
      objectiveTemplate:
        "{subtask}. Write results to blackboard key 'result:{name}'. " +
        "When done, signal_emit 'stage:{name}:done'.",
      spawnTiming: "immediate",
      wakeCondition: { signals: ["stage:{prev_stage}:done"] },
    },
  ],
  gatingStrategy: "signal-gate",
  priorityStrategy: "gradient-2pt-descending",

  stats: { ...EMPTY_STATS },
  learnedAt: "2026-02-27T00:00:00.000Z",
};

export const SEED_FAN_OUT_FAN_IN: TopologyBlueprint = {
  id: "seed-fan-out-fan-in",
  name: "fan-out-fan-in",
  description:
    "N parallel workers plus 1 synthesis worker. Workers execute independently and publish to blackboard. " +
    "Synthesis worker idles on child:done signals until all workers complete, then reads blackboard " +
    "and produces combined output. Best for research, analysis, and any task requiring multiple " +
    "perspectives merged into a coherent result.",
  source: "seed",

  applicability: {
    goalPatterns: ["research", "analyze", "compare", "evaluate", "explore", "investigate", "reflect"],
    minSubtasks: 2,
    maxSubtasks: 8,
    requiresSequencing: false,
  },

  roles: [
    {
      name: "worker-{i}",
      type: "lifecycle",
      cardinality: "per-subtask",
      priorityOffset: -2,  // 87, 85, 83, ...
      objectiveTemplate:
        "{subtask}. Write findings to blackboard key 'result:{name}'. " +
        "Be thorough — your work will be synthesized with other workers.",
      spawnTiming: "immediate",
    },
    {
      name: "synthesizer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -20,  // well below all workers
      objectiveTemplate:
        "Synthesize results from all workers into a coherent final output. " +
        "Read all blackboard keys starting with 'result:'. " +
        "Write final synthesis to blackboard key 'final_result'. {synthesis_instructions}",
      wakeCondition: { signals: ["child:done"] },
      spawnTiming: "immediate",
    },
  ],
  gatingStrategy: "signal-gate",
  priorityStrategy: "workers-high-synthesis-low",

  stats: { ...EMPTY_STATS },
  learnedAt: "2026-02-27T00:00:00.000Z",
};

export const SEED_CLOSED_LOOP_DEV: TopologyBlueprint = {
  id: "seed-closed-loop-dev",
  name: "closed-loop-dev",
  description:
    "Infrastructure-first with INTERLEAVED observation at every phase. The topology " +
    "ALTERNATES between production and observation — NOT batch-all-then-observe. " +
    "Pattern: infra → infra-observer → phase-1 workers → phase-1-observer → " +
    "phase-2 workers → phase-2-observer → ... → final-observer. " +
    "Each observer gates on its SPECIFIC producer(s) via process_dead_by_name. " +
    "Downstream phases gate on OBSERVER PASSING (observation:passed:*), NOT on producer " +
    "completing. Decompose by layer/phase, NOT by subsystem. Shell processes provide " +
    "continuous feedback; observers interact with running infrastructure.",
  source: "seed",

  applicability: {
    goalPatterns: ["build", "implement", "create", "develop", "app", "server", "website", "api", "fullstack"],
    minSubtasks: 2,
    maxSubtasks: 10,
    requiresSequencing: true,
  },

  // Roles model a 2-phase template with infrastructure. Adapt the number of phases
  // to the task. The KEY invariant: every phase followed by observer, next phase
  // gates on observer passing.
  roles: [
    {
      name: "infra-{i}",
      type: "lifecycle",
      cardinality: "per-subtask",
      priorityOffset: 0,
      objectiveTemplate:
        "Spawn shell infrastructure via spawn_system for: {subtask}. " +
        "Once the process is running, bb_write key 'infra:{name}:ready' with value true, then exit. " +
        "The shell process persists independently after you exit.",
      spawnTiming: "immediate",
    },
    {
      name: "infra-observer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -2,
      objectiveTemplate:
        "Verify that infrastructure is healthy BEFORE any implementation begins. " +
        "Read shell output keys (shell:*:stdout, shell:*:stderr) and infra readiness keys. " +
        "Check that all expected processes are running and responsive. " +
        "Write results to 'observation:infra'. " +
        "If healthy, bb_write 'observation:passed:infra-observer' = true and " +
        "signal_emit 'observation:passed:infra-observer'. " +
        "If problems, write diagnosis to 'observation:diagnosis:infra-observer' " +
        "and signal_emit 'observation:failed:infra-observer'. {observation_instructions}",
      // Orchestrator defers this with: all_of [process_dead_by_name for each infra worker]
      wakeCondition: { signals: ["observation:passed:infra-observer"] },
      spawnTiming: "after-dependencies",
      capabilities: { observationTools: ["shell"] },
    },
    {
      name: "phase-1-{i}",
      type: "lifecycle",
      cardinality: "per-subtask",
      priorityOffset: -6,
      objectiveTemplate:
        "{subtask}. After each change, bb_read shell output keys (shell:*:stdout, shell:*:stderr) " +
        "to check for errors. Fix any errors and iterate until clean. " +
        "Write results to blackboard key 'result:{name}'.",
      wakeCondition: { signals: ["observation:passed:infra-observer"] },
      spawnTiming: "after-dependencies",
    },
    {
      name: "phase-1-observer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -12,
      objectiveTemplate:
        "Verify that phase-1 outputs compose correctly with running infrastructure. " +
        "Read shell output keys and phase-1 results (result:phase-1-*). Interact with " +
        "running services to confirm behavioral correctness, not just structural. " +
        "Write results to 'observation:phase-1'. " +
        "If sound, bb_write 'observation:passed:phase-1-observer' = true and " +
        "signal_emit 'observation:passed:phase-1-observer'. " +
        "If problems, write diagnosis to 'observation:diagnosis:phase-1-observer' " +
        "and signal_emit 'observation:failed:phase-1-observer'. {observation_instructions}",
      // Orchestrator defers with: all_of [process_dead_by_name for each phase-1 worker]
      wakeCondition: { signals: ["observation:passed:infra-observer"] },
      spawnTiming: "after-dependencies",
      capabilities: { observationTools: ["browser", "shell"] },
    },
    {
      name: "phase-2-{i}",
      type: "lifecycle",
      cardinality: "per-subtask",
      priorityOffset: -16,
      objectiveTemplate:
        "{subtask}. Build on verified phase-1 foundations. Read shell output and prior " +
        "results. Write results to blackboard key 'result:{name}'.",
      wakeCondition: { signals: ["observation:passed:phase-1-observer"] },
      spawnTiming: "after-dependencies",
    },
    {
      name: "phase-2-observer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -20,
      objectiveTemplate:
        "Verify phase-2 outputs compose with phase-1 and infrastructure. Interact with " +
        "the live artifact. Cover anything phase-1-observer noted as unverifiable. " +
        "Write results to 'observation:phase-2'. " +
        "If sound, bb_write 'observation:passed:phase-2-observer' = true and " +
        "signal_emit 'observation:passed:phase-2-observer'. " +
        "If problems, write diagnosis to 'observation:diagnosis:phase-2-observer' " +
        "and signal_emit 'observation:failed:phase-2-observer'. {observation_instructions}",
      // Orchestrator defers with: all_of [process_dead_by_name for each phase-2 worker]
      wakeCondition: { signals: ["observation:passed:phase-1-observer"] },
      spawnTiming: "after-dependencies",
      capabilities: { observationTools: ["browser", "shell"] },
    },
    {
      name: "final-observer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -24,
      objectiveTemplate:
        "Final observation — independently verify the COMPLETE composed artifact. " +
        "Do not trust prior checks — experience the artifact as its audience would. " +
        "Read shell infrastructure keys to find running services. Verify end-to-end. " +
        "Cover anything prior observers noted as unverifiable. " +
        "Write results to 'observation:final'. " +
        "If sound, bb_write 'observation:passed:final-observer' = true and " +
        "signal_emit 'observation:passed:final-observer'. " +
        "If problems, write diagnosis to 'observation:diagnosis:final-observer' " +
        "and signal_emit 'observation:failed:final-observer'. {observation_instructions}",
      wakeCondition: { signals: ["observation:passed:phase-2-observer"] },
      spawnTiming: "after-dependencies",
      capabilities: { observationTools: ["browser", "shell"] },
    },
  ],
  gatingStrategy: "signal-gate",
  priorityStrategy: "infra-high-workers-mid-verify-low",

  stats: { ...EMPTY_STATS },
  learnedAt: "2026-02-28T00:00:00.000Z",
};

export const SEED_CONTRACT_FIRST: TopologyBlueprint = {
  id: "seed-contract-first",
  name: "contract-first",
  description:
    "Phased contract-driven execution with interleaved observation. The topology ALTERNATES " +
    "between production and observation at every phase — NOT batch-all-then-observe. " +
    "Pattern: contracts → contract-observer → phase-1 workers → phase-1-observer → " +
    "phase-2 workers → phase-2-observer → ... → final-observer. Each observer gates on " +
    "its SPECIFIC producer(s) via process_dead_by_name. Downstream work gates on the " +
    "OBSERVER PASSING (blackboard_key_exists observation:passed:*), NOT on the producer " +
    "completing. This catches errors at the source before downstream work builds on them. " +
    "IMPORTANT: decompose by layer/phase (schema, auth, api, frontend-shell, features), " +
    "NOT by subsystem (backend-core, frontend-app). Each phase should be small enough " +
    "to observe meaningfully. Best for composed artifacts: apps, documents, systems.",
  source: "seed",

  applicability: {
    goalPatterns: ["build", "implement", "create", "develop", "app", "fullstack", "system", "platform"],
    minSubtasks: 3,
    maxSubtasks: 12,
    requiresSequencing: true,
  },

  // Roles model a 2-phase template. The orchestrator adapts the number of phases
  // to the task — add more phase/observer pairs for more complex goals.
  // The KEY invariant: every phase is followed by an observer, and the next phase
  // gates on the observer passing.
  roles: [
    {
      name: "contract-designer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: 0,
      objectiveTemplate:
        "Analyze the goal and identify every composition boundary where workers " +
        "will need to agree. For each boundary, define the exact contract: what is produced, " +
        "what is consumed, the shape of the handoff. Write each contract to the blackboard " +
        "as 'contract:{boundary-name}'. When all contracts are defined, bb_write " +
        "'contracts:complete' = true and signal_emit 'contracts:ready'.",
      spawnTiming: "immediate",
    },
    {
      name: "contract-observer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -2,
      objectiveTemplate:
        "Verify the contracts are coherent and complete BEFORE any implementation begins. " +
        "Read all 'contract:*' keys from the blackboard. Check: are all composition " +
        "boundaries covered? Do the contracts contradict? Are handoff shapes precise? " +
        "Write results to 'observation:contracts'. " +
        "If sound, bb_write 'observation:passed:contract-observer' = true and " +
        "signal_emit 'observation:passed:contract-observer'. " +
        "If problems found, write diagnosis to 'observation:diagnosis:contract-observer' " +
        "and signal_emit 'observation:failed:contract-observer'. {observation_instructions}",
      wakeCondition: { signals: ["contracts:ready"] },
      spawnTiming: "after-dependencies",
      capabilities: { observationTools: ["shell"] },
    },
    {
      name: "phase-1-{i}",
      type: "lifecycle",
      cardinality: "per-subtask",
      priorityOffset: -6,
      objectiveTemplate:
        "{subtask}. Read your relevant contracts from the blackboard (keys starting with " +
        "'contract:'). Implement TOWARD the contracts — do not deviate from the agreed " +
        "boundaries. Write results to blackboard key 'result:{name}'. " +
        "When done, bb_write 'phase:1:{name}:done' = true.",
      wakeCondition: { signals: ["observation:passed:contract-observer"] },
      spawnTiming: "after-dependencies",
    },
    {
      name: "phase-1-observer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -12,
      objectiveTemplate:
        "Verify phase-1 outputs compose correctly and conform to contracts. " +
        "Read contracts (contract:*) and phase-1 results (result:phase-1-*). " +
        "Verify behaviorally where possible — not just structural checks. " +
        "Write results to 'observation:phase-1'. " +
        "If sound, bb_write 'observation:passed:phase-1-observer' = true and " +
        "signal_emit 'observation:passed:phase-1-observer'. " +
        "If problems found, write diagnosis to 'observation:diagnosis:phase-1-observer' " +
        "and signal_emit 'observation:failed:phase-1-observer'. {observation_instructions}",
      // Orchestrator should defer this with: all_of [process_dead_by_name for each phase-1 worker]
      wakeCondition: { signals: ["observation:passed:contract-observer"] },
      spawnTiming: "after-dependencies",
      capabilities: { observationTools: ["browser", "shell"] },
    },
    {
      name: "phase-2-{i}",
      type: "lifecycle",
      cardinality: "per-subtask",
      priorityOffset: -16,
      objectiveTemplate:
        "{subtask}. Read contracts and prior phase results from the blackboard. " +
        "Build on verified phase-1 foundations. Write results to 'result:{name}'. " +
        "When done, bb_write 'phase:2:{name}:done' = true.",
      wakeCondition: { signals: ["observation:passed:phase-1-observer"] },
      spawnTiming: "after-dependencies",
    },
    {
      name: "phase-2-observer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -20,
      objectiveTemplate:
        "Verify phase-2 outputs compose correctly with phase-1 and conform to contracts. " +
        "If shell infrastructure is running, interact with the live artifact. " +
        "Write results to 'observation:phase-2'. " +
        "If sound, bb_write 'observation:passed:phase-2-observer' = true and " +
        "signal_emit 'observation:passed:phase-2-observer'. " +
        "If problems found, write diagnosis to 'observation:diagnosis:phase-2-observer' " +
        "and signal_emit 'observation:failed:phase-2-observer'. {observation_instructions}",
      // Orchestrator should defer this with: all_of [process_dead_by_name for each phase-2 worker]
      wakeCondition: { signals: ["observation:passed:phase-1-observer"] },
      spawnTiming: "after-dependencies",
      capabilities: { observationTools: ["browser", "shell"] },
    },
    {
      name: "final-observer",
      type: "lifecycle",
      cardinality: "one",
      priorityOffset: -24,
      objectiveTemplate:
        "Final observation — independently verify the COMPLETE composed artifact in its " +
        "intended context. Do not trust prior checks — experience the artifact as its " +
        "audience would. Read shell infrastructure keys to find running services. " +
        "Cover anything prior observers noted as unverifiable. " +
        "Write results to 'observation:final'. " +
        "If sound, bb_write 'observation:passed:final-observer' = true and " +
        "signal_emit 'observation:passed:final-observer'. " +
        "If problems found, write diagnosis to 'observation:diagnosis:final-observer' " +
        "and signal_emit 'observation:failed:final-observer'. {observation_instructions}",
      wakeCondition: { signals: ["observation:passed:phase-2-observer"] },
      spawnTiming: "after-dependencies",
      capabilities: { observationTools: ["browser", "shell"] },
    },
  ],
  gatingStrategy: "signal-gate",
  priorityStrategy: "contract-high-workers-mid-synthesis-low",

  stats: { ...EMPTY_STATS },
  learnedAt: "2026-03-03T00:00:00.000Z",
};

/** All seed blueprints. */
export const SEED_BLUEPRINTS: TopologyBlueprint[] = [
  SEED_PARALLEL,
  SEED_PIPELINE,
  SEED_FAN_OUT_FAN_IN,
  SEED_CLOSED_LOOP_DEV,
  SEED_CONTRACT_FIRST,
];
