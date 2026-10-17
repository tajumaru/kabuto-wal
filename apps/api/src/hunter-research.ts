import type { Service } from "./service";
import { searchDejavu, snapshot } from "./dejavu";
import { hunterJobSchema } from "../../../packages/core/hunter-schema";
import { MarketIngestion } from "../../../packages/integrations/market-ingestion";
import { readHunterObservations, type HunterIndex } from "./hunter-index";

export async function readHunterSeries(service: Service, jobId: string, code: string) {
  const job = hunterJobSchema.parse(await service.store.read(`market/hunter/jobs/${jobId}.json`));
  if (job.mode !== (service.mode === "demo" ? "demo" : "research")) throw Error("demoと実データのジョブは混在できません");
  if (!job.datasetId || !await service.store.read(`market/hunter/rankings/${jobId}/${code}.json`, null)) throw Error("走査済みの銘柄がありません");
  if (service.mode === "demo") return { job, bars: (await snapshot(service, code, job.cutoff)).filter(b => b.sessionDate <= job.input.asOf) };
  const index = await service.store.read<HunterIndex>(`market/hunter/indexes/${job.datasetId}/manifest.json`);
  if (index.id !== job.datasetId || index.cutoff !== job.cutoff || index.asOf !== job.input.asOf) throw Error("取得系列の参照が一致しません");
  const indexed = await readHunterObservations(service, index, code);
  if (!indexed.observations.length) throw Error("基準日の原本不足");
  const from = indexed.observations.map(o => o.row.Date).sort()[0];
  const series = await new MarketIngestion(service.store, null, process.env.JQUANTS_PLAN || "Free").series(code, job.input.asOf, job.cutoff, from, indexed.observations);
  return { job, bars: series.bars };
}
export async function searchDejavuContext(service: Service, code: string, date?: string, compareCode = code, hunterJobId?: string) {
  if (!hunterJobId) return searchDejavu(service, code, date, compareCode);
  const a = await readHunterSeries(service, hunterJobId, code);
  if (date && a.job.input.asOf !== date) throw Error("基準日とハンタージョブが一致しません");
  const b = compareCode === code ? a : await readHunterSeries(service, hunterJobId, compareCode);
  return searchDejavu(service, code, a.job.input.asOf, compareCode, { cutoff: a.job.cutoff, series: a.bars, compareSeries: b.bars });
}
