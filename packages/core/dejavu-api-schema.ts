import { z } from "zod";
import { predictionSchema } from "./index";

import { dejavuConsensusSchema, dejavuDnaSchema } from "./dejavu-stat-schema";
export { dejavuConsensusSchema, dejavuDnaSchema } from "./dejavu-stat-schema";
const finite = z.number().finite();
const nullable = finite.nullable();
const optionalError = z.string().optional();
export const dejavuResultSchema = z.object({
  notificationWarning: z.string().optional(), recordId: z.string(), providerCode: z.string(), compareCode: z.string(), mode: z.string(),
  asOf: z.string().date(), cutoff: z.string(), featureVersion: z.string(), sampleCount: finite, candidateCount: finite,
  query: z.object({ shape: z.array(finite) }),
  examples: z.array(z.object({ id: z.string(), providerCode: z.string(), start: z.string(), end: z.string(), score: finite, shape: z.array(finite), futureShape: z.array(finite), future: z.record(z.string(), nullable) })),
  consensus: dejavuConsensusSchema, dna: dejavuDnaSchema,
  statistics: z.object({
    methodVersion: z.string(),
    comparisons: z.array(dejavuConsensusSchema.extend({ requestedCount: z.number().int().positive() })),
  }).optional(),
});
export const dejavuEvaluationListSchema = z.array(predictionSchema.and(z.object({
  evaluations: z.array(z.object({ actualReturn: finite, returnError: finite, directionMatch: z.boolean(), inRange: z.boolean() })),
  state: z.object({ status: z.string() }),
})));
export const dejavuExplanationSchema = z.object({
  summary: z.string(), caution: z.string(),
  reflections: z.object({ search: z.string(), error: optionalError, memories: z.array(z.object({ recordId: z.string(), text: z.string(), interpretation: z.string() })) }),
});
// Shared with recall: accept both original and compact remote envelopes.
export const dejavuMemorySchema = z.object({
  kind: z.literal("dejavu_memory"), active: z.literal(true),
  recordId: z.string().regex(/^[a-f0-9]{64}$/), mode: z.string(),
  providerCode: z.string(), namespace: z.string(), createdAt: z.string().datetime(),
  dataAsOf: z.string().date(), text: z.string(),
  payload: z.object({
    recordId: z.string(), asOf: z.string().date(), mode: z.string(), providerCode: z.string(),
    featureVersion: z.literal("ohlcv-20-v1"),
    examples: z.array(z.object({ start: z.string(), end: z.string(), score: finite.min(0).max(100) })),
  }),
});
export const dejavuMemoriesSchema = z.object({ search: z.string(), error: optionalError, memories: z.array(dejavuMemorySchema) });
export const dejavuForecastResponseSchema = z.object({ records: z.array(predictionSchema), syncError: optionalError });
export const dejavuSaveResponseSchema = z.object({ sync: z.object({ status: z.string() }), error: optionalError });
export const evaluationResponseSchema = z.object({ syncError: optionalError });
