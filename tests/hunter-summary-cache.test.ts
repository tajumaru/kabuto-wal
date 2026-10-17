import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { hunterEvaluationSummary, recordHunterForecast, hunterId, evaluateHunterDue } from "../apps/api/src/hunter-journal";
import { saveHunterSummary, readHunterSummary } from "../apps/api/src/hunter-summary-cache";
import { MarketIngestion } from "../packages/integrations/market-ingestion";
import { seedHunterRaw } from "./hunter-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("価格再構成を同一銘柄・対象日で集約し、revision・評価更新をキャッシュへ反映する", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light");
  const root = await mkdtemp(path.join(os.tmpdir(), "hunter-summary-cache-")), service = new Service(root, "live", false);
  try {
    await service.init(); const f = await seedHunterRaw(service, 160), engine = new HunterJobs(service);
    const job = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff }); await engine.run(job.id);
    const { records } = await recordHunterForecast(service, { jobId: job.id, code: "72030" });
    for (let i=0;i<6;i++) {
      const p = records[i%3], id = hunterId(["cache-test",i]);
      await service.store.write(`predictions/${id}/original.json`, { ...p, recordId: id, predictionId: id });
      await service.store.write(`predictions/${id}/state.json`, { status: "pending" });
    }
    const series = vi.spyOn(MarketIngestion.prototype, "series"), now = new Date("2026-10-17T00:00:00.000Z");
    const first = await hunterEvaluationSummary(service, now);
    expect(first.reduce((n,g) => n+g.available,0)).toBe(9);
    expect(series).toHaveBeenCalledTimes(3);
    first[0].available = 999; // Response objects cannot corrupt the cached result.
    expect((await hunterEvaluationSummary(service, now)).reduce((n,g) => n+g.available,0)).toBe(9);
    expect(series).toHaveBeenCalledTimes(3);
    const checkpoint = `market/ingestion/${f.asOf}/initial/checkpoint.json`;
    await service.store.write(checkpoint, { ...(await service.store.read(checkpoint)), revision: "metadata-revision-new" });
    await hunterEvaluationSummary(service, now); expect(series).toHaveBeenCalledTimes(6);
    await service.store.lock(() => evaluateHunterDue(service, now)); series.mockClear();
    const evaluated = await hunterEvaluationSummary(service, now);
    expect(evaluated.reduce((n,g) => n+g.evaluated,0)).toBe(9); expect(series).not.toHaveBeenCalled();
    const id = hunterId(["future"]), p = records[0];
    await service.store.write(`predictions/${id}/original.json`, { ...p, recordId: id, predictionId: id, targetSessionDate: "2027-10-01" });
    await service.store.write(`predictions/${id}/state.json`, { status: "pending" });
    expect((await hunterEvaluationSummary(service, now)).reduce((n,g) => n+g.pending,0)).toBe(1);
    expect(series).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
it("保存済みの未来観測が利用可能になる瞬間と時刻巻き戻しで失効する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hunter-summary-time-")), service = new Service(root, "demo", false);
  try {
    await service.store.write("prices/72030/future.json", { availableAt: "2026-10-17T01:00:00.000Z" });
    await saveHunterSummary(service, "key", new Date("2026-10-17T00:00:00.000Z"), ["prices/72030/future.json"], { count: 1 });
    expect(readHunterSummary(service, "key", new Date("2026-10-17T00:30:00.000Z"))).toEqual({ count: 1 });
    expect(readHunterSummary(service, "key", new Date("2026-10-17T01:00:00.000Z"))).toBeNull();
    expect(readHunterSummary(service, "key", new Date("2026-10-16T23:59:59.000Z"))).toBeNull();
    expect(readHunterSummary(service, "other", new Date("2026-10-17T00:30:00.000Z"))).toBeNull();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
