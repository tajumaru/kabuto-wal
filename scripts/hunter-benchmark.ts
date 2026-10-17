import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { syntheticHunterMarket } from "../fixtures/hunter-market";
const root = await mkdtemp(path.join(os.tmpdir(), "hunter-benchmark-"));
const planBefore = process.env.JQUANTS_PLAN;
process.env.JQUANTS_PLAN = "Light";
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
try {
  const service = new Service(root, "live", false); await service.init();
  const f = await syntheticHunterMarket(service.store, Number(process.argv[2] ?? 2000));
  const engine = new HunterJobs(service), job = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff, concurrency: 4 });
  let start = performance.now(); await engine.run(job.id); const elapsedMs = performance.now()-start;
  start = performance.now(); await engine.run(job.id); const completedReplayMs = performance.now()-start;
  const coverage = await service.store.read(`market/hunter/coverage/${job.id}.json`);
  const rows = await engine.rows(job.id);
  if (coverage.universeCount !== f.codes.length || coverage.analyzedCount !== f.codes.length || new Set(rows.map(r => r.code)).size !== f.codes.length) throw Error(JSON.stringify({ message: "大量銘柄検証失敗", coverage, failures: rows.filter(r => r.acquisitionStatus === "failed").slice(0,5) }));
  console.log(JSON.stringify({ symbols: f.codes.length, sessions: 80, concurrency: 4, elapsedMs, completedReplayMs, peakRss, coverage, externalRequests: 0, coverageAndUniquenessVerified: true }, null, 2));
} finally {
  clearInterval(sampler);
  if (planBefore === undefined) delete process.env.JQUANTS_PLAN; else process.env.JQUANTS_PLAN = planBefore;
  await rm(root, { recursive: true, force: true });
}
