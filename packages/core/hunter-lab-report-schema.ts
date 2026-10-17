import { z } from "zod";
import { cohortIdSchema } from "./hunter-cohort-schema";
import { cohortReportSchema } from "./hunter-cohort-report-schema";
export const labReportSchema=z.object({schemaVersion:z.literal(1),reportId:cohortIdSchema,runId:cohortIdSchema,planId:cohortIdSchema,experimentId:cohortIdSchema,stage:z.enum(["training","validation","test"]),inputHash:cohortIdSchema,methodVersion:z.literal("lab-comparison-v1"),baseline:cohortReportSchema,experiment:cohortReportSchema,
  period:z.object({from:z.string(),to:z.string()}),costPerTrade:z.number(),candidateAgreement:z.number().nullable(),candidateJaccard:z.number().nullable(),missingFeatureRate:z.number(),evaluatedPairs:z.number(),sufficient:z.boolean(),trialCount:z.number().int(),comparisons:z.array(z.object({horizon:z.number(),marketMean:z.number().nullable(),baselineExcess:z.number().nullable(),experimentExcess:z.number().nullable(),candidateMeanDifference:z.number().nullable(),pairedDates:z.number().int()})),notes:z.array(z.string()),statements:z.array(z.object({text:z.string(),evidenceId:cohortIdSchema})),evidenceId:cohortIdSchema}).strict();
export type LabReport=z.infer<typeof labReportSchema>;
