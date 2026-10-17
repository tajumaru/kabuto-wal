import { z } from "zod";
import { bottomAnalysisSchema } from "./bottom-schema";
import { dejavuResultSchema } from "./dejavu-api-schema";
import { predictionSchema } from "./index";

import { HUNTER_METHOD, hunterCategory } from "./hunter-method";
export { HUNTER_METHOD, hunterCategory } from "./hunter-method";
export const hunterCode = z.string().regex(/^[A-Z0-9]{5}$/);
export const universeEntrySchema = z.object({
  code: hunterCode, name: z.string(), market: z.string(), marketName: z.string(),
  productCategory: z.string().nullable(), listingStatus: z.literal("present_at_asof"),
  included: z.boolean(), reasons: z.array(z.string()),
});
export const hunterUniverseSchema = z.object({
  schemaVersion: z.literal(1), methodVersion: z.literal(HUNTER_METHOD),
  id: z.string(), mode: z.enum(["demo", "research"]), asOf: z.string().date(), cutoff: z.string().datetime(),
  masterObservedAt: z.string().datetime().nullable(), inputId: z.string(),
  entries: z.array(universeEntrySchema), excludedReasons: z.record(z.string(), z.number().int().nonnegative()),
});
export const hunterCoverageSchema = z.object({
  schemaVersion: z.literal(1), methodVersion: z.literal(HUNTER_METHOD), jobId: z.string(),
  asOf: z.string().date(), cutoff: z.string().datetime(), mode: z.enum(["demo", "research"]),
  universeCount: z.number(), excludedCount: z.number(), acquiredCount: z.number(), continuous80Count: z.number(),
  analyzedCount: z.number(), candidateCount: z.number(), unavailableCount: z.number(), failedCount: z.number(),
  processedCount: z.number(), delayDays: z.number(), lastObservedAt: z.string().nullable(),
  exclusionReasons: z.record(z.string(), z.number()), complete: z.boolean(),
});
export const hunterRowSchema = z.object({
  schemaVersion: z.literal(1), methodVersion: z.literal(HUNTER_METHOD), jobId: z.string(),
  code: hunterCode, name: z.string(), market: z.string(), marketName: z.string(), rank: z.number().int().nullable(),
  asOf: z.string().date(), cutoff: z.string().datetime(), inputId: z.string(),
  score: z.number().nullable(), category: hunterCategory, candidate: z.boolean(),
  rsi: z.number().nullable(), drawdown: z.number().nullable(), volumeRatio: z.number().nullable(),
  averageTurnover20: z.number().nullable(), liquidity: z.enum(["sufficient", "low", "unknown"]),
  reasons: z.array(z.string()), risks: z.array(z.string()), acquisitionStatus: z.enum(["ready", "missing", "failed"]),
  lastSession: z.string().nullable(), continuousSessions: z.number().int(), observedAt: z.string().nullable(),
  acquisitionError: z.string().optional(),
});
export const hunterJobInputSchema = z.object({
  kind: z.enum(["scan", "initial", "update", "correction"]).default("scan"),
  asOf: z.string().date(), from: z.string().date().optional(),
  cutoff: z.string().datetime().optional(), revision: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  concurrency: z.number().int().min(1).max(4).default(2),
  confirmExternal: z.boolean().default(false),
}).strict().superRefine((v, ctx) => {
  if (v.from && v.from > v.asOf) ctx.addIssue({ code: "custom", message: "開始日は基準日以前です" });
  if (v.kind !== "scan" && !v.from) ctx.addIssue({ code: "custom", message: "取得開始日が必要です" });
  if (v.kind === "correction" && !v.revision) ctx.addIssue({ code: "custom", message: "訂正revisionが必要です" });
});
export const hunterJobSchema = z.object({
  schemaVersion: z.literal(1), methodVersion: z.literal(HUNTER_METHOD), id: z.string().uuid(),
  mode: z.enum(["demo", "research"]), input: hunterJobInputSchema, cutoff: z.string().datetime(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  status: z.enum(["queued", "running", "paused", "cancelled", "failed", "completed"]),
  cancelRequested: z.boolean(), processed: z.number().int(), total: z.number().int(),
  universeId: z.string().optional(), datasetId: z.string().optional(), analysisId: z.string().optional(), error: z.string().optional(),
  lease: z.object({ token: z.string(), pid: z.number(), expiresAt: z.number() }).optional(),
});
export const hunterFilterSchema = z.object({
  jobId: z.string().uuid().optional(), asOf: z.string().date().optional(),
  market: z.string().max(20).optional(), minScore: z.coerce.number().min(0).max(100).optional(),
  rsiMin: z.coerce.number().min(0).max(100).optional(), rsiMax: z.coerce.number().min(0).max(100).optional(),
  maxDrawdown: z.coerce.number().min(-1).max(0).optional(), liquidity: z.enum(["sufficient", "low", "unknown"]).optional(),
  category: hunterCategory.optional(), risk: z.enum(["yes", "no"]).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const hunterRankingsSchema = z.object({
  coverage: hunterCoverageSchema.nullable(), rows: z.array(hunterRowSchema), total: z.number(), page: z.number(), pageSize: z.number(),
});
export const hunterDetailSchema = z.object({ row: hunterRowSchema, analysis: bottomAnalysisSchema, explanation: z.string(), dejavu: dejavuResultSchema.nullable(), dejavuWarning: z.string().optional() });
export const hunterStatusSchema = z.object({ mode: z.enum(["demo", "research"]), plan: z.string(), delayDays: z.number(),
  jobs: z.array(hunterJobSchema), coverage: hunterCoverageSchema.nullable(),
});
export type HunterJob = z.infer<typeof hunterJobSchema>;
export type HunterRow = z.infer<typeof hunterRowSchema>;
export type HunterCoverage = z.infer<typeof hunterCoverageSchema>;
export type HunterUniverse = z.infer<typeof hunterUniverseSchema>;
export type HunterFilter = z.infer<typeof hunterFilterSchema>;
export const hunterForecastResponseSchema = z.object({ records: z.array(predictionSchema), note: z.string() });
export const hunterSummarySchema = z.object({ groups: z.array(z.object({
  key: z.string(), total: z.number(), pending: z.number(), available: z.number(), evaluated: z.number(),
  directionRate: z.number().nullable(), meanReturn: z.number().nullable(), meanError: z.number().nullable(), worstDrawdown: z.number().nullable(),
})) });
