import { z } from "zod";
import type { ApiSchemaSet } from "./types.js";

export const createRunSchema = z
  .object({
    goal: z.string().min(1),
    metacogContext: z.string().optional(),
    provider: z.enum(["claude", "codex"]).optional(),
    configPath: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

export const runIdParamsSchema = z
  .object({
    runId: z.string().min(1),
  })
  .strict();

export const paginationLimitSchema = z.coerce.number().int().positive();

export const eventsQuerySchema = z
  .object({
    limit: paginationLimitSchema.max(2000).optional(),
  })
  .strict();

export const runsApiSchemas: ApiSchemaSet = {
  createRun: createRunSchema,
  runIdParams: runIdParamsSchema,
  eventsQuery: eventsQuerySchema,
};

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type RunIdParams = z.infer<typeof runIdParamsSchema>;
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
