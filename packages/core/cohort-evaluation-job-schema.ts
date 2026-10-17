import { z } from "zod";
import { cohortIdSchema } from "./hunter-cohort-schema";
export const cohortEvaluationJobSchema=z.object({runId:cohortIdSchema,cohortId:cohortIdSchema,manifestHash:cohortIdSchema,calendarHash:cohortIdSchema,evaluationCutoff:z.string().datetime(),batchSize:z.literal(25),symbolTotal:z.number().int().nonnegative(),status:z.enum(["queued","running","paused","cancelled","failed","completed"]),processed:z.number().int().nonnegative(),total:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),error:z.string().optional(),lease:z.object({token:z.string().uuid(),pid:z.number(),expiresAt:z.number()}).optional()}).strict();
export type CohortEvaluationJob=z.infer<typeof cohortEvaluationJobSchema>;
