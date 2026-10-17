import "dotenv/config";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { walkForwardHunter } from "../apps/api/src/hunter-backtest";
const args = process.argv.slice(2).filter(v => v !== "--");
const value = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i+1]; };
const service = new Service();
await service.init();
const engine = new HunterJobs(service);
if (args.includes("--walk-forward")) {
  console.log(JSON.stringify(await walkForwardHunter(service, { from: value("--from"), to: value("--asOf"), step: Number(value("--step") ?? 20) }), null, 2));
} else if (value("--cancel")) {
  console.log(JSON.stringify(await engine.cancel(value("--cancel")!), null, 2));
} else {
  const job = value("--resume") ? await engine.resume(value("--resume")!) : await engine.create({
    kind: value("--kind") ?? "scan", asOf: value("--asOf"), from: value("--from"), cutoff: value("--cutoff"),
    revision: value("--revision"), concurrency: Number(value("--concurrency") ?? 2), confirmExternal: args.includes("--confirm-external"),
  });
  process.once("SIGINT", () => { void engine.cancel(job.id); });
  console.log(JSON.stringify({ jobId: job.id, status: "started", note: "中断後は --resume で再開できます" }));
  console.log(JSON.stringify(await engine.run(job.id), null, 2));
}
