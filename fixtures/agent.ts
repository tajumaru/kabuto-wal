import type { Service } from "../apps/api/src/service";
import { labFixture } from "./lab";
import { readCohort,cohortBase,cohortIdentity } from "../apps/api/src/hunter-cohort";
import { cohortEvaluations,cohortEvaluationId } from "../apps/api/src/hunter-cohort-evaluation";
import { cohortManifestSchema,cohortEvaluationSchema } from "../packages/core/hunter-cohort-schema";
import { createLabPlan } from "../apps/api/src/hunter-experiment-temporal";
import { hash } from "../packages/integrations/adjusted-series";
export async function agentFoldFixture(s:Service,foldCount=2,symbols=30,positiveValidation=true){
 const input=await labFixture(s,symbols,10,positiveValidation),source=await readCohort(s,input.cohortIds[0]),calendar=await s.store.read<{date:string;open:boolean}[]>("market/calendar.json");
 const dates=Array.from({length:365},(_,i)=>new Date(Date.UTC(2019,0,i+1)).toISOString().slice(0,10));await s.store.write("market/calendar.json",[...dates.map(date=>({date,open:true})),...calendar]);
 const asOf="2019-01-25",start=dates.indexOf(asOf),members=source.members.map(m=>({...m,inputRevisionIds:[`agent-fixture-2019-${m.code}`]})),{cohortId:unused,createdAt,...identity}=source.manifest;void unused;
 const base={...identity,asOf,cutoff:`${asOf}T14:59:59.999Z`,targets:{"1":dates[start+1],"5":dates[start+5],"20":dates[start+20]},shards:[{key:"members/00000.json",hash:hash(members),count:members.length}]},cohortId=cohortIdentity(base),manifest=cohortManifestSchema.parse({...base,cohortId,createdAt});await s.store.write(`${cohortBase(cohortId)}/members/00000.json`,members,true);await s.store.write(`${cohortBase(cohortId)}/manifest.json`,manifest,true);
 for(const old of await cohortEvaluations(s,source.manifest.cohortId)){const {evaluationId,...body}=old;void evaluationId;const row=cohortEvaluationSchema.parse({...body,cohortId,target:base.targets[String(body.horizon) as "1"|"5"|"20"],inputRevisionIds:[`agent-fixture-2019-outcome-${body.code}-${body.horizon}`],evaluationId:"0".repeat(64)});row.evaluationId=cohortEvaluationId(row);await s.store.write(`${cohortBase(cohortId)}/evaluations/${row.code}/${row.horizon}/${row.evaluationId}.json`,row,true);}
 const all=[];for(const id of input.cohortIds)all.push((await readCohort(s,id)).manifest);all.sort((a,b)=>a.asOf.localeCompare(b.asOf));const validation=all.slice(0,20),test=all.slice(20),foldPlanIds=[];
 for(let i=0;i<foldCount;i++){const selected=validation.slice(Math.floor(i*20/foldCount),Math.floor((i+1)*20/foldCount)),first=selected[0].asOf,last=selected.at(-1)!.targets["20"]!,trainingTo=new Date(Date.parse(`${first}T00:00:00.000Z`)-86400000).toISOString().slice(0,10),p=await createLabPlan(s,{cohortIds:[cohortId,...validation.filter(c=>c.asOf<first).map(c=>c.cohortId),...selected.map(c=>c.cohortId),...test.map(c=>c.cohortId)],training:{from:asOf,to:trainingTo},validation:{from:first,to:last},test:{from:"2022-01-01",to:"2022-12-31"},embargoSessions:0});foldPlanIds.push(p.planId);}
 return {foldPlanIds,cohortIds:[cohortId,...all.map(c=>c.cohortId)]};
}
