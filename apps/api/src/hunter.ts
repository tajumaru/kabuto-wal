import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Service } from "./service";
import { HunterJobs } from "./hunter-jobs";
import { explainBottom } from "../../../packages/core/hunter";
import { hunterCode, hunterFilterSchema, hunterRankingsSchema, hunterStatusSchema, hunterDetailSchema, hunterJobSchema, type HunterCoverage, type HunterRow } from "../../../packages/core/hunter-schema";
import type { BottomAnalysis } from "../../../packages/core/bottom-schema";

export const HUNTER_BASE = "market/hunter";
export async function hunterJobFor(service: Service, selector: { jobId?: string; asOf?: string }) {
  if (selector.jobId) return selector.jobId;
  const latest = await service.store.read<{ jobId: string } | null>(`${HUNTER_BASE}/indexes/${selector.asOf ? `dates/${selector.asOf}` : "latest"}.json`, null);
  return latest?.jobId ?? null;
}
export async function hunterRankings(service: Service, raw: unknown) {
  const q = hunterFilterSchema.parse(raw), id = await hunterJobFor(service, q);
  const coverage = id ? await service.store.read<HunterCoverage | null>(`${HUNTER_BASE}/coverage/${id}.json`, null) : null;
  const rows = id ? await service.store.read<HunterRow[]>(`${HUNTER_BASE}/rankings/${id}/index.json`, []) : [];
  const selected = rows.filter(r => (!q.asOf || r.asOf === q.asOf) && (!q.market || r.market === q.market) &&
    (q.minScore === undefined || (r.score !== null && r.score >= q.minScore)) &&
    (q.rsiMin === undefined || (r.rsi !== null && r.rsi >= q.rsiMin)) && (q.rsiMax === undefined || (r.rsi !== null && r.rsi <= q.rsiMax)) &&
    (q.maxDrawdown === undefined || (r.drawdown !== null && r.drawdown <= q.maxDrawdown)) &&
    (!q.liquidity || r.liquidity === q.liquidity) && (!q.category || r.category === q.category) &&
    (!q.risk || (q.risk === "yes" ? r.risks.length > 0 : r.risks.length === 0)));
  return hunterRankingsSchema.parse({ coverage, total: selected.length, page: q.page, pageSize: q.pageSize,
    rows: selected.slice((q.page - 1) * q.pageSize, q.page * q.pageSize) });
}
export async function hunterCandidate(service: Service, code: string, id: string) {
  const job = hunterJobSchema.parse(await service.store.read(`${HUNTER_BASE}/jobs/${id}.json`));
  if (!job.datasetId) return null;
  const row = await service.store.read<HunterRow | null>(`${HUNTER_BASE}/rankings/${id}/${code}.json`, null);
  if (!row) return null;
  const detail = await service.store.read<{ analysis: BottomAnalysis }>(`${HUNTER_BASE}/details/${job.datasetId}/${code}.json`);
  return hunterDetailSchema.parse({ row, analysis: detail.analysis, explanation: explainBottom(detail.analysis), dejavu: null });
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
    return hunterStatusSchema.parse({ mode: service.mode === "demo" ? "demo" : "research", plan: service.mode === "demo" ? "fixture" : process.env.JQUANTS_PLAN || "Free",
      delayDays: service.mode !== "demo" && (process.env.JQUANTS_PLAN || "Free") === "Free" ? 84 : 0, jobs: await engine.list(), coverage });
  });
  app.get("/api/bottom/hunter/rankings", async req => hunterRankings(service, req.query));
  app.get("/api/bottom/hunter/candidates/:code", async (req, reply) => {
    const { code } = z.object({ code: hunterCode }).parse(req.params);
    const q = z.object({ jobId: z.string().uuid().optional(), asOf: z.string().date().optional() }).strict().parse(req.query);
    const id = await hunterJobFor(service, q);
    const result = id ? await hunterCandidate(service, code, id) : null;
    if (!result) return reply.code(404).send({ error: "走査済みの銘柄がありません" });
    return result;
  });
  app.get("/api/bottom/hunter/jobs/:id", async req => engine.get(z.object({ id: z.string().uuid() }).parse(req.params).id));
  app.post("/api/bottom/hunter/jobs", async (req, reply) => {
    const resume = z.object({ resumeJobId: z.string().uuid() }).strict().safeParse(req.body);
    const job = resume.success ? await engine.resume(resume.data.resumeJobId) : await engine.create(req.body);
    if (job.status !== "completed") launch(job.id);
    return reply.code(202).send(job);
  });
  app.post("/api/bottom/hunter/jobs/:id/cancel", async req => engine.cancel(z.object({ id: z.string().uuid() }).parse(req.params).id));
}
