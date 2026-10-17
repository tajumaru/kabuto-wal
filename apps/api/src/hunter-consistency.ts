import { BOTTOM_CONFIG } from "../../../packages/core/bottom-score";
import { HUNTER_CONFIG } from "../../../packages/core/hunter";
import { HUNTER_METHOD, hunterRowSchema, type HunterJob } from "../../../packages/core/hunter-schema";
import { bottomAnalysisSchema } from "../../../packages/core/bottom-schema";
import type { Service } from "./service";
import { ADJUSTMENT_VERSION, hash } from "../../../packages/integrations/adjusted-series";
import type { HunterIndex } from "./hunter-index";

// Dataset identity describes observations; analysis identity also freezes interpretation.
export function hunterAnalysisId(job: HunterJob, index: HunterIndex, universeId: string) {
  return hash(["hunter-analysis-v2", job.mode, index.id, job.input.asOf, job.cutoff,
    universeId, index.dates, index.inputIds, HUNTER_METHOD, BOTTOM_CONFIG,
    HUNTER_CONFIG, ADJUSTMENT_VERSION, process.env.JQUANTS_PLAN || "Free"]);
}
export function hunterDetailKey(job: HunterJob, code: string) {
  // Legacy JSON remains readable, but is never reused by a new execution.
  return `market/hunter/details/${job.analysisId ?? job.datasetId}/${code}.json`;
}
export async function readHunterDetail(service: Service, job: HunterJob, code: string) {
  const saved = await service.store.read(hunterDetailKey(job, code));
  const analysis = bottomAnalysisSchema.parse(saved.analysis), row = hunterRowSchema.parse(saved.row);
  const ranked = hunterRowSchema.parse(await service.store.read(`market/hunter/rankings/${job.id}/${code}.json`));
  const expectedInput = hash(job.analysisId ? [job.analysisId, job.datasetId, analysis.inputRevisionIds] : [job.datasetId, analysis.inputRevisionIds]);
  if (row.code !== code || ranked.code !== code || ranked.jobId !== job.id || row.asOf !== job.input.asOf ||
    row.cutoff !== job.cutoff || ranked.asOf !== row.asOf || ranked.cutoff !== row.cutoff ||
    ranked.score !== analysis.score || ranked.category !== row.category || ranked.candidate !== row.candidate ||
    ranked.inputId !== row.inputId || row.inputId !== expectedInput ||
    analysis.providerCode !== code || analysis.dataAsOf !== job.input.asOf || analysis.cutoff !== job.cutoff)
    throw Error("分析結果とジョブの入力条件が一致しません");
  return { row: ranked, analysis };
}
