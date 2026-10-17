import { z } from "zod";
import type { Service } from "./service";
import { predictionSchema } from "../../../packages/core/index";
import { HUNTER_FORECAST_METHOD,hunterScoreBand } from "../../../packages/core/hunter-method";
import { independentScoreOutcomes,researchOutcomeReportSchema,type OutcomeObservation } from "../../../packages/core/research-outcomes";
import { assessHunter } from "./hunter-journal";
import { HunterJobs } from "./hunter-jobs";
import { snapshot } from "./dejavu";
import { MarketIngestion } from "../../../packages/integrations/market-ingestion";
import { hash } from "../../../packages/integrations/adjusted-series";
import { readHunterSummary,saveHunterSummary } from "./hunter-summary-cache";
import type { Bar } from "../../../packages/core/index";
const evaluation=z.object({predictionId:z.string(),methodVersion:z.string(),createdAt:z.string().datetime(),evaluatedCutoff:z.string().datetime().optional(),actualReturn:z.number().finite(),maxDrawdown:z.number().finite().nullable().optional(),relapse:z.boolean().optional()});
export async function researchOutcomeReport(service:Service, jobId?:string, now=new Date()) {
  const generation=await service.store.generation(),key=hash(["research-outcomes-v2",generation,service.mode,process.env.JQUANTS_PLAN||"Free",jobId]);
  const cached=generation&&process.env.RESEARCH_INDEX_FULL_AUDIT!=="true"?readHunterSummary<ReturnType<typeof researchOutcomeReportSchema.parse>>(service,key,now):null;if(cached)return cached;
  const rows:OutcomeObservation[]=[];
  const prepared: {p:ReturnType<typeof predictionSchema.parse>;ev?:z.infer<typeof evaluation>}[]=[];
  const allRecords=await service.predictions();
  for (const raw of allRecords) {
    const parsed=predictionSchema.safeParse(raw); if(!parsed.success) continue; const p=parsed.data;
    if(p.methodVersion!==HUNTER_FORECAST_METHOD||!p.hunter||(service.mode==="demo"?p.mode!=="demo":p.mode==="demo")||p.generatedAt>now.toISOString()||p.createdAt>now.toISOString()||p.hunter.recordedAt>now.toISOString()||p.hunter.cutoff>now.toISOString()) continue;
    const ev=(raw.evaluations as unknown[]).flatMap(r=>{const e=evaluation.safeParse(r);return e.success?[e.data]:[];}).filter(e=>e.predictionId===p.predictionId&&e.methodVersion===p.methodVersion&&e.createdAt<=now.toISOString()&&(!e.evaluatedCutoff||e.evaluatedCutoff<=now.toISOString())&&p.targetSessionDate<=now.toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"})).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1);
    prepared.push({p,ev});
  }
  const today=now.toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"}),starts=new Map<string,string>(),prices=new Map<string,Promise<Bar[]>>();
  for(const {p,ev} of prepared)if(!ev&&p.targetSessionDate<=today){const k=`${p.providerCode}/${p.targetSessionDate}`;starts.set(k,[starts.get(k)??p.dataAsOf,p.dataAsOf].sort()[0]);}
  for(const {p,ev} of prepared){if(!p.hunter)continue;
    let eligible=!!ev;
    if(!ev&&p.targetSessionDate<=today){const k=`${p.providerCode}/${p.targetSessionDate}`;let pending=prices.get(k);if(!pending){pending=service.mode==="demo"?snapshot(service,p.providerCode,now.toISOString()):new MarketIngestion(service.store,null,process.env.JQUANTS_PLAN||"Free").series(p.providerCode,p.targetSessionDate,now.toISOString(),starts.get(k)!,undefined,false).then(s=>s.bars);prices.set(k,pending);}try{eligible=!!await assessHunter(service,p,now,await pending);}catch{eligible=false;}}
    rows.push({id:p.predictionId,code:p.providerCode,asOf:p.dataAsOf,target:p.targetSessionDate,mode:p.mode,experiment:p.hunter.experiment,horizon:p.horizonSessions,score:p.hunter.analysis.score,classification:p.hunter.classification,methodVersion:p.methodVersion,eligible,
      ...(ev?{evaluation:{actualReturn:ev.actualReturn,predictedReturn:p.predictedReturn,maxDrawdown:ev.maxDrawdown??null,relapse:ev.relapse}}:{})});
  }
  const control={jobId:jobId??null,ready:0,candidates:0,nonCandidates:0,bands:{} as Record<string,number>,outcomes:"not-recorded" as const};
  if(jobId) {
    const engine=new HunterJobs(service),job=await engine.get(jobId);
    if(job.mode!==(service.mode==="demo"?"demo":"research")) throw Error("データ区分不一致");
    for(const row of await engine.rows(jobId)) if(row.score!==null&&row.category!=="判定不能") {control.ready++;control.candidates+=Number(row.candidate);control.nonCandidates+=Number(!row.candidate);const band=hunterScoreBand(row.score);control.bands[band]=(control.bands[band]??0)+1;}
  }
  const result=researchOutcomeReportSchema.parse({groups:independentScoreOutcomes(rows),control,notes:[`集計時点 ${now.toISOString()}。全銘柄の保存済み仮説を対象とした期限後検証です。研究基準日当時のEvidenceとは別集計です。`,"スコアは確率ではありません。80点以上の優位性は仮定していません。","同一銘柄・方式・実験・期間の重複結果窓を除外。異なる期間間・銘柄間の相関は残ります。","少数標本または20銘柄未満は信頼性が低い集計です。","再下落は期間中に基準価格を上回った後、基準価格を下回ること。旧評価の未記録値は推定しません。","非候補比較は判定可能な全銘柄を母集団に固定し、候補と同じ期間・締切で評価する設計です。現在の非候補は予測原本がなく、成績は未記録です。"]});
  if(generation&&generation===await service.store.generation()){
    const files=(await Promise.all(["prices","revisions","market/ingestion"].map(p=>service.store.files(p)))).flat().filter(f=>!f.includes("/pages/"));
    await saveHunterSummary(service,key,now,files,result,allRecords);
  }
  return result;
}
