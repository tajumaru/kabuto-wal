import { readHunterDetail } from "./hunter-consistency";
import { hunterPreflight } from "./hunter-preflight";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Service } from "./service";
import { HunterJobs } from "./hunter-jobs";
import { searchDejavuContext } from "./hunter-research";
import { recordHunterForecast, hunterEvaluationSummary } from "./hunter-journal";
import { HUNTER_FORECAST_METHOD } from "../../../packages/core/hunter-method";
import { compareHunterRows, explainBottom } from "../../../packages/core/hunter";
import { dataWindow } from "../../../packages/integrations/jquants-plan";
import type { Calendar } from "../../../packages/core/index";
import { hunterCode, hunterFilterSchema, hunterRankingsSchema, hunterStatusSchema, hunterDetailSchema, hunterJobSchema, hunterRowSchema, type HunterCoverage, type HunterRow } from "../../../packages/core/hunter-schema";

export const HUNTER_BASE = "market/hunter";
// Called inside the existing watchlist writer lock, after the ten-stock limit check.
export async function ensureHunterWatchMaster(service: Service, code: string, jobId: string, master: { providerCode: string; name: string; displayCode?: string }[]) {
  const job = hunterJobSchema.parse(await service.store.read(`${HUNTER_BASE}/jobs/${jobId}.json`));
  if (job.mode !== (service.mode === "demo" ? "demo" : "research")) throw Error("ジョブのデータ区分が一致しません");
  const row = hunterRowSchema.parse(await service.store.read(`${HUNTER_BASE}/rankings/${jobId}/${code}.json`));
  if (row.code !== code || row.jobId !== jobId) throw Error("走査結果の銘柄が一致しません");
  master.push({ providerCode: row.code, displayCode: row.code.endsWith("0") ? row.code.slice(0,-1) : row.code, name: row.name });
  await service.store.write("market/master.json", master);
}
export async function hunterJobFor(service: Service, selector: { jobId?: string; asOf?: string }) {
  if (selector.jobId) return selector.jobId;
  const latest = await service.store.read<{ jobId: string } | null>(`${HUNTER_BASE}/indexes/${selector.asOf ? `dates/${selector.asOf}` : "latest"}.json`, null);
  return latest?.jobId ?? null;
}
export async function hunterRankings(service: Service, raw: unknown) {
  const q = hunterFilterSchema.parse(raw), id = await hunterJobFor(service, q);
  const coverage = id ? await service.store.read<HunterCoverage | null>(`${HUNTER_BASE}/coverage/${id}.json`, null) : null;
  const saved = id ? await service.store.read<HunterRow[] | null>(`${HUNTER_BASE}/rankings/${id}/index.json`, null) : null;
  const rows = saved ?? (id ? (await new HunterJobs(service).rows(id)).sort(compareHunterRows).map((r,i) => ({ ...r, rank: i+1 })) : []);
  let rank = 0;
  const normalized = [...rows].sort(compareHunterRows).map(r => ({ ...r, rank: r.score !== null && r.category !== "判定不能" ? ++rank : null }));
  const selected = normalized.filter(r => (q.view === "all" || (q.view === "ranked" ? r.rank !== null : r.rank === null)) && (!q.asOf || r.asOf === q.asOf) && (!q.market || r.market === q.market) &&
    (q.minScore === undefined || (r.score !== null && r.score >= q.minScore)) &&
    (q.rsiMin === undefined || (r.rsi !== null && r.rsi >= q.rsiMin)) && (q.rsiMax === undefined || (r.rsi !== null && r.rsi <= q.rsiMax)) &&
    (q.maxDrawdown === undefined || (r.drawdown !== null && r.drawdown <= q.maxDrawdown)) &&
    (!q.liquidity || r.liquidity === q.liquidity) && (!q.category || r.category === q.category) &&
    (!q.risk || (q.risk === "yes" ? r.risks.length > 0 : r.risks.length === 0)));
  return hunterRankingsSchema.parse({ coverage, rankedCount: rank, unavailableCount: normalized.length - rank, total: selected.length, page: q.page, pageSize: q.pageSize,
    rows: selected.slice((q.page - 1) * q.pageSize, q.page * q.pageSize) });
}
export async function hunterCandidate(service: Service, code: string, id: string, includeResearch = false) {
  const job = hunterJobSchema.parse(await service.store.read(`${HUNTER_BASE}/jobs/${id}.json`));
  if (!job.datasetId) return null;
  const row = await service.store.read<HunterRow | null>(`${HUNTER_BASE}/rankings/${id}/${code}.json`, null);
  if (!row) return null;
  const detail = await readHunterDetail(service, job, code);
  let dejavu = null, dejavuWarning: string | undefined;
  if (includeResearch && detail.analysis.status === "ready") {
    try {
      dejavu = await searchDejavuContext(service, code, row.asOf, code, id);
      if (dejavu.sampleCount < 20) dejavuWarning = `非重複の類似事例は${dejavu.sampleCount}件です。20件に満たない少数事例の経験分布です。`;
    } catch (e) { dejavuWarning = e instanceof Error ? e.message : "デジャヴ用の履歴が不足しています"; }
  }
  return hunterDetailSchema.parse({ row, analysis: detail.analysis, explanation: explainBottom(detail.analysis), dejavu, dejavuWarning });
}
export function registerHunter(app: FastifyInstance, service: Service) {
  const engine = new HunterJobs(service);
  const launch = (id: string) => { void engine.run(id).catch(async error => {
    // A concurrent claim can fail before run() obtains a lease; expose it rather than leaving a phantom queue.
    await service.store.lock(async () => {
      const job = await engine.get(id);
      if (job.status === "queued") await service.store.write(`${HUNTER_BASE}/jobs/${id}.json`, { ...job, status: "failed", error: error instanceof Error ? error.message : "開始できませんでした" });
    }).catch(() => undefined);
  }); };
  app.get("/api/bottom/hunter/status", async () => {
    const latestId = await hunterJobFor(service, {});
    const coverage = latestId ? await service.store.read(`${HUNTER_BASE}/coverage/${latestId}.json`, null) : null;
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const end = service.mode === "demo" ? today : dataWindow(process.env.JQUANTS_PLAN || "Free", today).to;
    const calendar = await service.store.read<Calendar>("market/calendar.json", []);
    const dates = calendar.filter(d => d.open && d.date <= end).map(d => d.date).sort();
    const suggestedAsOf = dates.at(-1);
    const suggestedFrom = dates.slice(-100)[0];
    return hunterStatusSchema.parse({ mode: service.mode === "demo" ? "demo" : "research", plan: service.mode === "demo" ? "fixture" : process.env.JQUANTS_PLAN || "Free",
      delayDays: service.mode !== "demo" && (process.env.JQUANTS_PLAN || "Free") === "Free" ? 84 : 0, jobs: await engine.list(), coverage, suggestedAsOf, suggestedFrom });
  });
  app.get("/api/bottom/hunter/rankings", async req => hunterRankings(service, req.query));
  app.post("/api/bottom/hunter/preflight", async req => hunterPreflight(service, req.body));
  app.get("/api/bottom/hunter/period", async req => {
    const { asOf } = z.object({ asOf: z.string().date() }).strict().parse(req.query);
    const cal = await service.store.read<Calendar>("market/calendar.json", []);
    const days = [...new Set(cal.filter(d => d.open && d.date <= asOf).map(d => d.date))].sort().slice(-80);
    if (!cal.some(d => d.open && d.date === asOf)) return { from: null, reason: "営業日の基準日を指定してください。カレンダー未取得の場合は先に日足を取得してください。" };
    if (days.length < 80) return { from: null, reason: "保存済みカレンダーに80営業日分がありません。先にホームで日足を取得してください。" };
    const known = new Set(cal.map(d => d.date));
    for (const date = new Date(`${days[0]}T00:00:00Z`); date.toISOString().slice(0, 10) <= asOf; date.setUTCDate(date.getUTCDate() + 1)) {
      if (!known.has(date.toISOString().slice(0, 10))) return { from: null, reason: "期間内の営業日カレンダーに欠損があります。先にホームで日足を取得してください。" };
    }
    if (service.mode !== "demo") {
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      const range = dataWindow(process.env.JQUANTS_PLAN || "Free", today);
      if (days[0] < range.from || asOf > range.to) return { from: null, reason: "80営業日分の期間が契約の取得可能範囲を超えています。基準日を変更してください。" };
    }
    return { from: days[0], reason: null };
  });
  app.get("/api/bottom/hunter/candidates/:code", async (req, reply) => {
    const { code } = z.object({ code: hunterCode }).parse(req.params);
    const q = z.object({ jobId: z.string().uuid().optional(), asOf: z.string().date().optional() }).strict().parse(req.query);
    const id = await hunterJobFor(service, q);
    const result = id ? await hunterCandidate(service, code, id, true) : null;
    if (!result) return reply.code(404).send({ error: "走査済みの銘柄がありません" });
    return result;
  });
  app.get("/api/bottom/hunter/jobs/:id", async req => engine.get(z.object({ id: z.string().uuid() }).parse(req.params).id));
  app.post("/api/bottom/hunter/jobs", async (req, reply) => {
    const resume = z.object({ resumeJobId: z.string().uuid() }).strict().safeParse(req.body);
    const check = await hunterPreflight(service, resume.success ? (await engine.get(resume.data.resumeJobId)).input : req.body);
    if (check.errors.length) return reply.code(400).send({ error: check.errors.join(" ") });
    const job = resume.success ? await engine.resume(resume.data.resumeJobId) : await engine.create(req.body);
    if (job.status !== "completed") launch(job.id);
    return reply.code(202).send(job);
  });
  app.post("/api/bottom/hunter/jobs/:id/cancel", async req => engine.cancel(z.object({ id: z.string().uuid() }).parse(req.params).id));
  app.post("/api/bottom/hunter/forecasts", async req => recordHunterForecast(service, req.body));
  app.get("/api/bottom/hunter/forecasts", async req => {
    const q = z.object({ jobId: z.string().uuid().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict().parse(req.query);
    const records = (await service.predictions()).filter(p => p.methodVersion === HUNTER_FORECAST_METHOD && (!q.jobId || p.hunter?.jobId === q.jobId));
    return { records: records.slice((q.page-1)*q.pageSize, q.page*q.pageSize), total: records.length, page: q.page, pageSize: q.pageSize };
  });
  app.post("/api/bottom/hunter/evaluations", async () => service.store.lock(async () => {
    const { evaluateHunterDue } = await import("./hunter-journal");
    return { count: await evaluateHunterDue(service) };
  }));
  app.get("/api/bottom/hunter/evaluations", async () => ({ groups: await hunterEvaluationSummary(service) }));
}
