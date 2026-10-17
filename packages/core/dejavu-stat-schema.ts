import { z } from "zod";
const finite = z.number().finite();
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
