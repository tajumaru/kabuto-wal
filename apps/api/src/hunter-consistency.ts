import { BOTTOM_CONFIG } from "../../../packages/core/bottom-score";
import { HUNTER_CONFIG } from "../../../packages/core/hunter";
import { HUNTER_METHOD, type HunterJob } from "../../../packages/core/hunter-schema";
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
