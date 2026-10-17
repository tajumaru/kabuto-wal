import { z } from "zod";
import type { Service } from "./service";
import { predictionSchema } from "../../../packages/core/index";
import { HUNTER_FORECAST_METHOD,hunterScoreBand } from "../../../packages/core/hunter-method";
import { independentScoreOutcomes,researchOutcomeReportSchema,type OutcomeObservation } from "../../../packages/core/research-outcomes";
import { assessHunter } from "./hunter-journal";
import { HunterJobs } from "./hunter-jobs";
const evaluation=z.object({predictionId:z.string(),methodVersion:z.string(),createdAt:z.string().datetime(),evaluatedCutoff:z.string().datetime().optional(),actualReturn:z.number().finite(),maxDrawdown:z.number().finite().nullable().optional(),relapse:z.boolean().optional()});
export async function researchOutcomeReport(service:Service, jobId?:string, now=new Date()) {
  const rows:OutcomeObservation[]=[];
  for (const raw of await service.predictions()) {
    const parsed=predictionSchema.safeParse(raw); if(!parsed.success) continue; const p=parsed.data;
    if(p.methodVersion!==HUNTER_FORECAST_METHOD||!p.hunter||(service.mode==="demo"?p.mode!=="demo":p.mode==="demo")||p.generatedAt>now.toISOString()||p.createdAt>now.toISOString()||p.hunter.recordedAt>now.toISOString()||p.hunter.cutoff>now.toISOString()) continue;
    const ev=(raw.evaluations as unknown[]).flatMap(r=>{const e=evaluation.safeParse(r);return e.success?[e.data]:[];}).filter(e=>e.predictionId===p.predictionId&&e.methodVersion===p.methodVersion&&e.createdAt<=now.toISOString()&&(!e.evaluatedCutoff||e.evaluatedCutoff<=now.toISOString())&&p.targetSessionDate<=now.toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"})).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1);
    const eligible=!!ev||!!await assessHunter(service,p,now);
    rows.push({id:p.predictionId,code:p.providerCode,asOf:p.dataAsOf,target:p.targetSessionDate,mode:p.mode,experiment:p.hunter.experiment,horizon:p.horizonSessions,score:p.hunter.analysis.score,classification:p.hunter.classification,methodVersion:p.methodVersion,eligible,
      ...(ev?{evaluation:{actualReturn:ev.actualReturn,predictedReturn:p.predictedReturn,maxDrawdown:ev.maxDrawdown??null,relapse:ev.relapse}}:{})});
  }
  const control={jobId:jobId??null,ready:0,candidates:0,nonCandidates:0,bands:{} as Record<string,number>,outcomes:"not-recorded" as const};
  if(jobId) {
    const engine=new HunterJobs(service),job=await engine.get(jobId);
    if(job.mode!==(service.mode==="demo"?"demo":"research")) throw Error("データ区分不一致");
    for(const row of await engine.rows(jobId)) if(row.score!==null&&row.category!=="判定不能") {control.ready++;control.candidates+=Number(row.candidate);control.nonCandidates+=Number(!row.candidate);const band=hunterScoreBand(row.score);control.bands[band]=(control.bands[band]??0)+1;}
  }
  return researchOutcomeReportSchema.parse({groups:independentScoreOutcomes(rows),control,notes:[`集計時点 ${now.toISOString()}。全銘柄の保存済み仮説を対象とした期限後検証です。研究基準日当時のEvidenceとは別集計です。`,"スコアは確率ではありません。80点以上の優位性は仮定していません。","同一銘柄・方式・実験・期間の重複結果窓を除外。異なる期間間・銘柄間の相関は残ります。","少数標本または20銘柄未満は信頼性が低い集計です。","再下落は期間中に基準価格を上回った後、基準価格を下回ること。旧評価の未記録値は推定しません。","非候補比較は判定可能な全銘柄を母集団に固定し、候補と同じ期間・締切で評価する設計です。現在の非候補は予測原本がなく、成績は未記録です。"]});
}
