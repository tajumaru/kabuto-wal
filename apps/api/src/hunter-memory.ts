import type { Service } from "./service";
import type { Prediction } from "../../../packages/core/index";
import { hunterId } from "./hunter-journal";
import { HUNTER_FORECAST_METHOD } from "../../../packages/core/hunter-method";

// Called under the existing journal writer lock. Original prices stay in JSON only.
export async function ensureHunterMemory(service: Service, p: Prediction, evaluation?: {
  evaluationId: string; actualReturn: number; directionMatch: boolean; maxDrawdown: number;
}) {
  if (!p.hunter) return;
  const kind = evaluation ? "hunter_reflection" : "hunter_research_summary";
  const recordId = hunterId([p.predictionId, kind, evaluation?.evaluationId ?? "original", "summary-v1"]);
  const key = `memories/${recordId}.json`;
  const a = p.hunter.analysis;
  const observations = { score: a.score, classification: p.hunter.classification, horizonSessions: p.horizonSessions,
    predictedReturn: p.predictedReturn, sampleCount: p.sampleCount, risks: a.riskCodes,
    ...(evaluation ? { actualReturn: evaluation.actualReturn, directionMatch: evaluation.directionMatch, maxDrawdown: evaluation.maxDrawdown } : {}) };
  const interpretation = "観測結果だけで原因は断定できません。少数事例・高ボラティリティ・未確認の市場要因を次回も点検してください。";
  const text = `${p.providerCode} ${p.dataAsOf}基準、底打ち${a.score}点・${p.hunter.classification}。${a.conditions.filter(c => c.met).map(c => c.label).slice(0,3).join("、")}。${p.horizonSessions}営業日先、類似${p.sampleCount}件の中央値${(p.predictedReturn*100).toFixed(2)}%。${evaluation ? `実績${(evaluation.actualReturn*100).toFixed(2)}%、方向${evaluation.directionMatch ? "一致" : "不一致"}、終値ベース最大下落${(evaluation.maxDrawdown*100).toFixed(2)}%。` : "未評価。"}リスク：${a.riskCodes.join("、") || "追加リスクなし"}。${p.hunter.experiment}。${interpretation}`;
  // Never recreate or reactivate a tombstone, nor reset existing sync receipts.
  if (!await service.store.read(key, null)) await service.store.write(key, {
    schemaVersion: 1, methodVersion: HUNTER_FORECAST_METHOD, kind, recordId, active: true,
    createdAt: new Date().toISOString(), mode: service.mode, source: p.source, providerCode: p.providerCode,
    predictionId: p.predictionId, dataAsOf: evaluation ? p.targetSessionDate : p.dataAsOf,
    cutoff: p.hunter.cutoff, namespace: `kabutowal:hunter:summary:v1:${service.mode}:${p.providerCode}`,
    experiment: p.hunter.experiment, observations, interpretation, text,
    references: { predictionId: p.predictionId, evaluationId: evaluation?.evaluationId, jobId: p.hunter.jobId, datasetId: p.hunter.datasetId },
  }, true);
  if (!await service.store.read(`sync/${recordId}.json`, null)) await service.store.write(`sync/${recordId}.json`, { status: "pending" });
}
