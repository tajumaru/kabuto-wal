import { z } from "zod";
import { cohortIdSchema } from "./hunter-cohort-schema";
export const cohortMetricsSchema=z.object({count:z.number(),evaluated:z.number(),missing:z.number(),pending:z.number(),unavailable:z.number(),upRatio:z.number().nullable(),meanReturn:z.number().nullable(),medianReturn:z.number().nullable(),maxDrawdown:z.number().nullable(),relapseRatio:z.number().nullable()});
export const cohortReportSchema=z.object({reportId:cohortIdSchema,generatedAt:z.string().datetime(),cohortIds:z.array(cohortIdSchema),evaluationIds:z.array(cohortIdSchema),
  groups:z.array(z.object({key:z.string(),mode:z.string(),experiment:z.string(),methodVersion:z.string(),plan:z.string(),horizon:z.number(),candidate:cohortMetricsSchema,control:cohortMetricsSchema,
    difference:z.number().nullable(),interval:z.tuple([z.number(),z.number()]).nullable(),intervalMethod:z.literal("exploratory-code-date-block-bootstrap-v1"),uniqueCodes:z.number(),dates:z.number(),excludedOverlap:z.number(),excludedMembers:z.number(),lowSample:z.boolean(),bands:z.record(z.string(),cohortMetricsSchema),pooledDifference:z.number().nullable().optional(),matchedDates:z.number().optional()})),notes:z.array(z.string()),comparisonMethod:z.literal("paired-v2").optional()}).strict();
export type CohortReport= z.infer<typeof cohortReportSchema>;
