import { hunterSummaryInputs, readHunterSummary, saveHunterSummary } from "./hunter-summary-cache";
import { readHunterDetail } from "./hunter-consistency";
import { z } from "zod";
import type { Service } from "./service";
import { predictionSchema, targetDate, evaluate, type Calendar, type Prediction } from "../../../packages/core/index";
import { hunterDistribution, hunterScoreBand, HUNTER_FORECAST_METHOD } from "../../../packages/core/hunter-method";
import { hunterCode, hunterJobSchema } from "../../../packages/core/hunter-schema";
import { hash } from "../../../packages/integrations/adjusted-series";
import { MarketIngestion } from "../../../packages/integrations/market-ingestion";
import { readHunterSeries, searchDejavuContext } from "./hunter-research";
import { snapshot } from "./dejavu";
import { ensureHunterMemory } from "./hunter-memory";

export const hunterForecastInputSchema = z.object({ jobId: z.string().uuid(), code: hunterCode, recordingMode: z.enum(["research", "walk-forward", "live"]).default("research") }).strict();
export const hunterId = (parts: unknown) => { const h = hash(parts); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
export async function recordHunterForecast(service: Service, raw: unknown, now = new Date()) {
  const input = hunterForecastInputSchema.parse(raw);
  const job = hunterJobSchema.parse(await service.store.read(`market/hunter/jobs/${input.jobId}.json`));
  if (!job.datasetId) throw Error("走査結果がありません");
  const detail = await readHunterDetail(service, job, input.code);
  if (!detail.row.candidate || detail.analysis.status !== "ready") throw Error("底打ち候補の判定が必要です");
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  if (input.recordingMode === "live" && (job.input.asOf !== today || job.cutoff.slice(0,10) !== today)) throw Error("過去日付の仮説を実運用として記録できません");
  if (input.recordingMode === "walk-forward" && job.cutoff > `${job.input.asOf}T14:59:59.999Z`) throw Error("walk-forwardの締切は基準日当日までです");
  const { bars } = await readHunterSeries(service, job.id, input.code);
  const base = bars.find(b => b.sessionDate === job.input.asOf);
  if (!base?.adjClose) throw Error("基準価格がありません");
  const referencePrice = base.adjClose;
  const research = await searchDejavuContext(service, input.code, job.input.asOf, input.code, job.id);
  const stats = research.statistics.comparisons.at(-1)!;
  const calendar = await service.store.read<Calendar>("market/calendar.json");
  const experiment = input.recordingMode === "live" ? "prospective" : input.recordingMode === "walk-forward" ? "walk-forward" : "retrospective";
  const plans = ([1,5,20] as const).map(h => {
    const s = stats.horizons[h];
    if (!s.sampleCount || s.medianReturn === null || s.upRatio === null || !s.percentileRange) throw Error("デジャヴ事例不足のため予測中央値を記録できません");
    const target = targetDate(calendar, job.input.asOf, h);
    if (experiment === "prospective" && target <= today) throw Error("実績が既知の対象日は実運用に含められません");
    const id = hunterId([service.mode, input.code, job.input.asOf, job.cutoff, job.datasetId, ...(job.analysisId ? [job.analysisId] : []), HUNTER_FORECAST_METHOD, experiment, h, research.inputRevisionIds, stats.exampleIds]);
    return predictionSchema.parse({ schemaVersion: 1, recordId: id, kind: "prediction", predictionId: id,
      createdAt: now.toISOString(), generatedAt: now.toISOString(), source: research.source, providerCode: input.code,
      mode: service.mode === "demo" ? "demo" : experiment === "prospective" ? "live" : experiment === "walk-forward" ? "backtest" : "research",
      dataAsOf: job.input.asOf, horizonSessions: h, targetSessionDate: target, referencePrice,
      referenceBasis: "予測原本の取得締切・調整基準を固定。評価は期限日の共通調整系列でリターンを照合。",
      predictedReturn: s.medianReturn, expectedPrice: referencePrice*(1+s.medianReturn), returnQuantiles: s.percentileRange,
      pUp: s.upRatio, sampleCount: s.sampleCount, inputRevisionIds: [...research.inputRevisionIds, ...(research.statisticsInputRevisionIds ?? []), ...detail.analysis.inputRevisionIds],
      candidateIds: stats.exampleIds, featureVersion: detail.analysis.featureVersion, methodVersion: HUNTER_FORECAST_METHOD,
      model: "local-numeric", promptVersion: "hunter-deterministic-v1", reason: "底打ち候補＋上位20件以内の非重複類似事例の中央値。上昇割合は未校正の経験分布です。",
      falsification: "期限後の方向・中央値誤差・最大下落を検証。過去検証と実運用を分離し、原因は推測しない。",
      hunter: { schemaVersion: 1, methodVersion: HUNTER_FORECAST_METHOD, jobId: job.id, datasetId: job.datasetId, analysisId: job.analysisId, cutoff: job.cutoff,
        experiment, classification: detail.row.category, analysis: detail.analysis, statistics: stats, comparisons: research.statistics.comparisons,
        recordedAt: now.toISOString(), probabilityMeaning: "uncalibrated_empirical_ratio" },
    });
  });
  return service.store.lock(async () => {
    const records: Prediction[] = [];
    for (const p of plans) {
      const original = `predictions/${p.predictionId}/original.json`;
      const old = await service.store.read<Prediction | null>(original, null);
      if (!old) await service.store.write(original, p, true);
      if (!await service.store.read(`predictions/${p.predictionId}/state.json`, null)) await service.store.write(`predictions/${p.predictionId}/state.json`, { schemaVersion: 1, status: "pending" });
      records.push(old ?? p);
      await ensureHunterMemory(service, old ?? p);
    }
    await service.store.rebuild(); return { records, note: "ローカル保存。市場データの外部送信は行いません。" };
  });
}
export async function assessHunter(service: Service, p: Prediction, now = new Date(), suppliedBars?: Awaited<ReturnType<typeof snapshot>>) {
  if (!p.hunter || p.hunter.cutoff > now.toISOString()) return null;
  if (p.targetSessionDate > now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })) return null;
  let bars;
  try {
    bars = suppliedBars ?? (service.mode === "demo" ? await snapshot(service, p.providerCode, now.toISOString()) :
      (await new MarketIngestion(service.store, null, process.env.JQUANTS_PLAN || "Free").series(p.providerCode, p.targetSessionDate, now.toISOString(), p.dataAsOf, undefined, false)).bars);
  } catch { return null; }
  const result = evaluate(p, bars);
  if (!result) return null;
  const path = bars.filter(b => b.sessionDate >= p.dataAsOf && b.sessionDate <= p.targetSessionDate);
  if (path.length !== p.horizonSessions + 1 || path.some(b => b.adjClose === null)) return null;
  let peak = path[0].adjClose!, maxDrawdown = 0, rebounded = false, relapse = false;
  for (const b of path) { peak = Math.max(peak, b.adjClose!); maxDrawdown = Math.min(maxDrawdown, b.adjClose!/peak-1); if (b.adjClose! > path[0].adjClose!) rebounded = true; if (rebounded && b.adjClose! < path[0].adjClose!) relapse = true; }
  return { ...result, maxDrawdown, relapse, pathRevisionIds: path.map(b => b.revisionId), evaluatedCutoff: now.toISOString() };
}
// Caller follows the existing journal writer lock. No nested locks or network calls here.
export async function evaluateHunterDue(service: Service, now = new Date()) {
  let count = 0;
  for (const record of await service.predictions()) {
    if (record.methodVersion !== HUNTER_FORECAST_METHOD) continue;
    const p = predictionSchema.parse(record);
    const result = await assessHunter(service, p, now);
    if (!result) { await service.store.write(`predictions/${p.predictionId}/state.json`, { schemaVersion: 1, status: "pending", reason: "期限前または取得実績不足" }); continue; }
    // Evaluation time is metadata, not a reason to duplicate an unchanged result.
    const { evaluatedCutoff, ...numeric } = result;
    const evaluationId = hash(numeric), key = `evaluations/${p.predictionId}/${evaluationId}.json`;
    if (!await service.store.read(key, null)) {
      await service.store.write(key, { schemaVersion: 1, kind: "evaluation", methodVersion: HUNTER_FORECAST_METHOD,
        predictionId: p.predictionId, createdAt: now.toISOString(), evaluationId, ...numeric, evaluatedCutoff,
        hunter: { experiment: p.hunter!.experiment, classification: p.hunter!.classification, score: p.hunter!.analysis.score, cutoff: p.hunter!.cutoff } }, true);
      count++;
    }
    await service.store.write(`predictions/${p.predictionId}/state.json`, { schemaVersion: 1, status: "evaluated" });
    await ensureHunterMemory(service, p, { evaluationId, actualReturn: result.actualReturn, directionMatch: result.directionMatch, maxDrawdown: result.maxDrawdown });
  }
  return count;
}
export async function hunterEvaluationSummary(service: Service, now = new Date()) {
  type Group = { key: string; mode: string; experiment: string; horizon: number; classification: string; band: string; period: string; methodVersion: string;
    total: number; pending: number; available: number; evaluated: number; direction: number; returns: number[]; errors: number[]; drawdowns: number[] };
  const records = (await service.predictions()).filter(p => p.methodVersion === HUNTER_FORECAST_METHOD && p.hunter);
  const inputs = await hunterSummaryInputs(service);
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const cacheKey = hash(["hunter-evaluation-summary-v2", service.mode, process.env.JQUANTS_PLAN || "Free", records, inputs.stamp, records.map(p => [p.targetSessionDate <= today, p.hunter.cutoff <= now.toISOString()])]);
  type Result = Omit<Group,"returns"|"errors"|"drawdowns"|"direction"> & { directionRate: number | null; meanReturn: number | null; medianReturn: number | null; upRatio: number | null; meanError: number | null; meanAbsoluteError: number | null; worstDrawdown: number | null; drawdownDistribution: ReturnType<typeof hunterDistribution>; drawdownCount: number; lowSample: boolean; eligible: number };
  const cached = readHunterSummary<Result[]>(service, cacheKey, now);
  if (cached) return cached;
  const due = records.filter(p => !p.evaluations.length && p.targetSessionDate <= today && p.hunter.cutoff <= now.toISOString());
  const starts = new Map<string,string>();
  for (const p of due) {
    const key = `${p.providerCode}/${p.targetSessionDate}`;
    starts.set(key, [starts.get(key) ?? p.dataAsOf, p.dataAsOf].sort()[0]);
  }
  const prices = new Map<string, Promise<Awaited<ReturnType<typeof snapshot>>>>();
  const available = async (raw: unknown) => {
    const p = predictionSchema.parse(raw);
    if (!p.hunter || p.targetSessionDate > today || p.hunter.cutoff > now.toISOString()) return false;
    const key = `${p.providerCode}/${p.targetSessionDate}`;
    let bars = prices.get(key);
    if (!bars) {
      bars = service.mode === "demo"
        ? snapshot(service, p.providerCode, now.toISOString()).then(bs => bs.filter(b => b.sessionDate >= starts.get(key)! && b.sessionDate <= p.targetSessionDate))
        : new MarketIngestion(service.store, null, process.env.JQUANTS_PLAN || "Free").series(p.providerCode, p.targetSessionDate, now.toISOString(), starts.get(key)!, undefined, false).then(s => s.bars);
      prices.set(key, bars);
    }
    try { return !!await assessHunter(service, p, now, await bars); } catch { return false; }
  };
  const groups = new Map<string, Group>();
  for (const p of records) {
    if (p.methodVersion !== HUNTER_FORECAST_METHOD || !p.hunter) continue;
    const band = hunterScoreBand(p.hunter.analysis.score), period = p.dataAsOf.slice(0,7);
    const key = [p.mode, p.hunter.experiment, p.horizonSessions, p.hunter.classification, band, period, p.methodVersion].join("/");
    const g: Group = groups.get(key) ?? { key, mode: p.mode, experiment: p.hunter.experiment, horizon: p.horizonSessions, classification: p.hunter.classification,
      band, period, methodVersion: p.methodVersion, total: 0, pending: 0, available: 0, evaluated: 0, direction: 0, returns: [], errors: [], drawdowns: [] };
    g.total++;
    const e = p.evaluations.at(-1);
    if (e) {
      g.evaluated++; g.direction += Number(e.directionMatch); g.returns.push(e.actualReturn); g.errors.push(e.returnError);
      if (e.maxDrawdown !== undefined && e.maxDrawdown !== null) g.drawdowns.push(e.maxDrawdown);
    } else if (await available(p)) g.available++;
    else g.pending++;
    groups.set(key,g);
  }
  const result = [...groups.values()].map(g => {
    const { returns, errors, drawdowns, direction, ...counts } = g;
    return { ...counts, directionRate: g.evaluated ? direction/g.evaluated : null,
      meanReturn: g.evaluated ? returns.reduce((a,b) => a+b,0)/g.evaluated : null,
      medianReturn: hunterDistribution(returns).median,
      upRatio: g.evaluated ? returns.filter(r => r>0).length/g.evaluated : null,
      meanError: g.evaluated ? errors.reduce((a,b) => a+b,0)/g.evaluated : null,
      meanAbsoluteError: g.evaluated ? errors.reduce((a,b) => a+Math.abs(b),0)/g.evaluated : null,
      worstDrawdown: drawdowns.length ? Math.min(...drawdowns) : null,
      drawdownDistribution: hunterDistribution(drawdowns), drawdownCount: drawdowns.length,
      lowSample: g.evaluated < 20, eligible: g.available+g.evaluated };
  });
  await saveHunterSummary(service, cacheKey, now, inputs.files, result);
  return result;
}
