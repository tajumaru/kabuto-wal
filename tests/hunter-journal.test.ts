import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { recordHunterForecast, hunterEvaluationSummary } from "../apps/api/src/hunter-journal";
import { seedHunterRaw } from "./hunter-fixture";

it("原本を不変保存し、期限後評価を別保存して過去研究と実運用を分離する", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light");
  const dir = await mkdtemp(path.join(os.tmpdir(), "hunter-journal-")), service = new Service(dir, "live", false);
  try {
    await service.init(); const f = await seedHunterRaw(service, 160);
    const engine = new HunterJobs(service), job = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff });
    await engine.run(job.id);
    const first = await recordHunterForecast(service, { jobId: job.id, code: "72030", recordingMode: "walk-forward" });
    expect(first.records).toHaveLength(3);
    expect(first.records.every(p => p.mode === "backtest" && p.hunter?.experiment === "walk-forward")).toBe(true);
    const originals = JSON.stringify(first.records);
    expect(JSON.stringify((await recordHunterForecast(service, { jobId: job.id, code: "72030", recordingMode: "walk-forward" }, new Date("2026-10-18T00:00:00.000Z"))).records)).toBe(originals);
    await expect(recordHunterForecast(service, { jobId: job.id, code: "72030", recordingMode: "live" })).rejects.toThrow("過去日付");
    const research = await recordHunterForecast(service, { jobId: job.id, code: "72030" });
    expect(research.records[0].mode).toBe("research");
    expect(research.records[0].predictionId).not.toBe(first.records[0].predictionId);
    expect((await hunterEvaluationSummary(service)).reduce((s,g) => s+g.available,0)).toBe(6);
    expect(await service.store.lock(() => service.evaluateDue())).toBe(6);
    expect(await service.store.lock(() => service.evaluateDue())).toBe(0);
    expect((await hunterEvaluationSummary(service)).reduce((s,g) => s+g.evaluated,0)).toBe(6);
    expect((await service.predictions()).every(p => p.evaluations.length === 1 && p.evaluations[0].maxDrawdown <= 0)).toBe(true);
    expect(JSON.stringify(await Promise.all(first.records.map(p => service.store.read(`predictions/${p.predictionId}/original.json`))))).toBe(originals);
  } finally { await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
