import { z } from "zod";
import { bottomAnalysisSchema } from "./bottom-schema";
import { SCOUT_METHOD } from "./bottom-scout-score";
export const scoutId = z.string().regex(/^[a-f0-9]{64}$/);
const number = z.number().finite(),
  nullable = number.nullable();
export const scoutSimilarSchema = z.object({
  methodVersion: z.literal("scout-dejavu-5-10-20-v1"),
  sampleCount: z.number().int(),
  bestSimilarity: nullable,
  lowSample: z.boolean(),
  horizons: z.array(
    z.object({
      sessions: z.union([z.literal(5), z.literal(10), z.literal(20)]),
      count: z.number().int(),
      meanReturn: nullable,
      medianReturn: nullable,
      upRatio: nullable,
      worstDecline: nullable,
    }),
  ),
  examples: z
    .array(
      z.object({
        id: z.string(),
        start: z.string().date(),
        end: z.string().date(),
        similarity: number,
        returns: z.record(z.string(), number),
        shape: z.array(number),
        futureShape: z.array(number),
      }),
    )
    .max(5),
  queryShape: z.array(number),
  warnings: z.array(z.string()),
});
export const scoutRowSchema = z.object({
  hunterJobId: z.string().uuid().nullable(),
  code: z.string().regex(/^[0-9A-Z]{5}$/),
  name: z.string(),
  asOf: z.string().date(),
  observedAt: z.string().nullable(),
  score: number.min(0).max(100),
  candidate: z.boolean(),
  contributions: bottomAnalysisSchema.shape.conditions,
  indicators: z.record(z.string(), nullable),
  risks: z.array(z.string()),
  inputRevisionIds: z.array(z.string()),
  seriesId: z.string().nullable(),
  similar: scoutSimilarSchema.nullable(),
  chart: z.array(z.object({ date: z.string(), close: number })).max(20),
});
export const scoutScopeSchema = z.object({
  total: z.number().int(),
  examined: z.number().int(),
  analyzable: z.number().int(),
  maxSymbols: z.number().int(),
  source: z.enum(["saved-master", "hunter-snapshot"]),
  excluded: z.record(z.string(), z.number().int()),
  partial: z.boolean(),
});
export const scoutReportSchema = z.object({
  schemaVersion: z.literal(1),
  methodVersion: z.literal(SCOUT_METHOD),
  reportId: scoutId,
  inputHash: scoutId,
  createdAt: z.string().datetime(),
  asOf: z.string().date(),
  cutoff: z.string().datetime(),
  mode: z.enum(["demo", "research"]),
  recordingMode: z.enum(["live", "research"]),
  scope: scoutScopeSchema,
  rows: z.array(scoutRowSchema).max(200),
  notes: z.array(z.string()),
});
export type ScoutReport = z.infer<typeof scoutReportSchema>;
export const scoutReviewSchema = z.object({
  methodVersion: z.literal("scout-outcome-v2").optional(),
  forecastId: scoutId.optional(),
  evaluationId: scoutId.optional(),
  reportId: scoutId,
  asOf: z.string().date(),
  evaluatedAt: z.string().datetime(),
  benchmarkCode: z.string().nullable(),
  groups: z.array(
    z.object({
      horizon: z.number(),
      band: z.string(),
      candidate: z.boolean(),
      eligible: z.number(),
      evaluated: z.number(),
      meanReturn: nullable,
      medianReturn: nullable,
      upRatio: nullable,
      worstDecline: nullable,
      meanBenchmarkDifference: nullable,
      lowSample: z.boolean(),
    }),
  ),
  rows: z.array(
    z.object({
      code: z.string(),
      horizon: z.number(),
      status: z.enum(["evaluated", "pending", "unavailable"]),
      reason: z.string(),
      actualReturn: nullable,
      maxDecline: nullable,
      benchmarkReturn: nullable,
      revisionIds: z.array(z.string()),
      target: z.string().nullable().optional(),
      up: z.boolean().nullable().optional(),
      maxRise: nullable.optional(),
      maxDrawdown: nullable.optional(),
      relapse: z.boolean().nullable().optional(),
      basePrice: nullable.optional(),
      targetPrice: nullable.optional(),
      dataAvailableAt: z.string().nullable().optional(),
      benchmarkRevisionIds: z.array(z.string()).optional(),
    }),
  ),
  notes: z.array(z.string()),
});
export const scoutReplySchema = z.object({
  recordingMode: z.enum(["live","research"]).optional(),
  methodVersion: z.literal(SCOUT_METHOD),
  status: z.enum([
    "ready",
    "no-candidates",
    "insufficient-data",
    "clarification",
    "review",
  ]),
  intent: z.enum(["ranking", "detail", "review"]),
  requestedCount: z.number().int(),
  requestedAsOf: z.string().nullable(),
  asOf: z.string().nullable(),
  answeredAt: z.string().datetime(),
  reportId: scoutId.nullable(),
  mode: z.enum(["demo", "research"]),
  source: z.enum(["fixture", "jquants-v2"]),
  scope: scoutScopeSchema.nullable(),
  rows: z.array(scoutRowSchema).max(10),
  review: scoutReviewSchema.nullable(),
  memoryReferences: z
    .array(z.object({ recordId: z.string(), reportId: scoutId }))
    .max(10),
  notes: z.array(z.string()),
});
export type ScoutReply = z.infer<typeof scoutReplySchema>;
