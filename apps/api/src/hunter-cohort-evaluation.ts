import type { Service } from "./service";
import { cohortBase,readCohort } from "./hunter-cohort";
import { cohortEvaluationSchema,type CohortEvaluation } from "../../../packages/core/hunter-cohort-schema";
import { targetDate,type Calendar,type Bar } from "../../../packages/core/index";
import { hash,ADJUSTMENT_VERSION } from "../../../packages/integrations/adjusted-series";
import { MarketIngestion } from "../../../packages/integrations/market-ingestion";
import { snapshot } from "./dejavu";
export function cohortEvaluationId(row:Omit<CohortEvaluation,"evaluationId">){const {evaluationId,evaluatedAt,evaluationCutoff,...body}=cohortEvaluationSchema.parse({...row,evaluationId:"0".repeat(64)});void evaluationId;void evaluatedAt;void evaluationCutoff;return hash(body);}
export function cohortPathOutcome(path:Bar[],asOf:string,target:string,calendar:Calendar,cutoff:string){
  const dates=calendar.filter(d=>d.open&&d.date>=asOf&&d.date<=target).map(d=>d.date).sort();
  const byDate=new Map(path.filter(b=>b.availableAt<=cutoff).map(b=>[b.sessionDate,b]));
  const rows=dates.map(d=>byDate.get(d));
  if(!dates.length||dates[0]!==asOf||dates.at(-1)!==target||rows.some(b=>!b?.adjClose||b.adjClose<=0)||new Set(rows.map(b=>b?.seriesId)).size!==1||!rows[0]?.seriesId)return null;
  const prices=rows.map(b=>b!.adjClose!),base=prices[0];let peak=base,drawdown=0,rise=0,rebounded=false,relapse=false;
  for(const p of prices){peak=Math.max(peak,p);drawdown=Math.min(drawdown,p/peak-1);rise=Math.max(rise,p/base-1);if(p>base)rebounded=true;if(rebounded&&p<base)relapse=true;}
  return {actualReturn:prices.at(-1)!/base-1,up:prices.at(-1)!>base,maxDrawdown:drawdown,maxRise:rise,relapse,inputRevisionIds:rows.map(b=>b!.revisionId),dataAvailableAt:rows.map(b=>b!.availableAt).sort().at(-1)!,basePrice:base,targetPrice:prices.at(-1)!};
}
export async function evaluateCohort(service:Service,id:string,now=new Date()){
  const {manifest,members}=await readCohort(service,id),cutoff=now.toISOString(),today=now.toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
  if(manifest.createdAt>cutoff)throw Error("作成前のコホートは評価できません");
  const calendar=await service.store.read<Calendar>("market/calendar.json",[]),results:CohortEvaluation[]=[];
  const series=new Map<string,Promise<Bar[]>>();
  const load=(code:string,target:string)=>{const key=`${code}/${target}`;let pending=series.get(key);if(!pending){pending=service.mode==="demo"?snapshot(service,code,cutoff):new MarketIngestion(service.store,null,manifest.plan).series(code,target,cutoff,manifest.asOf,undefined,false).then(s=>s.bars);series.set(key,pending);}return pending;};
  for(const member of members)for(const horizon of [1,5,20] as const){
    let target:string|null=null,status:CohortEvaluation["status"]="pending",reasons:string[]=[],outcome:ReturnType<typeof cohortPathOutcome>=null;
    try{target=manifest.targets[String(horizon) as "1"|"5"|"20"];if(!target||targetDate(calendar,manifest.asOf,horizon)!==target){target=null;reasons=["calendar-incomplete-or-revised"];}}catch{reasons=["calendar-incomplete"];}
    if(!member.eligible){status="excluded";reasons=member.exclusionReasons.length?member.exclusionReasons:["not-analyzable"];}
    else if(target&&target<=today){
      try{outcome=cohortPathOutcome(await load(member.code,target),manifest.asOf,target,calendar,cutoff);status=outcome?"evaluated":"missing";reasons=outcome?[]:["prices-unavailable-or-inconsistent"];}catch{status="missing";reasons=["prices-unavailable-or-inconsistent"];}
    }else if(target)reasons=["not-due"];
    const body={schemaVersion:1 as const,cohortId:id,code:member.code,horizon,target,status,reasons,actualReturn:null,up:null,maxDrawdown:null,maxRise:null,relapse:null,inputRevisionIds:[],dataAvailableAt:null,basePrice:null,targetPrice:null,...outcome,evaluatedAt:cutoff,evaluationCutoff:cutoff,adjustmentVersion:service.mode==="demo"?member.adjustmentVersion:ADJUSTMENT_VERSION};
    const row=cohortEvaluationSchema.parse({...body,evaluationId:cohortEvaluationId(body)}),key=`${cohortBase(id)}/evaluations/${member.code}/${horizon}/${row.evaluationId}.json`;
    const saved=await service.store.lock(async()=>{const old=await service.store.read(key,null);if(old){const parsed=cohortEvaluationSchema.parse(old);if(cohortEvaluationId(parsed)!==parsed.evaluationId)throw Error("評価hash不一致");return parsed;}await service.store.write(key,row,true);return row;});
    results.push(saved);
  }
  return {cohortId:id,evaluated:results.filter(r=>r.status==="evaluated").length,pending:results.filter(r=>r.status==="pending").length,missing:results.filter(r=>r.status==="missing").length,excluded:results.filter(r=>r.status==="excluded").length,evaluationIds:results.map(r=>r.evaluationId)};
}
export async function cohortEvaluations(service:Service,id:string,cutoff=new Date().toISOString()){
  const {members}=await readCohort(service,id),codes=new Set(members.map(m=>m.code)),rows:CohortEvaluation[]=[];
  for(const file of await service.store.files(`${cohortBase(id)}/evaluations`)){
    const row=cohortEvaluationSchema.parse(await service.store.read(file));
    if(row.cohortId!==id||!codes.has(row.code)||row.evaluationId!==cohortEvaluationId(row)||file!==`${cohortBase(id)}/evaluations/${row.code}/${row.horizon}/${row.evaluationId}.json`)throw Error("評価原本の照合に失敗しました");
    if(row.evaluatedAt<=cutoff&&row.evaluationCutoff<=cutoff&&(!row.dataAvailableAt||row.dataAvailableAt<=row.evaluationCutoff))rows.push(row);
  }
  return rows;
}
