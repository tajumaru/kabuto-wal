import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { recordHunterForecast, hunterEvaluationSummary } from "../apps/api/src/hunter-journal";
import { seedHunterRaw } from "./hunter-fixture";
import { hunterScoreBand, hunterDistribution } from "../packages/core/hunter-method";
import { walkForwardHunter } from "../apps/api/src/hunter-backtest";

it("原本を不変保存し、期限後評価を別保存して過去研究と実運用を分離する", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light");
  const dir = await mkdtemp(path.join(os.tmpdir(), "hunter-journal-")), service = new Service(dir, "live", false);
  try {
    await service.init(); const f = await seedHunterRaw(service, 160);
    const engine = new HunterJobs(service), job = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff });
    await engine.run(job.id);
    const first = await recordHunterForecast(service, { jobId: job.id, code: "72030", recordingMode: "walk-forward" });
    expect(first.records).toHaveLength(3);
    expect(first.records[0].hunter?.analysisId).toBe((await engine.get(job.id)).analysisId);
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
    const walk = await walkForwardHunter(service, { from: f.asOf, to: f.asOf, step: 20 });
    expect(walk.steps[0]).toMatchObject({ asOf: f.asOf, records: 3, excluded: 0 });
    expect((await walkForwardHunter(service, { from: f.asOf, to: f.asOf, step: 20 })).steps).toEqual(walk.steps);
    const source = (await service.predictions()).find(p => p.evaluations.length)!;
    const samples = [0,39,40,59,60,79,80,100].flatMap((score, i) => ["retrospective", "walk-forward", "prospective"].map(experiment => ({
      ...source, mode: experiment === "prospective" ? "live" : experiment === "walk-forward" ? "backtest" : "research",
      dataAsOf: i%2 ? "2026-09-01" : "2026-10-01",
      hunter: { ...source.hunter!, experiment, analysis: { ...source.hunter!.analysis, score } },
      evaluations: [{ ...source.evaluations[0], actualReturn: i%2 ? -0.2 : 0.1, returnError: i%2 ? 0.3 : -0.1, maxDrawdown: i%2 ? -0.3 : -0.05 }],
    })));
    const spy = vi.spyOn(service, "predictions").mockResolvedValue(samples as Awaited<ReturnType<Service["predictions"]>>);
    const grouped = await hunterEvaluationSummary(service);
    expect(grouped).toHaveLength(24);
    expect(new Set(grouped.map(g => g.band))).toEqual(new Set(["0-39","40-59","60-79","80-100"]));
    expect(grouped.every(g => g.lowSample && g.eligible === 1 && g.evaluated === 1)).toBe(true);
    expect(grouped.filter(g => g.period === "2026-09").every(g => g.meanReturn === -0.2 && g.upRatio === 0 && g.medianReturn === -0.2)).toBe(true);
    expect(grouped.filter(g => g.period === "2026-10").every(g => g.meanReturn === 0.1 && g.upRatio === 1)).toBe(true);
    spy.mockRestore();

  } finally { await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});

it("スコア帯の境界と最大下落分布の補間を固定する", () => {
  expect([0,39,40,59,60,79,80,100,null].map(hunterScoreBand)).toEqual(["0-39","0-39","40-59","40-59","60-79","60-79","80-100","80-100","unknown"]);
  expect(hunterDistribution([]).median).toBeNull();
  expect(hunterDistribution([-0.4,0,-0.2]).median).toBe(-0.2);
  expect(hunterDistribution([-0.4,0]).median).toBe(-0.2);
});
