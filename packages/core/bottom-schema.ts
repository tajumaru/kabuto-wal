import { z } from "zod";

export const bottomQuerySchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9]{4,5}$/),
    asOf: z.string().date().optional(),
  })
  .strict();
export const bottomAnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("bottom_analysis"),
  providerCode: z.string(),
  mode: z.enum(["demo", "research"]),
  source: z.string(),
  dataAsOf: z.string().nullable(),
  observedAt: z.string().nullable(),
  cutoff: z.string(),
  requestedAsOf: z.string().nullable(),
  status: z.enum(["ready", "unavailable"]),
  reasonCodes: z.array(z.string()),
  riskCodes: z.array(z.string()),
  score: z.number().int().min(0).max(100).nullable(),
  stage: z.string(),
  featureVersion: z.string(),
  methodVersion: z.string(),
  configHash: z.string(),
  inputRevisionIds: z.array(z.string()),
  calibratedProbability: z.null(),
  candidatePrerequisite: z.boolean(),
  liquidity: z.enum(["unknown", "sufficient", "low"]),
  averageTurnover20: z.number().nonnegative().nullable().optional(),
  adjustmentVersion: z.string().nullable().optional(),
  conditions: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      met: z.boolean(),
      maxPoints: z.number(),
      earnedPoints: z.number(),
    }),
  ),
  indicators: z.record(z.string(), z.number().finite().nullable()).nullable(),
  chart: z.array(
    z.object({
      sessionDate: z.string(),
      close: z.number(),
      sma5: z.number().nullable(),
      sma20: z.number().nullable(),
      open: z.number().optional(), high: z.number().optional(), low: z.number().optional(), volume: z.number().optional(),
    }),
  ),
});
export type BottomAnalysis = z.infer<typeof bottomAnalysisSchema>;
