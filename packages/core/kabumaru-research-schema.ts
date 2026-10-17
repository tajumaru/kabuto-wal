import { z } from "zod";
import { hunterCategory, hunterCode, hunterCoverageSchema } from "./hunter-schema";

export const RESEARCH_METHOD = "kabumaru-grounded-v1";
export const researchQuestion = z.enum(["summary", "why", "similar", "risk", "high-score", "outcome", "watch"]);
export const researchInputSchema = z.object({
  code: hunterCode, asOf: z.string().date().optional(), jobId: z.string().uuid().optional(),
  question: researchQuestion.default("summary"), provider: z.enum(["deterministic", "configured-llm"]).default("deterministic"),
  allowExternalLlm: z.boolean().default(false), recallRemote: z.boolean().default(false),
}).strict();
const finite = z.number().finite();
const condition = z.enum(["drawdown", "oversold", "support", "above_sma5", "sma5_rising", "rsi_recovery", "macd_recovery", "volume_rebound", "lower_wick", "above_sma20"]);
const header = {
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/), sourceId: z.string().min(1).max(160),
  asOf: z.string().date(), cutoff: z.string().datetime(), methodVersion: z.string().min(1).max(100),
  revisionIds: z.array(z.string().max(160)).max(100000), limitations: z.array(z.string().max(300)).max(20),
};
export const researchEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ ...header, kind: z.literal("bottom"), facts: z.object({
    score: finite.min(0).max(100).nullable(), category: hunterCategory, status: z.enum(["ready", "unavailable"]),
    metConditions: z.array(condition), unmetConditions: z.array(condition), risks: z.array(z.string().regex(/^[a-z0-9_]+$/)),
    rsi: finite.nullable(), drawdown: finite.nullable(), volumeRatio: finite.nullable(), continuousSessions: z.number().int().nonnegative(),
  }).strict() }).strict(),
  z.object({ ...header, kind: z.literal("dejavu"), facts: z.object({
    comparisons: z.array(z.object({ requestedCount: z.number().int().positive(), horizon: z.union([z.literal(1), z.literal(5), z.literal(20)]),
      sampleCount: z.number().int().nonnegative(), medianReturn: finite.nullable(), upRatio: finite.min(0).max(1).nullable(),
      percentileRange: z.array(finite).nullable() }).strict()).max(9),
    examples: z.array(z.object({ id: z.string(), similarity: finite, common: z.string().nullable(), different: z.string().nullable() }).strict()).max(5),
  }).strict() }).strict(),
  z.object({ ...header, kind: z.literal("forecast"), facts: z.object({
    predictedReturn: finite, horizon: z.union([z.literal(1), z.literal(5), z.literal(20)]), target: z.string().date(),
    experiment: z.enum(["prospective", "retrospective", "walk-forward"]), score: finite.nullable(), classification: hunterCategory,
  }).strict() }).strict(),
  z.object({ ...header, kind: z.literal("evaluation"), facts: z.object({
    predictionId: z.string(), actualReturn: finite, predictedReturn: finite, maxDrawdown: finite.nullable(),
    horizon: z.union([z.literal(1), z.literal(5), z.literal(20)]), experiment: z.enum(["prospective", "retrospective", "walk-forward"]),
    score: finite.nullable(), classification: hunterCategory, period: z.string().regex(/^\d{4}-\d{2}$/),
  }).strict() }).strict(),
  z.object({ ...header, kind: z.literal("memory"), facts: z.object({
    referenceId: z.string(), confirmedLocally: z.literal(true), matchReasons: z.array(z.enum(["code", "classification", "pattern", "outcome", "risk"])),
  }).strict() }).strict(),
]);
export type ResearchEvidence = z.infer<typeof researchEvidenceSchema>;
export const researchSection = z.enum(["summary", "bullish", "bearish", "dejavu", "reflection", "watch", "uncertainty"]);
export const researchStatementSchema = z.object({
  statementId: z.string().regex(/^[a-f0-9]{64}$/), section: researchSection, text: z.string().min(1).max(2000),
  evidenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
}).strict();
export const researchExplanationSchema = z.object({ statements: z.array(researchStatementSchema).min(1).max(100) }).strict();
export type ResearchExplanation = z.infer<typeof researchExplanationSchema>;
export const researchResultSchema = z.object({
  schemaVersion: z.literal(1), researchId: z.string().regex(/^[a-f0-9]{64}$/), code: hunterCode,
  asOf: z.string().date(), cutoff: z.string().datetime(), analysisId: z.string().nullable(), jobId: z.string().uuid().nullable(),
  evidenceIds: z.array(z.string()), inputRevisionIds: z.array(z.string()), explanationMethodVersion: z.literal(RESEARCH_METHOD),
  generatedAt: z.string().datetime(), mode: z.enum(["demo", "research"]), dataCoverage: hunterCoverageSchema.nullable(),
  evidence: z.array(researchEvidenceSchema).max(200), explanation: researchExplanationSchema,
  reliability: z.enum(["十分な根拠", "限定的な根拠", "根拠不足", "データ取得不完全"]),
  warnings: z.array(z.string()), question: researchQuestion, provider: z.enum(["deterministic", "configured-llm"]),
  memorySearch: z.enum(["local", "memwal", "fallback"]),
}).strict().superRefine((r, ctx) => {
  const ids = new Set(r.evidence.map(e => e.evidenceId));
  if (ids.size !== r.evidence.length || r.evidenceIds.length !== ids.size || r.evidenceIds.some(id => !ids.has(id)) ||
    r.explanation.statements.some(s => s.evidenceIds.some(id => !ids.has(id))) ||
    r.evidence.some(e => e.asOf > r.asOf || e.cutoff > r.cutoff))
    ctx.addIssue({ code: "custom", message: "研究の根拠参照または取得時点が一致しません" });
});
export type ResearchResult = z.infer<typeof researchResultSchema>;
