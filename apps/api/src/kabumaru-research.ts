import { HUNTER_FORECAST_METHOD } from "../../../packages/core/hunter-method";
import { reflectionNamespace } from "./dejavu-journal";
import { explainWithResearchLlm } from "./kabumaru-llm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { hunterJobFor, hunterCandidate } from "./hunter";
import { hunterJobSchema, hunterCoverageSchema } from "../../../packages/core/hunter-schema";
import { predictionSchema } from "../../../packages/core/index";
import { RESEARCH_METHOD, researchInputSchema, researchResultSchema, type ResearchEvidence, type ResearchResult } from "../../../packages/core/kabumaru-research-schema";
import { researchEvidence, verifyEvidence } from "./kabumaru-evidence";
import { deterministicResearch, researchReliability } from "./kabumaru-explanation";
import { hash } from "../../../packages/integrations/adjusted-series";
import { cachedResearch, cacheResearch } from "./kabumaru-research-cache";
import { searchDejavuContext } from "./hunter-research";

const knownBy = (value: unknown, cutoff: string) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.parse(cutoff);
const evaluationSchema = z.object({ evaluationId: z.string(), predictionId: z.string(), methodVersion: z.string(), createdAt: z.string().datetime(), evaluatedCutoff: z.string().datetime().optional(),
  actualReturn: z.number().finite(), maxDrawdown: z.number().finite().nullable().optional(), pathRevisionIds: z.array(z.string()).optional(), revisionIds: z.array(z.string()).optional() });
