import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { seedHunterRaw } from "./hunter-fixture";
import { readHunterSeries } from "../apps/api/src/hunter-research";
import { walkForwardHunter } from "../apps/api/src/hunter-backtest";
import { hash, type RawDaily } from "../packages/integrations/adjusted-series";

it("訂正revisionを新ジョブに分離し、欠損・未取得時点・索引破損を安全に扱う", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light");
  const root = await mkdtemp(path.join(os.tmpdir(), "hunter-safety-")), service = new Service(root, "live", false);
  try {
    await service.init(); const f = await seedHunterRaw(service, 120);
    const engine = new HunterJobs(service);
    const job = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff }); await engine.run(job.id);
    const before = (await engine.rows(job.id))[0];
    const paused = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff });
    await engine.run(paused.id, { maxSymbols: 0 });
    const base = `market/ingestion/${f.asOf}/initial`;
    const cp = await service.store.read(`${base}/checkpoint.json`);
    const old: RawDaily[] = await service.store.read(`${base}/pages/${cp.pages[0].hash}.json`);
    const changed = old.map(r => ({ ...r, Vo: 100, Va: 10000 })), id = hash(changed), correction = `market/ingestion/${f.asOf}/correction-test`;
    await service.store.write(`${correction}/pages/${id}.json`, changed);
    await service.store.write(`${correction}/checkpoint.json`, { ...cp, revision: "correction-test", pages: [{ hash: id, count: 1, observedAt: `${f.asOf}T10:00:00.000Z` }] });
    await engine.resume(paused.id);
    await expect(engine.run(paused.id)).rejects.toThrow("入力revisionが変更");
    const newer = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff }); await engine.run(newer.id);
    expect((await engine.get(newer.id)).datasetId).not.toBe((await engine.get(job.id)).datasetId);
    expect((await engine.rows(job.id))[0]).toEqual(before);
    expect((await engine.rows(newer.id))[0].inputId).not.toBe(before.inputId);
    const early = await engine.create({ asOf: f.asOf, from: f.from, cutoff: `${f.asOf}T07:00:00.000Z` });
    await expect(engine.run(early.id)).rejects.toThrow("マスター");
    const index = await service.store.read(`market/hunter/indexes/${(await engine.get(job.id)).datasetId}/manifest.json`);
    const shard = (await service.store.files(`market/hunter/indexes/${index.id}/shards`))[0];
    const body = await service.store.read(shard); body.entries[0].row.C = 999;
    await service.store.write(shard, body);
    await expect(readHunterSeries(service, job.id, "72030")).rejects.toThrow("破損");
    // Losing a required session yields an unavailable result, never imputation.
    const missingDay = f.bars[90].sessionDate, missingCp = await service.store.read(`market/ingestion/${missingDay}/initial/checkpoint.json`);
    await service.store.write(`market/ingestion/${missingDay}/initial/checkpoint.json`, { ...missingCp, status: "partial", error: "fixture interruption" });
    const missing = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff }); await engine.run(missing.id);
    expect((await engine.rows(missing.id))[0]).toMatchObject({ category: "判定不能", candidate: false });
    const walk = await walkForwardHunter(service, { from: f.asOf, to: f.asOf, step: 20 });
    expect(walk.steps).toHaveLength(1);
    expect((await walkForwardHunter(service, { from: f.asOf, to: f.asOf, step: 20 })).steps).toEqual(walk.steps);
  } finally { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
