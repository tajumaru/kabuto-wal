import type { Service } from "./service";
import { z } from "zod";
import { cohortBase,readCohort } from "./hunter-cohort";
import { cohortEvaluationSchema,type CohortEvaluation,type CohortManifest,type CohortMember } from "../../../packages/core/hunter-cohort-schema";
import { targetDate,type Calendar,type Bar } from "../../../packages/core/index";
import { hash,ADJUSTMENT_VERSION } from "../../../packages/integrations/adjusted-series";
import { MarketIngestion } from "../../../packages/integrations/market-ingestion";
import { snapshot } from "./dejavu";
export function cohortEvaluationId(row:Omit<CohortEvaluation,"evaluationId">){const {evaluationId,evaluatedAt,evaluationCutoff,...body}=cohortEvaluationSchema.parse({...row,evaluationId:"0".repeat(64)});void evaluationId;void evaluatedAt;void evaluationCutoff;return hash(body);}
export function cohortPathOutcome(path:Bar[],asOf:string,target:string,calendar:Calendar,cutoff:string){
  const dates=calendar.filter(d=>d.open&&d.date>=asOf&&d.date<=target).map(d=>d.date).sort();
  if(!z.string().datetime({offset:true}).safeParse(cutoff).success)return null;
  // availableAt is MarketIngestion's observedAt. Select the latest known
  // observation per session; equal instants must describe identical bars.
  // A revision ID is evidence, never an arbitrary tie breaker.
  const byDate=new Map<string,Bar>(),ambiguous=new Set<string>();
  const identity=(b:Bar)=>Object.fromEntries(Object.entries({...b,availableAt:new Date(b.availableAt).toISOString()}).sort(([a],[c])=>a.localeCompare(c)));
  for(const b of path){
    if(!dates.includes(b.sessionDate)||!z.string().datetime({offset:true}).safeParse(b.availableAt).success||Date.parse(b.availableAt)>Date.parse(cutoff))continue;
    const old=byDate.get(b.sessionDate),time=Date.parse(b.availableAt),previous=old?Date.parse(old.availableAt):-Infinity;
    if(time>previous){byDate.set(b.sessionDate,b);ambiguous.delete(b.sessionDate);}
    else if(time===previous&&hash(identity(b))!==hash(identity(old!)))ambiguous.add(b.sessionDate);
  }
  const rows=dates.map(d=>byDate.get(d));
  if(ambiguous.size||!dates.length||new Set(dates).size!==dates.length||dates[0]!==asOf||dates.at(-1)!==target||rows.some(b=>!b||!Number.isFinite(b.adjClose)||b.adjClose!<=0||typeof b.revisionId!=="string"||!b.revisionId.trim()||typeof b.seriesId!=="string"||!b.seriesId.trim())||new Set(rows.map(b=>b?.seriesId)).size!==1||new Set(rows.map(b=>b?.providerCode)).size!==1)return null;
  const prices=rows.map(b=>b!.adjClose!),base=prices[0];let peak=base,drawdown=0,rise=0,rebounded=false,relapse=false;
  for(const p of prices){peak=Math.max(peak,p);drawdown=Math.min(drawdown,p/peak-1);rise=Math.max(rise,p/base-1);if(p>base)rebounded=true;if(rebounded&&p<base)relapse=true;}
  return {actualReturn:prices.at(-1)!/base-1,up:prices.at(-1)!>base,maxDrawdown:drawdown,maxRise:rise,relapse,inputRevisionIds:rows.map(b=>b!.revisionId),dataAvailableAt:new Date(Math.max(...rows.map(b=>Date.parse(b!.availableAt)))).toISOString(),basePrice:base,targetPrice:prices.at(-1)!};
}
export async function evaluateCohort(service:Service,id:string,now=new Date()){
  const {manifest,members}=await readCohort(service,id);return evaluateCohortMembers(service,manifest,members,now);
}
export async function evaluateCohortMembers(service:Service,manifest:CohortManifest,members:CohortMember[],now=new Date(),frozenCalendar?:Calendar){
  const id=manifest.cohortId,cutoff=now.toISOString(),today=now.toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
  if(manifest.createdAt>cutoff)throw Error("作成前のコホートは評価できません");
  const calendar=frozenCalendar??await service.store.read<Calendar>("market/calendar.json",[]),results:CohortEvaluation[]=[];
  if(new Set(calendar.map(d=>d.date)).size!==calendar.length)throw Error("営業日カレンダーが重複しています");
  const series=new Map<string,Promise<Bar[]>>();
  const latestDue=Object.values(manifest.targets).filter((d):d is string=>!!d&&d<=today).sort().at(-1);
  const load=(code:string,target:string)=>{const end=latestDue??target,key=`${code}/${end}`;let pending=series.get(key);if(!pending){pending=service.mode==="demo"?snapshot(service,code,cutoff):new MarketIngestion(service.store,null,manifest.plan).series(code,end,cutoff,manifest.asOf,undefined,false).then(s=>s.bars);series.set(key,pending);}return pending;};
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
  const {manifest,members}=await readCohort(service,id),codes=new Map(members.map(m=>[m.code,m])),rows:CohortEvaluation[]=[];
  const files=await service.store.files(`${cohortBase(id)}/evaluations`);
  for(let offset=0;offset<files.length;offset+=16){
   const batch=await Promise.all(files.slice(offset,offset+16).map(async file=>({file,row:cohortEvaluationSchema.parse(await service.store.read(file))})));
   for(const {file,row} of batch){
    if(row.cohortId!==id||!codes.has(row.code)||row.evaluationId!==cohortEvaluationId(row)||file!==`${cohortBase(id)}/evaluations/${row.code}/${row.horizon}/${row.evaluationId}.json`)throw Error("評価原本の照合に失敗しました");
    if((row.target&&row.target!==manifest.targets[String(row.horizon) as "1"|"5"|"20"])||(row.status==="evaluated"&&(!codes.get(row.code)!.eligible||row.target!>new Date(row.evaluationCutoff).toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"}))))throw Error("評価の営業日・対象群が一致しません");
    if(row.evaluatedAt<=cutoff&&row.evaluationCutoff<=cutoff&&(!row.dataAvailableAt||row.dataAvailableAt<=row.evaluationCutoff))rows.push(row);
   }
  }
  return rows;
}
