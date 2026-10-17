import { randomUUID } from "node:crypto";
import type { Service } from "./service";
import type { Calendar } from "../../../packages/core/index";
import { HUNTER_METHOD, hunterJobInputSchema, hunterJobSchema, hunterCoverageSchema, hunterRowSchema, type HunterJob, type HunterRow, type HunterUniverse } from "../../../packages/core/hunter-schema";
import { classifyBottom, compareHunterRows } from "../../../packages/core/hunter";
import { hash } from "../../../packages/integrations/adjusted-series";
import { MarketIngestion } from "../../../packages/integrations/market-ingestion";
import { JQuants } from "../../../packages/integrations/jquants";
import { RequestDeferred } from "../../../packages/integrations/jquants-limiter";
import { dataWindow, planCapabilities } from "../../../packages/integrations/jquants-plan";
import { buildHunterUniverse } from "./hunter-universe";
import { buildHunterIndex, readHunterObservations, hunterShard, hunterShardReader, type HunterIndex } from "./hunter-index";
import { analyzeBottom } from "./bottom";

import { hunterAnalysisId, hunterDetailKey } from "./hunter-consistency";

const base = "market/hunter";
const jobKey = (id: string) => `${base}/jobs/${id}.json`;
export class HunterJobs {
  private running = new Set<string>();
  constructor(public service: Service, private now = () => new Date(), private providerFactory = () => {
    const key = process.env.JQUANTS_API_KEY;
    if (!key) throw Error("J-Quantsの接続設定が必要です");
    return new JQuants(key, fetch, { root: service.store.root, plan: process.env.JQUANTS_PLAN || "Free" });
  }) {}
  async get(id: string) { return hunterJobSchema.parse(await this.service.store.read(jobKey(id))); }
  async list() {
    const files = (await this.service.store.files(`${base}/jobs`)).filter(f => f.endsWith(".json"));
    const jobs = [];
    for (const file of files) {
      let job = hunterJobSchema.parse(await this.service.store.read(file));
      if (job.status === "running" && job.lease && !this.alive(job.lease)) {
        job = await this.service.store.lock(async () => {
          const current = await this.get(job.id);
          if (current.status !== "running" || !current.lease || this.alive(current.lease)) return current;
          const paused = { ...current, status: "paused" as const, lease: undefined, error: "前回の取得・分析が中断しました。「再開」で保存済みの続きから処理できます。" };
          await this.service.store.write(jobKey(current.id), paused);
          return paused;
        });
      }
      jobs.push(job);
    }
    return jobs.sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
  }
  async create(raw: unknown) {
    const input = hunterJobInputSchema.parse(raw), now = this.now();
    if (input.cutoff && Date.parse(input.cutoff) > now.getTime()) throw Error("取得締切は現在以前です");
    if (input.kind !== "scan" && this.service.mode !== "demo" && !input.confirmExternal) throw Error("実データ取得の明示確認が必要です");
    const plan = process.env.JQUANTS_PLAN || "Free";
    if (this.service.mode !== "demo") {
      const window = dataWindow(plan, now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }));
      if (input.asOf > window.to || input.asOf < window.from || (input.from && input.from < window.from)) throw Error("契約の取得可能期間外です");
    }
    const cal = await this.service.store.read<Calendar>("market/calendar.json", []);
    // Acquisition may refresh the calendar, but offline scans never assume missing sessions.
    if (input.kind === "scan" && !cal.some(d => d.open && d.date === input.asOf)) throw Error("基準日の営業日カレンダーが必要です");
    const job = hunterJobSchema.parse({ schemaVersion: 1, methodVersion: HUNTER_METHOD, id: randomUUID(), mode: this.service.mode === "demo" ? "demo" : "research", input,
      cutoff: input.cutoff ?? now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), status: "queued", cancelRequested: false, processed: 0, total: 0 });
    await this.service.store.lock(async () => { await this.service.store.write(jobKey(job.id), job, true); });
    return job;
  }
  async cancel(id: string) {
    return this.service.store.lock(async () => {
      const job = await this.get(id);
      if (job.status !== "completed") { job.cancelRequested = true; if (job.status !== "running") job.status = "cancelled"; }
      await this.service.store.write(jobKey(id), job); return job;
    });
  }
  async resume(id: string) {
    return this.service.store.lock(async () => {
      const job = await this.get(id);
      if (job.status === "running" && job.lease && this.alive(job.lease)) throw Error("ジョブは実行中です");
      if (job.status === "completed") return job;
      job.status = "queued"; job.cancelRequested = false; job.error = undefined; job.lease = undefined;
      await this.service.store.write(jobKey(id), job); return job;
    });
  }
  private alive(lease: NonNullable<HunterJob["lease"]>) {
    if (lease.expiresAt < this.now().getTime()) return false;
    try { process.kill(lease.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
  private async acquire(id: string) {
    return this.service.store.lock(async () => {
      const job = await this.get(id), token = randomUUID();
      if (job.status === "completed") return null;
      const active = await this.service.store.read<{ id: string; lease: NonNullable<HunterJob["lease"]> } | null>(`${base}/indexes/active.json`, null);
      if (active && this.alive(active.lease)) throw Error("別のハンタージョブが実行中です");
      if (job.cancelRequested) return null;
      job.lease = { token, pid: process.pid, expiresAt: this.now().getTime() + 1800000 };
      job.status = "running"; job.updatedAt = this.now().toISOString();
      job.error = undefined; job.retryAt = undefined; job.failureStage = undefined;
      await this.service.store.write(jobKey(id), job);
      await this.service.store.write(`${base}/indexes/active.json`, { id, lease: job.lease });
      return job;
    });
  }
  private async patch(id: string, token: string, values: Partial<HunterJob>) {
    return this.service.store.lock(async () => {
      const job = await this.get(id);
      if (job.lease?.token !== token) throw Error("ジョブのleaseが変更されました");
      const active = await this.service.store.read<{ lease: { token: string } } | null>(`${base}/indexes/active.json`, null);
      if (active?.lease.token !== token) throw Error("ジョブのlease所有権が変更されました");
      const next = { ...job, ...values, updatedAt: this.now().toISOString() };
      if (next.lease) next.lease = { ...next.lease, expiresAt: this.now().getTime() + 1800000 };
      await this.service.store.write(jobKey(id), next);
      await this.service.store.write(`${base}/indexes/active.json`, next.lease ? { id, lease: next.lease } : null);
      return next;
    });
  }
  async run(id: string, options: { maxSymbols?: number } = {}) {
    if (this.running.has(id)) throw Error("ジョブは実行中です");
    this.running.add(id);
    let job: HunterJob | null = null;
    let stage: "acquisition" | "analysis" = "analysis";
    try {
      job = await this.acquire(id); if (!job) return await this.get(id);
      if (job.mode !== (this.service.mode === "demo" ? "demo" : "research")) throw Error("ジョブのデータ区分が一致しません");
      const token = job.lease!.token;
      let lastHeartbeat = this.now().getTime();
      const cancelled = async () => {
        if (this.now().getTime() - lastHeartbeat > 60000) { await this.patch(id, token, {}); lastHeartbeat = this.now().getTime(); }
        return (await this.get(id)).cancelRequested;
      };
      if (job.input.kind !== "scan") {
        stage = "acquisition";
        await this.acquireMarket(job, cancelled);
        // A new acquisition's data did not exist at job start. Freeze after acquisition.
        if (!job.universeId && !job.input.cutoff) job = await this.patch(id, token, { cutoff: this.now().toISOString() });
      }
      stage = "analysis";
      const cal = await this.service.store.read<Calendar>("market/calendar.json", []);
      const universe = job.universeId ? await this.service.store.read<HunterUniverse>(`${base}/universe/${job.universeId}.json`) : await buildHunterUniverse(this.service, job.input.asOf, job.cutoff);
      if (this.service.mode !== "demo" && universe.inputId === "no-known-master") throw Error("締切以前に取得した基準日のマスターがありません");
      const entries = universe.entries.filter(e => e.included);
      if (entries.length > 20000) throw Error("対象銘柄の安全上限を超えています");
      const from = job.input.from ?? cal.filter(d => d.open && d.date <= job!.input.asOf).map(d => d.date).sort().slice(-80)[0] ?? job.input.asOf;
      const index = await buildHunterIndex(this.service, job.input.asOf, job.cutoff, from, cancelled);
      if (job.datasetId && job.datasetId !== index.id) throw Error("入力revisionが変更されました。新しいジョブを開始してください");
      const analysisId = hunterAnalysisId(job, index, universe.id);
      if (job.analysisId && job.analysisId !== analysisId) throw Error("分析条件が変更されました。新しいジョブを開始してください");
      if (!job.analysisId && job.datasetId) throw Error("旧形式の中断ジョブです。新しいジョブを開始してください");
      job = await this.patch(id, token, { analysisId, universeId: universe.id, datasetId: index.id, total: entries.length });
      let processedThisRun = 0;
      const allRows = await this.rows(id);
      const done = new Set(allRows.map(r => r.code));
      const pending = entries.filter(e => !done.has(e.code)).sort((a,b) => Number(hunterShard(a.code))-Number(hunterShard(b.code)) || a.code.localeCompare(b.code));
      const loadShard = hunterShardReader(this.service);
      for (let i = 0; i < pending.length; i += job.input.concurrency) {
        if (await cancelled()) break;
        const remaining = options.maxSymbols === undefined ? job.input.concurrency : Math.max(0, Math.min(job.input.concurrency, options.maxSymbols - processedThisRun));
        if (!remaining) break;
        await Promise.all(pending.slice(i, i + remaining).map(async entry => {
          const rowKey = `${base}/rankings/${id}/${entry.code}.json`;
          if (await this.service.store.read(rowKey, null)) return;
          const { row, analysis } = await this.screen(job!, index, entry, cal, loadShard);
          await this.service.store.lock(async () => {
            const owner = await this.get(id);
            if (owner.lease?.token !== token || owner.cancelRequested || owner.status !== "running") return;
            const active = await this.service.store.read<{ lease: { token: string } } | null>(`${base}/indexes/active.json`, null);
            if (active?.lease.token !== token) throw Error("ジョブのlease所有権が変更されました");
            if (!(await this.service.store.read(rowKey, null))) {
              const detailKey = hunterDetailKey(job!, entry.code);
              if (!(await this.service.store.read(detailKey, null))) await this.service.store.write(detailKey, { analysis, row }, true);
              await this.service.store.write(rowKey, row, true);
            }
          });
          if (await this.service.store.read(rowKey, null)) allRows.push(row);
          processedThisRun++;
        }));
        job = await this.patch(id, token, { processed: allRows.length });
        await this.coverage(job, universe, allRows);
      }
      const rows = allRows, isCancelled = await cancelled();
      const status = isCancelled ? "cancelled" : rows.length === entries.length ? "completed" : "paused";
      const coverage = await this.coverage(job, universe, rows, status === "completed");
      if (status === "completed") await this.service.store.lock(async () => {
        const owner = await this.get(id);
        if (owner.lease?.token !== token || owner.cancelRequested) throw Error("完了前にジョブが中断されました");
        await this.service.store.write(`${base}/rankings/${id}/index.json`, rows.sort(compareHunterRows).map((r, i) => ({ ...r, rank: i + 1 })));
        await this.service.store.write(`${base}/indexes/latest.json`, { jobId: id, asOf: job!.input.asOf, cutoff: job!.cutoff, datasetId: index.id });
        await this.service.store.write(`${base}/indexes/dates/${job!.input.asOf}.json`, { jobId: id });
      });
      job = await this.patch(id, token, { processed: rows.length, status, lease: undefined });
      return { ...job, coverage };
    } catch (error) {
      if (job?.lease) {
        const current = await this.get(id);
        if (current.lease?.token === job.lease.token) await this.patch(id, job.lease.token, { status: current.cancelRequested ? "cancelled" : error instanceof RequestDeferred ? "paused" : "failed", error: error instanceof Error ? error.message : "走査に失敗しました", failureStage: stage, retryAt: error instanceof RequestDeferred ? error.retryAt : undefined, lease: undefined });
      }
      throw error;
    } finally { this.running.delete(id); }
  }
  async rows(id: string) {
    const rows: HunterRow[] = [];
    for (const file of (await this.service.store.files(`${base}/rankings/${id}`)).filter(f => !f.endsWith("/index.json"))) rows.push(hunterRowSchema.parse(await this.service.store.read(file)));
    return rows;
  }
  private async screen(job: HunterJob, index: HunterIndex, entry: HunterUniverse["entries"][number], cal: Calendar, loadShard: ReturnType<typeof hunterShardReader>) {
    const cache = await this.service.store.read<{ analysis: Awaited<ReturnType<typeof analyzeBottom>>; row: HunterRow } | null>(hunterDetailKey(job, entry.code), null);
    if (cache) {
      if (cache.row.code !== entry.code || cache.row.asOf !== job.input.asOf || cache.row.cutoff !== job.cutoff || cache.row.methodVersion !== job.methodVersion) throw Error("分析キャッシュの参照が一致しません");
      return { ...cache, row: { ...cache.row, jobId: job.id } };
    }
    let lastSession: string | null;
    let continuousSessions = 0, acquisitionStatus: HunterRow["acquisitionStatus"] = "missing", failure: string | undefined;
    let series: Awaited<ReturnType<MarketIngestion["series"]>> | null = null;
    if (this.service.mode !== "demo") {
      const indexed = await readHunterObservations(this.service, index, entry.code, loadShard);
      continuousSessions = indexed.continuousSessions;
      lastSession = indexed.lastSession;
      if (index.failedDates.length) acquisitionStatus = "failed";
      if (indexed.observations.length) try {
        const from = indexed.observations.map(r => r.row.Date).sort()[0];
        series = await new MarketIngestion(this.service.store, null, process.env.JQUANTS_PLAN || "Free").series(entry.code, job.input.asOf, job.cutoff, from, indexed.observations);
        acquisitionStatus = "ready";
      } catch (e) { acquisitionStatus = "failed"; failure = e instanceof Error ? e.message : "系列構築失敗"; }
    } else {
      const bars = (await this.service.history(entry.code)).filter(b => b.sessionDate <= job.input.asOf && b.availableAt <= job.cutoff);
      const have = new Set(bars.map(b => b.sessionDate));
      lastSession = bars.at(-1)?.sessionDate ?? null;
      for (const date of cal.filter(d => d.open && d.date <= job.input.asOf).map(d => d.date).sort().reverse()) { if (!have.has(date)) break; continuousSessions++; }
      acquisitionStatus = bars.some(b => b.sessionDate === job.input.asOf) ? "ready" : "missing";
    }
    const analysis = await analyzeBottom(this.service, entry.code, job.input.asOf, this.now(), { cutoff: job.cutoff, ...(this.service.mode === "demo" ? {} : { series }), calendar: cal });
    // Never hide a failed raw path by falling back to unrelated legacy prices.
    if (this.service.mode !== "demo" && !series) {
      analysis.status = "unavailable"; analysis.score = null; analysis.indicators = null; analysis.conditions = []; analysis.chart = []; analysis.candidatePrerequisite = false;
      analysis.reasonCodes = [...new Set([...analysis.reasonCodes, failure ? "adjustment_failed" : "no_raw_prices"])];
    }
    const row = hunterRowSchema.parse({ schemaVersion: 1, methodVersion: HUNTER_METHOD, jobId: job.id,
      code: entry.code, name: entry.name, market: entry.market, marketName: entry.marketName, rank: null,
      asOf: job.input.asOf, cutoff: job.cutoff, inputId: hash([job.analysisId, index.id, analysis.inputRevisionIds]),
      score: analysis.score, ...classifyBottom(analysis),
      rsi: analysis.indicators?.rsi14 ?? null, drawdown: analysis.indicators?.drawdown60 ?? null, volumeRatio: analysis.indicators?.volumeRatio ?? null,
      averageTurnover20: analysis.averageTurnover20 ?? null, liquidity: analysis.liquidity,
      reasons: [...analysis.conditions.filter(c => c.met).map(c => c.label), ...analysis.reasonCodes], risks: analysis.riskCodes,
      acquisitionStatus, lastSession, continuousSessions, observedAt: analysis.observedAt, acquisitionError: failure });
    return { row, analysis };
  }
  private async coverage(job: HunterJob, universe: HunterUniverse, rows: HunterRow[], complete = false) {
    const reasons = { ...universe.excludedReasons };
    for (const row of rows.filter(r => r.category === "判定不能")) for (const reason of row.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
    const plan = this.service.mode === "demo" ? null : planCapabilities(process.env.JQUANTS_PLAN || "Free");
    const coverage = hunterCoverageSchema.parse({ schemaVersion: 1, methodVersion: HUNTER_METHOD, jobId: job.id,
      asOf: job.input.asOf, cutoff: job.cutoff, mode: job.mode, universeCount: universe.entries.filter(e => e.included).length,
      excludedCount: universe.entries.filter(e => !e.included).length, acquiredCount: rows.filter(r => r.acquisitionStatus === "ready").length,
      continuous80Count: rows.filter(r => r.continuousSessions >= 80).length, analyzedCount: rows.filter(r => r.category !== "判定不能").length,
      candidateCount: rows.filter(r => r.candidate).length, unavailableCount: rows.filter(r => r.category === "判定不能").length,
      failedCount: rows.filter(r => r.acquisitionStatus === "failed").length, processedCount: rows.length, delayDays: plan?.delayDays ?? 0,
      lastObservedAt: rows.flatMap(r => r.observedAt ? [r.observedAt] : []).sort().at(-1) ?? null, exclusionReasons: reasons,
      periodFrom: job.input.from ?? (await this.service.store.read<HunterIndex>(`${base}/indexes/${job.datasetId}/manifest.json`)).dates[0] ?? null, periodTo: job.input.asOf, plan: this.service.mode === "demo" ? "fixture" : process.env.JQUANTS_PLAN || "Free",
      complete: complete && rows.every(r => r.acquisitionStatus === "ready" && r.category !== "判定不能") });
    await this.service.store.lock(() => this.service.store.write(`${base}/coverage/${job.id}.json`, coverage));
    return coverage;
  }
  private async acquireMarket(job: HunterJob, cancelled: () => Promise<boolean>) {
    if (this.service.mode === "demo") return;
    if (!job.input.confirmExternal) throw Error("実データ取得の明示確認が必要です");
    const provider = this.providerFactory(), from = job.input.from!, asOf = job.input.asOf;
    await this.patch(job.id, job.lease!.token, { acquisition: { completed: 0, total: 0 } });
    const days = await provider.calendar(from, asOf);
    await this.service.store.lock(async () => {
      const merged = new Map((await this.service.store.read<Calendar>("market/calendar.json", [])).map(d => [d.date, d]));
      for (const d of days) merged.set(d.date, d);
      await this.service.store.write("market/calendar.json", [...merged.values()].sort((a,b) => a.date.localeCompare(b.date)));
    });
    const ingestion = new MarketIngestion(this.service.store, provider, process.env.JQUANTS_PLAN || "Free", this.now, cancelled);
    const selected = days.filter(d => d.open).sort((a,b) => a.date.localeCompare(b.date));
    if (!selected.some(d => d.date === asOf)) throw Error("基準日は営業日ではありません");
    const targets = job.input.kind === "correction" ? selected.slice(-5) : selected;
    let completed = 0;
    for (const day of targets) {
      if (await cancelled()) throw Error("取得をキャンセルしました");
      await this.patch(job.id, job.lease!.token, { acquisition: { completed, total: targets.length, date: day.date } });
      await ingestion.ingestDate(day.date, job.input.kind === "correction" ? job.input.revision! : "initial");
      await this.patch(job.id, job.lease!.token, { acquisition: { completed: ++completed, total: targets.length, date: day.date } });
    }
  }
}