const memorySchema = z.object({ recordId: z.string().regex(/^[A-Za-z0-9_-]+$/), active: z.literal(true), kind: z.enum(["hunter_research_summary", "hunter_reflection", "dejavu_reflection"]),
  mode: z.string(), providerCode: z.string(), createdAt: z.string().datetime(), dataAsOf: z.string().date(), remoteDeletedAt: z.unknown().optional(),
  predictionId: z.string().optional(), researchId: z.string().optional(), references: z.object({ evaluationId: z.string().optional() }).passthrough().optional(),
  observations: z.object({ classification: z.string().optional(), risks: z.array(z.string()).optional() }).passthrough().optional(), namespace: z.string(),
});
export async function buildKabumaruResearch(service: Service, raw: unknown, now = new Date()): Promise<ResearchResult> {
  const input = researchInputSchema.parse(raw);
  const jobId = await hunterJobFor(service, input);
  const job = jobId ? hunterJobSchema.parse(await service.store.read(`market/hunter/jobs/${jobId}.json`)) : null;
  if (job && job.mode !== (service.mode === "demo" ? "demo" : "research")) throw Error("研究のデータ区分が一致しません");
  if (input.asOf && job && input.asOf !== job.input.asOf) throw Error("基準日とジョブが一致しません");
  const asOf = job?.input.asOf ?? input.asOf ?? now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  if (asOf > now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })) throw Error("未来の基準日は研究できません");
  const cutoff = [job?.cutoff ?? now.toISOString(), `${asOf}T14:59:59.999Z`, now.toISOString()].sort()[0];
  const coverage = job ? hunterCoverageSchema.nullable().parse(await service.store.read(`market/hunter/coverage/${job.id}.json`, null)) : null;
  const detail = job?.datasetId ? await hunterCandidate(service, input.code, job.id) : null;
  const warnings = ["研究コメントは投資判断の代行ではありません。", "評価は記録した仮説の選択バイアスを含み、スコアの優位性を前提にしません。"];
  // Max observedAt binds all bars in the analysis window. Later revisions cannot be relabelled as historical facts.
  const usable = detail && knownBy(detail.analysis.observedAt, cutoff) && detail.analysis.inputRevisionIds.length > 0;
  if (detail && !usable) warnings.push("このジョブの分析は当時利用可能だったrevisionを証明できません。当日以前の取得締切で再走査してください。");
  const records = (await service.predictions()).filter(p => p.providerCode === input.code && ((p.methodVersion === HUNTER_FORECAST_METHOD && p.hunter && !p.dejavu) || (p.methodVersion === "dejavu-consensus-v1" && p.dejavu && !p.hunter)) &&
    (service.mode === "demo" ? p.mode === "demo" : p.mode !== "demo") && p.dataAsOf <= asOf && knownBy(p.generatedAt, cutoff) && knownBy(p.createdAt, cutoff) && knownBy(p.hunter?.recordedAt ?? p.createdAt, cutoff) && knownBy(p.hunter?.cutoff ?? p.dejavu?.dataCutoff, cutoff));
  const local: unknown[] = await service.store.all("memories");
  const syncs: Record<string, unknown>[] = await service.store.all("sync");
  const cacheKey = hash([RESEARCH_METHOD, service.mode, input.code, asOf, cutoff, job, detail, coverage, records, local, syncs, input.question]);
  if (!input.recallRemote) {
    const cached = await cachedResearch(service, cacheKey);
    if (cached && cached.generatedAt <= now.toISOString()) return cached;
  }
  if (records.length > 20) warnings.push(`表示・説明対象は、この時点で確認できる関連予測${records.length}件のうち直近20件です。全件集計ではありません。`);
  if (coverage && coverage.cutoff > cutoff) warnings.push("カバレッジ件数は後日保存されたジョブ全体の情報です。当時の取得範囲を証明するものではありません。");
  const evidence: ResearchEvidence[] = [];
  if (usable && detail) {
    const a = detail.analysis;
    evidence.push(researchEvidence({ kind: "bottom", sourceId: job!.analysisId ?? job!.datasetId!, asOf, cutoff, methodVersion: a.methodVersion,
      revisionIds: a.inputRevisionIds, limitations: a.reasonCodes, facts: { score: a.score, category: detail.row.category, status: a.status,
        metConditions: a.conditions.filter(c => c.met).map(c => c.code) as Extract<ResearchEvidence,{kind:"bottom"}>["facts"]["metConditions"],
        unmetConditions: a.conditions.filter(c => !c.met).map(c => c.code) as Extract<ResearchEvidence,{kind:"bottom"}>["facts"]["unmetConditions"],
        risks: a.riskCodes, rsi: a.indicators?.rsi14 ?? null, drawdown: a.indicators?.drawdown60 ?? null, volumeRatio: a.indicators?.volumeRatio ?? null, continuousSessions: detail.row.continuousSessions } }));
    try {
      // Recompute at the research cutoff if the original job was acquired later.
      const d = await searchDejavuContext(service, input.code, asOf, input.code, job!.id);
      // Every dependency, including statistical outcome windows, must have been observed by cutoff.
      // The snapshot bars are filtered again when a legacy job has a later cutoff.
      if (job!.cutoff > cutoff) {
        const { readHunterSeries } = await import("./hunter-research");
        const { searchDejavu } = await import("./dejavu");
        const { bars } = await readHunterSeries(service, job!.id, input.code);
        const safe = bars.filter(b => knownBy(b.availableAt, cutoff) && b.sessionDate <= asOf);
        Object.assign(d, await searchDejavu(service, input.code, asOf, input.code, { cutoff, series: safe, compareSeries: safe }));
      }
      evidence.push(researchEvidence({ kind: "dejavu", sourceId: d.recordId, asOf, cutoff, methodVersion: d.statistics.methodVersion,
        revisionIds: [...d.inputRevisionIds, ...(d.statisticsInputRevisionIds ?? [])], limitations: ["非重複事例の経験分布。未校正の上昇割合。"],
        facts: { comparisons: d.statistics.comparisons.flatMap(c => ([1,5,20] as const).map(h => ({ requestedCount: c.requestedCount, horizon: h,
          sampleCount: c.horizons[h].sampleCount, medianReturn: c.horizons[h].medianReturn, upRatio: c.horizons[h].upRatio, percentileRange: c.horizons[h].percentileRange }))),
          examples: d.examples.map(e => ({ id: e.id, similarity: e.score, common: d.dna.find(x => x.exampleId === e.id)?.mostSimilar ?? null, different: d.dna.find(x => x.exampleId === e.id)?.mostDifferent ?? null })) } }));
    } catch { warnings.push("過去の類似相場は履歴不足などのため確認できません。"); }
  }
  const referenceIds = new Set<string>();
  for (const record of records.slice(-20)) {
    const parsed = predictionSchema.safeParse(record); if (!parsed.success || (!parsed.data.hunter && !parsed.data.dejavu)) continue;
    const p = parsed.data;
    evidence.push(researchEvidence({ kind: "forecast", sourceId: p.predictionId, asOf: p.dataAsOf, cutoff, methodVersion: p.methodVersion,
      revisionIds: p.inputRevisionIds, limitations: ["予測原本は後日の説明で変更しません。"], facts: { predictedReturn: p.predictedReturn, horizon: p.horizonSessions,
        target: p.targetSessionDate, experiment: p.hunter?.experiment ?? "retrospective", score: p.hunter?.analysis.score ?? null, classification: p.hunter?.classification ?? null,
        metConditions: (p.hunter?.analysis.conditions ?? []).filter(c => c.met).map(c => c.code) as Extract<ResearchEvidence,{kind:"forecast"}>["facts"]["metConditions"], risks: p.hunter?.analysis.riskCodes ?? [] } }));
    referenceIds.add(p.predictionId);
    const evaluations = (record.evaluations as unknown[]).flatMap(e => { const r = evaluationSchema.safeParse(e); return r.success ? [r.data] : []; })
      .filter(e => e.predictionId === p.predictionId && e.methodVersion === p.methodVersion && p.targetSessionDate <= asOf && knownBy(e.createdAt, cutoff) && (!e.evaluatedCutoff || knownBy(e.evaluatedCutoff, cutoff))).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    const e = evaluations.at(-1);
    if (e) {
      referenceIds.add(e.evaluationId);
      evidence.push(researchEvidence({ kind: "evaluation", sourceId: e.evaluationId, asOf: p.targetSessionDate, cutoff, methodVersion: p.methodVersion,
        revisionIds: e.pathRevisionIds ?? e.revisionIds ?? [], limitations: ["価格結果だけで原因は断定できません。"], facts: { predictionId: p.predictionId,
          actualReturn: e.actualReturn, predictedReturn: p.predictedReturn, maxDrawdown: e.maxDrawdown ?? null, horizon: p.horizonSessions,
          experiment: p.hunter?.experiment ?? "retrospective", score: p.hunter?.analysis.score ?? null, classification: p.hunter?.classification ?? null, period: p.dataAsOf.slice(0,7) } }));
    }
  }
  let memorySearch: ResearchResult["memorySearch"] = "local";
  const remoteIds = new Set<string>();
  if (input.recallRemote && service.mode !== "demo" && process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true" && process.env.JQUANTS_MEMWAL_RIGHTS_CONFIRMED === "true") {
    try {
      const provider = await service.memoryProvider();
      if (!provider) throw Error("未接続");
      const responses = await Promise.race([Promise.all([`kabutowal:hunter:summary:v1:${service.mode}:${input.code}`, reflectionNamespace(service.mode, input.code)].map(namespace => provider.recall({ namespace,
        query: `${input.code} ${detail?.row.category ?? ""} ${detail?.analysis.conditions.filter(c => c.met).slice(0,3).map(c => c.code).join(" ") ?? ""} ${detail?.analysis.riskCodes.slice(0,2).join(" ") ?? ""} 過去予測結果 反発成功 反発失敗`, limit: 20 }))), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error("timeout")), 2000); timer.unref(); })]);
      for (const item of responses.flatMap(r => r.results)) { if (item.text.length > 20000) continue; try { const r = z.object({ recordId: z.string() }).parse(JSON.parse(item.text)); remoteIds.add(r.recordId); } catch { /* Remote prose is never evidence. */ } }
      memorySearch = "memwal";
    } catch { memorySearch = "fallback"; warnings.push("MemWal未接続。ローカルの原本照合済み要約を使います。"); }
  } else if (input.recallRemote) warnings.push("MemWalの検索送信許可がないため、ローカル要約だけを使います。");
  for (const entry of local) {
    if (evidence.filter(e => e.kind === "memory").length >= 20) break;
    const parsed = memorySchema.safeParse(entry); if (!parsed.success) continue;
    const m = parsed.data;
    const sync = await service.store.read<{ status?: string; searchResetAt?: string; blobDeletedAt?: string; remoteDeletion?: unknown; directWalrusDeletion?: unknown }>(`sync/${m.recordId}.json`, {});
    if (m.mode !== service.mode || m.providerCode !== input.code || m.dataAsOf > asOf || !knownBy(m.createdAt, cutoff) || m.remoteDeletedAt ||
      ["deleted", "disabled"].includes(sync.status ?? "") || sync.searchResetAt || sync.blobDeletedAt || sync.remoteDeletion || sync.directWalrusDeletion ||
      (memorySearch === "memwal" && !remoteIds.has(m.recordId))) continue;
    let ref = m.references?.evaluationId ?? m.predictionId;
    let verifiedResearch = false;
    if (m.researchId && /^[a-f0-9]{64}$/.test(m.researchId)) {
      const original = researchResultSchema.safeParse(await service.store.read(`research/results/${m.researchId}.json`, null));
      if (original.success && original.data.evidence.every(verifyEvidence) && original.data.code === input.code && original.data.asOf <= asOf && knownBy(original.data.cutoff, cutoff) && knownBy(original.data.generatedAt, cutoff)) { ref = m.researchId; verifiedResearch = true; }
    }
    if (!ref || (!referenceIds.has(ref) && !verifiedResearch)) continue;
    const matchReasons: Extract<ResearchEvidence,{kind:"memory"}>["facts"]["matchReasons"] = ["code"];
    if (m.observations?.classification === detail?.row.category) matchReasons.push("classification");
    if (m.observations?.risks?.some(r => detail?.analysis.riskCodes.includes(r))) matchReasons.push("risk");
    if (m.references?.evaluationId) matchReasons.push("outcome");
    const p = records.find(p => p.predictionId === m.predictionId);
    if (p?.hunter?.analysis.conditions.some((c: { code: string; met: boolean }) => c.met && detail?.analysis.conditions.some(d => d.met && d.code === c.code))) matchReasons.push("pattern");
    evidence.push(researchEvidence({ kind: "memory", sourceId: m.recordId, asOf: m.dataAsOf, cutoff, methodVersion: "hunter-summary-local-verified-v1", revisionIds: [],
      limitations: ["MemWalの文章は原本ではありません。ローカル原本・評価で照合した参照だけを採用。"], facts: { referenceId: ref, confirmedLocally: true, matchReasons } }));
  }
  const result = researchResultSchema.parse({ schemaVersion: 1, researchId: hash([RESEARCH_METHOD, service.mode, input.code, asOf, cutoff, job?.analysisId, evidence.map(e => e.evidenceId)]), code: input.code, asOf, cutoff,
    analysisId: usable ? job?.analysisId ?? job?.datasetId ?? null : null, jobId: job?.id ?? null, evidenceIds: evidence.map(e => e.evidenceId),
    inputRevisionIds: [...new Set(evidence.flatMap(e => e.revisionIds))], explanationMethodVersion: RESEARCH_METHOD, generatedAt: now.toISOString(),
    mode: service.mode === "demo" ? "demo" : "research", dataCoverage: coverage, evidence, explanation: deterministicResearch(evidence),
    reliability: researchReliability(evidence, coverage && coverage.cutoff <= cutoff ? coverage : null), warnings, question: input.question, provider: "deterministic", memorySearch });
  if (!input.recallRemote) await cacheResearch(service, cacheKey, result);
  return result;
}

