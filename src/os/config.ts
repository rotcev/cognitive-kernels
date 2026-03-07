import { z } from "zod";
import os from "node:os";
import type { OsConfig, OsMetacogTrigger } from "./types.js";

const withObjectDefaults = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value ?? {}, schema);

const osKernelSchema = z.object({
  tickIntervalMs: z.number().int().positive().default(100),
  maxConcurrentProcesses: z.number().int().positive().default(3),
  metacogCadence: z.number().int().positive().default(3),
  metacogModel: z.string().default("claude-sonnet-4-6"),
  processModel: z.string().default("claude-sonnet-4-6"),
  tokenBudget: z.number().int().positive().default(100000000),
  processTokenBudgetEnabled: z.boolean().default(false),
  wallTimeLimitMs: z.number().int().nonnegative().default(0),  // 0 = no limit (long-horizon work)
  telemetryEnabled: z.boolean().default(true),
  tickSignalCadences: z.array(z.number().int().positive()).default([1, 5, 10]),
  watchdogIntervalMs: z.number().int().positive().default(300000),
  housekeepIntervalMs: z.number().int().positive().default(500),
  metacogIntervalMs: z.number().int().positive().default(300000),
  snapshotIntervalMs: z.number().int().positive().default(10000),
}).strict();

const osSchedulerSchema = z.object({
  strategy: z.enum(["priority", "round-robin", "deadline", "learned"]).default("learned"),
  maxConcurrentProcesses: z.number().int().positive().default(3),
  tickIntervalMs: z.number().int().positive().default(100),
  metacogCadence: z.number().int().positive().default(3),
  metacogTriggers: z.array(z.enum([
    "process_failed", "dag_deadlock", "resource_exhaustion",
    "ipc_timeout", "priority_conflict", "checkpoint_restore",
    "goal_drift", "novel_situation", "tick_stall", "observation_failed",
  ])).default(["process_failed", "dag_deadlock", "resource_exhaustion"]),
}).strict();

const osIpcSchema = z.object({
  blackboardMaxKeys: z.number().int().positive().default(1000),
}).strip();

const osMemorySchema = z.object({
  snapshotCadence: z.number().int().positive().default(10),
  heuristicDecayRate: z.number().min(0).max(1).default(0.05),
  heuristicPruneThreshold: z.number().min(0).max(1).default(0.1),
  maxHeuristics: z.number().int().positive().default(500),
  consolidationIntervalTicks: z.number().int().positive().default(100),
  basePath: z.string().default("~/.cognitive-kernels/os"),
}).strict();

const osProcessesSchema = z.object({
  maxDepth: z.number().int().positive().default(5),
  maxTotalProcesses: z.number().int().positive().default(50),
  defaultPriority: z.number().int().min(0).max(100).default(50),
}).strict();

const osEphemeralSchema = z.object({
  enabled: z.boolean().default(true),
  maxPerProcess: z.number().int().positive().default(8),
  maxConcurrent: z.number().int().positive().default(3),
  defaultModel: z.string().default("claude-haiku-4-5-20251001"),
}).strict();

const osSystemProcessSchema = z.object({
  enabled: z.boolean().default(true),
  maxSystemProcesses: z.number().int().positive().default(10),
  stdoutBufferLines: z.number().int().positive().default(200),
}).strict();

const osChildKernelSchema = z.object({
  enabled: z.boolean().default(false),
  maxChildKernels: z.number().int().positive().default(3),
  defaultMaxTicks: z.number().int().positive().default(50),
  ticksPerParentTurn: z.number().int().positive().default(5),
  maxDepth: z.number().int().positive().default(1),
}).strict();

const osAwarenessSchema = z.object({
  enabled: z.boolean().default(true),
  cadence: z.number().int().positive().default(2),
  historyWindow: z.number().int().positive().default(50),
  model: z.string().default("claude-sonnet-4-6"),
}).strict();

const osObservationSchema = z.object({
  enabled: z.boolean().default(true),
  browserMcp: withObjectDefaults(z.object({
    command: z.string().default("npx"),
    args: z.array(z.string()).default(["concurrent-browser-mcp", "--no-headless"]),
    env: z.record(z.string(), z.string()).optional(),
    maxInstances: z.number().int().positive().default(5),
  })),
  defaultModel: z.string().default("claude-sonnet-4-6"),
}).strict();

export const osConfigSchema = z.object({
  enabled: z.boolean().default(false),
  kernel: withObjectDefaults(osKernelSchema),
  scheduler: withObjectDefaults(osSchedulerSchema),
  ipc: withObjectDefaults(osIpcSchema),
  memory: withObjectDefaults(osMemorySchema),
  processes: withObjectDefaults(osProcessesSchema),
  ephemeral: withObjectDefaults(osEphemeralSchema),
  systemProcess: withObjectDefaults(osSystemProcessSchema),
  childKernel: withObjectDefaults(osChildKernelSchema),
  awareness: withObjectDefaults(osAwarenessSchema),
  observation: withObjectDefaults(osObservationSchema),
}).strict();

function resolveBasePath(config: z.infer<typeof osConfigSchema>): OsConfig {
  const homeDir = os.homedir();
  return {
    ...config,
    memory: {
      ...config.memory,
      basePath: config.memory.basePath.replace(/^~(?=$|\/|\\)/, homeDir),
    },
  } as OsConfig;
}

export function parseOsConfig(raw: unknown): OsConfig {
  const parsed = osConfigSchema.parse(raw);
  return resolveBasePath(parsed);
}

export const DEFAULT_OS_CONFIG: OsConfig = parseOsConfig({});
