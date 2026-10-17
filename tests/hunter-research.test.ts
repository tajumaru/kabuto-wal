import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { analyzeBottom } from "../apps/api/src/bottom";
import { searchDejavuContext, readHunterSeries } from "../apps/api/src/hunter-research";
import { seedHunterRaw } from "./hunter-fixture";

it("新原本だけで個別解析と走査を一致させ、デジャヴへ同一系列を渡す", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light");
  const root = await mkdtemp(path.join(os.tmpdir(), "hunter-research-")), service = new Service(root, "live", false);
  try {
    await service.init(); const f = await seedHunterRaw(service);
    const engine = new HunterJobs(service), job = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff });
    await engine.run(job.id);
    const row = (await engine.rows(job.id))[0], direct = await analyzeBottom(service, row.code, f.asOf);
    expect(row.score).toBe(direct.score); expect(row.candidate).toBe(true);
    expect(direct.liquidity).toBe("sufficient"); expect(await service.history("72030")).toEqual([]);
    const { bars } = await readHunterSeries(service, job.id, "72030");
    expect(new Set(bars.map(b => b.seriesId)).size).toBe(1);
    expect(bars.every(b => b.sessionDate <= f.asOf && b.availableAt <= f.cutoff)).toBe(true);
    const r = await searchDejavuContext(service, "72030", f.asOf, "72030", job.id);
    expect(r.examples.every(e => e.outcomeEnd < r.queryStart)).toBe(true);
    expect(r.consensus.methodVersion).toBe("dejavu-consensus-v1");
    await expect(searchDejavuContext(service, "72030", "2020-01-01", "72030", job.id)).rejects.toThrow("一致");
  } finally { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