export async function runKabumaruResearch(service: Service, raw: unknown) {
  return explainWithResearchLlm(await buildKabumaruResearch(service, raw), raw);
}

export function registerKabumaruResearch(app: FastifyInstance, service: Service) {
  app.post("/api/research", async req => runKabumaruResearch(service, req.body));
  app.post("/api/research/chat", async req => {
    const body = z.object({ research: researchInputSchema, saveHistory: z.boolean().default(false) }).strict().parse(req.body);
    const result = await runKabumaruResearch(service, body.research);
    if (body.saveHistory) await service.store.lock(() => service.store.write(`research/chats/${hash([result.researchId, result.question, result.generatedAt])}.json`, result));
    return result;
  });
  app.get("/api/research/chats", async () => ({ records: (await service.store.all("research/chats")).slice(-20).map(r => researchResultSchema.parse(r)) }));
  app.post("/api/research/save", async req => {
    const input = researchInputSchema.parse(req.body), result = await buildKabumaruResearch(service, { ...input, provider: "deterministic", allowExternalLlm: false, recallRemote: false });
    const recordId = hash(["research-summary-v1", result.researchId]);
    await service.store.lock(async () => {
      if (!await service.store.read(`research/results/${result.researchId}.json`, null)) await service.store.write(`research/results/${result.researchId}.json`, result, true);
      if (!await service.store.read(`memories/${recordId}.json`, null)) await service.store.write(`memories/${recordId}.json`, {
        schemaVersion: 1, kind: "hunter_research_summary", recordId, active: true, createdAt: new Date().toISOString(), mode: service.mode, source: service.mode === "demo" ? "fixture" : "jquants-v2",
        providerCode: result.code, dataAsOf: result.asOf, researchId: result.researchId, namespace: `kabutowal:hunter:summary:v1:${service.mode}:${result.code}`,
        observations: result.evidence.find(e => e.kind === "bottom")?.facts,
        text: JSON.stringify({ recordId, researchId: result.researchId, code: result.code, asOf: result.asOf, evidenceIds: result.evidenceIds, reliability: result.reliability,
          features: result.evidence.find(e => e.kind === "bottom")?.facts,
          outcomes: result.evidence.filter(e => e.kind === "evaluation").slice(-3).map(e => e.facts),
          interpretation: "価格だけで成功・失敗の原因を断定しません。" }),
        references: { researchId: result.researchId },
      }, true);
      if (!await service.store.read(`sync/${recordId}.json`, null)) await service.store.write(`sync/${recordId}.json`, { status: "pending" });
    });
    return { recordId, note: "ローカルに要約を保存しました。外部送信は既存の明示同期と許可設定に従います。" };
  });
  app.post("/api/research/diagnostics", async req => {
    const input = researchInputSchema.parse(req.body);
    const result = await buildKabumaruResearch(service, { ...input, provider: "deterministic", allowExternalLlm: false, recallRemote: false });
    const b = result.evidence.find(e => e.kind === "bottom"), d = result.evidence.find(e => e.kind === "dejavu");
    let adjustmentVersion: string | null = null, seriesConsistent = false;
    if (result.jobId) try {
      const { readHunterSeries } = await import("./hunter-research");
      const { bars } = await readHunterSeries(service, result.jobId, result.code);
      const detail = await hunterCandidate(service, result.code, result.jobId);
      adjustmentVersion = detail?.analysis.adjustmentVersion ?? null;
      seriesConsistent = bars.length > 0 && !!bars[0].seriesId && bars.every(b => b.seriesId === bars[0].seriesId && b.providerCode === result.code && b.sessionDate <= result.asOf && knownBy(b.availableAt, result.cutoff));
    } catch { /* Missing/corrupt series is a failed check, never an invented success. */ }
    const scoreBands = { "0-39": 0, "40-59": 0, "60-79": 0, "80-100": 0, unknown: 0 };
    for (const e of result.evidence) if (e.kind === "evaluation") {
      const { hunterScoreBand } = await import("../../../packages/core/hunter-method");
      scoreBands[hunterScoreBand(e.facts.score)]++;
    }
    return { externalCalls: 0, code: result.code, asOf: result.asOf, cutoff: result.cutoff, coverage: result.dataCoverage,
      continuous80: b?.kind === "bottom" && b.facts.continuousSessions >= 80, inputRevisionIds: result.inputRevisionIds,
      analysisId: result.analysisId, adjustmentVersion, seriesConsistent, scoreBands, plan: result.dataCoverage?.plan ?? process.env.JQUANTS_PLAN ?? "Free", sampleCounts: d?.kind === "dejavu" ? d.facts.comparisons : [],
      evaluatedCount: result.evidence.filter(e => e.kind === "evaluation").length, warnings: result.warnings,
      note: "保存済み実データの少数銘柄診断です。取得が必要なら既存の明示取得ジョブを利用してください。自動取得しません。" };
  });
}
