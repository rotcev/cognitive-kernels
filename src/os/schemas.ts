/**
 * JSON Schema definitions for structured output from LLM process turns and metacog evaluations.
 * These schemas are passed as `outputSchema` to BrainThread.run() to get structured JSON back.
 */

export const PROCESS_TURN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["continue", "sleeping", "idle", "checkpoint", "exit"],
      description: "Process status after this turn",
    },
    progressSummary: {
      type: "string",
      description: "Brief summary of what was accomplished this turn",
    },
    commands: {
      type: "array",
      description: "OS commands to execute after this turn",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "sleep",
              "idle",
              "checkpoint",
              "spawn_child",
              "spawn_graph",
              "spawn_ephemeral",
              "bb_write",
              "bb_read",
              "signal_emit",
              "request_kernel",
              "exit",
              "self_report",
              "spawn_system",
              "spawn_kernel",
              "cancel_defer",
            ],
          },
          // sleep
          durationMs: { type: "number" },
          // idle
          wakeOnSignals: { type: "array", items: { type: "string" } },
          // self_report
          efficiency: { type: "number" },
          blockers: { type: "array", items: { type: "string" } },
          resourcePressure: { type: "string", enum: ["low", "medium", "high"] },
          suggestedAction: { type: "string", enum: ["continue", "need_help", "should_die", "need_more_budget"] },
          // spawn_child
          descriptor: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["daemon", "lifecycle", "event"] },
              name: { type: "string" },
              objective: { type: "string" },
              priority: { type: "number" },
              completionCriteria: { type: "array", items: { type: "string" } },
              capabilities: {
                type: "object",
                properties: {
                  observationTools: { type: "array", items: { type: "string" } },
                },
              },
            },
            required: ["type", "name", "objective"],
          },
          // spawn_graph — declare a full process topology as a DAG
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["daemon", "lifecycle", "event"] },
                objective: { type: "string" },
                priority: { type: "number" },
                completionCriteria: { type: "array", items: { type: "string" } },
                after: { type: "array", items: { type: "string" } },
                capabilities: {
                  type: "object",
                  properties: {
                    observationTools: { type: "array", items: { type: "string" } },
                  },
                },
              },
              required: ["name", "type", "objective", "after"],
            },
          },
          // spawn_ephemeral
          objective: { type: "string" },
          model: { type: "string" },
          // name is reused from spawn_child.descriptor — already a string field at the command level
          name: { type: "string" },
          // bb_write / bb_read
          key: { type: "string" },
          keys: { type: "array", items: { type: "string" } },
          value: {},
          // signal_emit
          signal: { type: "string" },
          payload: {},
          // request_kernel
          question: { type: "string" },
          // exit
          code: { type: "number" },
          reason: { type: "string" },
          completionCriteriaMet: { type: "boolean" },
          // spawn_system
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          env: { type: "object" },
          // spawn_kernel
          goal: { type: "string" },
          maxTicks: { type: "number" },
        },
        required: ["kind"],
      },
    },
  },
  required: ["status", "progressSummary", "commands"],
} as const;

export const METACOG_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    assessment: {
      type: "string",
      description: "Overall assessment of system state and progress toward the goal",
    },
    topology: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "JSON-encoded topology expression using primitives (task, seq, par, gate). Set to null if no changes needed. Example: {\"type\":\"par\",\"children\":[{\"type\":\"task\",\"name\":\"worker-1\",\"objective\":\"do X\"}]}",
    },
    memory: {
      type: "array",
      description: "Learning commands (learn, define_blueprint, evolve_blueprint, record_strategy)",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["learn", "define_blueprint", "evolve_blueprint", "record_strategy"],
          },
          heuristic: { type: "string" },
          confidence: { type: "number" },
          context: { type: "string" },
          scope: { type: "string", enum: ["global", "local"] },
          blueprint: { type: "string", description: "JSON-encoded blueprint object" },
          sourceBlueprintId: { type: "string" },
          mutations: { type: "string", description: "JSON-encoded mutations object" },
          description: { type: "string" },
          strategy: { type: "string", description: "JSON-encoded strategy object" },
        },
        required: ["kind"],
      },
    },
    halt: {
      anyOf: [
        {
          type: "object",
          properties: {
            status: { type: "string", enum: ["achieved", "unachievable", "stalled"] },
            summary: { type: "string" },
          },
          required: ["status", "summary"],
        },
        { type: "null" },
      ],
      description: "Stop the system. Null if not halting.",
    },
    citedHeuristicIds: {
      type: "array",
      description: "IDs of heuristics that influenced your decisions",
      items: { type: "string" },
    },
    nextEvalDelayMs: {
      anyOf: [{ type: "number" }, { type: "null" }],
      description: "Milliseconds until the next metacog evaluation. Use shorter delays (5-15s) when workers are about to complete or topology needs attention. Use longer delays (60-120s) when workers are mid-execution and no intervention is needed. Null uses the default interval.",
    },
  },
  required: ["assessment", "topology", "memory", "halt", "citedHeuristicIds"],
} as const;

export const AWARENESS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reflection: {
      type: "string",
      description: "The daemon's self-aware assessment of metacog's cognitive patterns",
    },
    notes: {
      type: "array",
      description: "Notes to inject into metacog's next context",
      items: { type: "string" },
    },
    flaggedHeuristics: {
      type: "array",
      description: "Heuristics flagged as suspicious",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "reason"],
      },
    },
    adjustments: {
      type: "array",
      description: "Recommended adjustments to metacog behavior",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "adjust_kill_threshold",
              "suggest_metacog_focus",
              "flag_overconfident_heuristic",
              "detect_oscillation",
              "detect_blind_spot",
              "noop",
            ],
          },
          delta: { type: "number" },
          area: { type: "string" },
          heuristicId: { type: "string" },
          statedConfidence: { type: "number" },
          observedAccuracy: { type: "number" },
          processType: { type: "string" },
          killCount: { type: "number" },
          respawnCount: { type: "number" },
          windowTicks: { type: "number" },
          unusedCommandKind: { type: "string" },
          ticksSinceLastUse: { type: "number" },
          reason: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["kind"],
      },
    },
  },
  required: ["reflection", "notes", "flaggedHeuristics", "adjustments"],
} as const;
