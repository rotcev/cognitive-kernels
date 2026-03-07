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
    commands: {
      type: "array",
      description: "Metacognitive commands to reshape the process topology",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "spawn", "defer", "cancel_defer", "kill", "reprioritize", "rewrite_dag", "learn",
              "define_blueprint", "fork", "evolve_blueprint", "record_strategy",
              "halt", "noop", "delegate_evaluation",
              "spawn_system", "spawn_kernel",
            ],
          },
          // spawn
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
          // kill
          pid: { type: "string" },
          cascade: { type: "boolean" },
          reason: { type: "string" },
          // reprioritize
          priority: { type: "number" },
          // rewrite_dag
          patch: {
            type: "object",
            properties: {
              addNodes: { type: "array" },
              removeNodes: { type: "array", items: { type: "string" } },
              addEdges: { type: "array" },
              removeEdges: { type: "array" },
              updateNodes: { type: "array" },
            },
          },
          // learn
          heuristic: { type: "string" },
          confidence: { type: "number" },
          context: { type: "string" },
          scope: { type: "string", enum: ["global", "local"] },
          // define_blueprint
          blueprint: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              source: { type: "string", enum: ["metacog", "orchestrator"] },
              applicability: {
                type: "object",
                properties: {
                  goalPatterns: { type: "array", items: { type: "string" } },
                  minSubtasks: { type: "number" },
                  maxSubtasks: { type: "number" },
                  requiresSequencing: { type: "boolean" },
                },
              },
              roles: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string", enum: ["daemon", "lifecycle", "event"] },
                    cardinality: { type: "string", enum: ["one", "per-subtask"] },
                    priorityOffset: { type: "number" },
                    objectiveTemplate: { type: "string" },
                    spawnTiming: { type: "string", enum: ["immediate", "after-dependencies"] },
                  },
                  required: ["name", "type", "cardinality", "objectiveTemplate"],
                },
              },
              gatingStrategy: { type: "string" },
              priorityStrategy: { type: "string" },
            },
            required: ["name", "description", "roles"],
          },
          // halt
          status: { type: "string", enum: ["achieved", "unachievable", "stalled"] },
          summary: { type: "string" },
          // noop
          reasoning: { type: "string" },
          // fork — clone a running process for speculative parallel execution
          // pid (required) is already declared above (reused from kill)
          newObjective: { type: "string" },
          newPriority: { type: "number" },
          // evolve_blueprint — derive a new topology blueprint from an existing one
          sourceBlueprintId: { type: "string" },
          mutations: {
            type: "object",
            properties: {
              namePrefix: { type: "string" },
              roleChanges: { type: "string" },
              gatingChange: { type: "string" },
            },
          },
          description: { type: "string" },
          // record_strategy — encode an observed scheduling pattern as a learnable rule
          // context (optional) is already declared above (reused from learn)
          strategyName: { type: "string" },
          outcome: { type: "string", enum: ["success", "failure"] },
          // delegate_evaluation
          evaluationScope: { type: "string" },
          // defer
          condition: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["blackboard_key_exists", "blackboard_key_match", "blackboard_value_contains", "process_dead", "process_dead_by_name", "all_of", "any_of"] },
              key: { type: "string" },
              value: {},
              substring: { type: "string" },
              conditions: { type: "array" },
            },
            required: ["type"],
          },
          maxWaitTicks: { type: "number" },
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
    citedHeuristicIds: {
      type: "array",
      description: "IDs of heuristics from the Relevant Heuristics section that influenced your decisions this evaluation. Only cite heuristics you actually used in your reasoning — this drives the learning signal.",
      items: { type: "string" },
    },
  },
  required: ["assessment", "commands", "citedHeuristicIds"],
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
