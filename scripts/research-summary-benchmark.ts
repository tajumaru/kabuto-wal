import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { hunterEvaluationSummary, hunterId, recordHunterForecast } from "../apps/api/src/hunter-journal";
import { seedHunterRaw } from "../tests/hunter-fixture";

const root = await mkdtemp(path.join(os.tmpdir(), "research-summary-bench-"));
const count = Number(process.argv[2] ?? 120);
if (!Number.isInteger(count) || count < 3 || count > 2000) throw Error("件数は3〜2000です");
const previous = process.env.JQUANTS_PLAN;
process.env.JQUANTS_PLAN = "Light";
try {
  const service = new Service(root, "live", false);
  await service.init();
  const f = await seedHunterRaw(service, 160), engine = new HunterJobs(service);
  const job = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff }); await engine.run(job.id);
  const { records } = await recordHunterForecast(service, { jobId: job.id, code: "72030" });
  for (let i=0; i<count; i++) {
    const p = records[i%3], id = hunterId(["summary-benchmark",i]);
    await service.store.write(`predictions/${id}/original.json`, { ...p, recordId: id, predictionId: id });
    await service.store.write(`predictions/${id}/state.json`, { schemaVersion: 1, status: "pending" });
  }
  const now = new Date("2026-10-17T00:00:00.000Z");
  for (const run of ["cold", "repeat"]) {
    const start = performance.now(), groups = await hunterEvaluationSummary(service, now);
    console.log(JSON.stringify({ run, predictions: count+3, available: groups.reduce((n,g) => n+g.available,0), ms: +(performance.now()-start).toFixed(2), rss: process.memoryUsage().rss, externalCalls: 0 }));
  }
} finally {
  if (previous === undefined) delete process.env.JQUANTS_PLAN; else process.env.JQUANTS_PLAN = previous;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
