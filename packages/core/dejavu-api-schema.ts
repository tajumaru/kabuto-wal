import { z } from "zod";
import { predictionSchema } from "./index";

const finite = z.number().finite();
const optionalError = z.string().optional();
const nullable = finite.nullable();
const horizonSchema = z.object({
  sampleCount: z.number().int().nonnegative(), up: finite, down: finite, flat: finite,
  upRatio: nullable, medianReturn: nullable, meanReturn: nullable, minReturn: nullable, maxReturn: nullable,
  percentileRange: z.array(finite).nullable(), weightedReturn: nullable, consensusScore: nullable, reliability: z.string(),
});
export const dejavuConsensusSchema = z.object({
  methodVersion: z.string(), weightPower: finite, selection: z.string(), exampleIds: z.array(z.string()),
  horizons: z.object({ 1: horizonSchema, 5: horizonSchema, 20: horizonSchema }),
  trajectory: z.array(z.object({ day: finite, sampleCount: finite, median: nullable, lower: nullable, upper: nullable })),
});
export const dejavuDnaSchema = z.array(z.object({
  exampleId: z.string(), score: finite, mostSimilar: z.string().optional(), mostDifferent: z.string().optional(), explanation: z.string(),
  elements: z.array(z.object({ key: z.string(), label: z.string(), distance: nullable, similarity: nullable, weight: finite, contribution: nullable })),
}));
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
