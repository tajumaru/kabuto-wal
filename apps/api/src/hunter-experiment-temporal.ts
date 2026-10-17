import { z } from "zod";
import type { Service } from "./service";
import type { Calendar } from "../../../packages/core/index";
import { labPlanInputSchema,labPlanSchema,type LabPlan } from "../../../packages/core/hunter-experiment-schema";
import { cohortIdSchema,type CohortManifest } from "../../../packages/core/hunter-cohort-schema";
import { readCohort } from "./hunter-cohort";
import { cohortEvaluations } from "./hunter-cohort-evaluation";
import { hash } from "../../../packages/integrations/adjusted-series";
import { labBase,readLabPlan,readLabMethod } from "./hunter-experiment";
export function temporalPartition(c:CohortManifest,p:z.infer<typeof labPlanInputSchema>,calendar:Calendar){
  const phase=(["training","validation","test"] as const).find(k=>c.asOf>=p[k].from&&c.asOf<=p[k].to);
  if(!phase)return {partition:"purged" as const,reason:"outside-periods"};
  if(c.cutoff>`${c.asOf}T14:59:59.999Z`)return {partition:"purged" as const,reason:"features-not-known-at-decision"};
  const end=c.targets["20"],boundary=phase==="training"?p.validation.from:phase==="validation"?p.test.from:null;
  if(!end||end>p[phase].to||(boundary&&end>=boundary))return {partition:"purged" as const,reason:"outcome-crosses-split-or-incomplete-calendar"};
  const previous=phase==="validation"?p.training.to:phase==="test"?p.validation.to:null;
  if(previous&&calendar.filter(d=>d.open&&d.date>previous&&d.date<=c.asOf).length<=p.embargoSessions)return {partition:"purged" as const,reason:"embargo"};
  return {partition:phase,reason:""};
}
const exposureSchema=z.object({planId:cohortIdSchema,experimentId:cohortIdSchema,mode:z.string(),from:z.string().date(),to:z.string().date(),createdAt:z.string().datetime()}).strict();
export async function createLabPlan(s:Service,raw:unknown,now=new Date()){
  const q=labPlanInputSchema.parse(raw),calendar=await s.store.read<Calendar>("market/calendar.json",[]);
  if(!calendar.length||new Set(calendar.map(d=>d.date)).size!==calendar.length)throw Error("整合した営業日カレンダーが必要です");
  const partitions:LabPlan["partitions"]={},purgeReasons:Record<string,string>={},cohortHashes:Record<string,string>={},evaluationIds:string[]=[],versions=new Set<string>();
  const ids=[...new Set(q.cohortIds)].sort();
  for(const id of ids){const {manifest:c}=await readCohort(s,id);if(c.createdAt>now.toISOString()||c.cutoff>now.toISOString())throw Error("未来の入力です");versions.add(JSON.stringify([c.mode,c.experiment,c.methodVersion,c.scoringVersions,c.plan,c.delayDays]));cohortHashes[id]=hash(c);const part=temporalPartition(c,q,calendar);partitions[id]=part.partition;if(part.reason)purgeReasons[id]=part.reason;for(const e of await cohortEvaluations(s,id,now.toISOString()))evaluationIds.push(e.evaluationId);}
  if(versions.size!==1)throw Error("区分・現行方式・プランが一致するコホートだけを比較できます");
  if((["training","validation","test"] as const).some(k=>!Object.values(partitions).includes(k)))throw Error("purge・embargo後の各区間にコホートが必要です。期間を広げてください");
  const mode=s.mode==="demo"?"demo":"research";
  // Previously displayed notebook outcomes are not a pristine holdout.
  const notes=await s.store.files("research/notebooks");
  for(const file of notes.filter(f=>f.endsWith("/original.json"))){const n=await s.store.read<{mode:string;period:{from:string;to:string};evidence:{sampleCount:number}[]}>(file);if(n.mode===mode&&n.period.from<=q.test.to&&n.period.to>=q.test.from&&n.evidence.some(e=>e.sampleCount>0))throw Error("既存研究ノートで評価済みの期間を未使用Testに指定できません");}
  const body={...q,cohortIds:ids,mode,createdAt:now.toISOString(),evaluationCutoff:now.toISOString(),cohortHashes,calendarHash:hash(calendar),partitions,purgeReasons,evaluationIds:[...new Set(evaluationIds)].sort(),methodVersion:"temporal-lab-v1" as const},plan=labPlanSchema.parse({...body,planId:hash(body)});
  return s.store.lock(async()=>{for(const raw of await s.store.all(`${labBase}/exposures`)){const e=exposureSchema.parse(raw);if(e.mode===mode&&e.from<=q.test.to&&e.to>=q.test.from)throw Error("開封済みTest期間は別計画の未使用Testに再利用できません");}await s.store.write(`${labBase}/plans/${plan.planId}/original.json`,plan,true);return plan;});
}
export async function verifyLabPlanInputs(s:Service,id:string){const p=await readLabPlan(s,id);for(const c of p.cohortIds)if(hash((await readCohort(s,c)).manifest)!==p.cohortHashes[c])throw Error("固定入力の変更を検出しました");return p;}
export async function selectLabMethod(s:Service,planId:string,experimentId:string,confirm:boolean){if(!confirm)throw Error("方式選択の明示確認が必要です");const p=await verifyLabPlanInputs(s,planId),m=await readLabMethod(s,experimentId);
  return s.store.lock(async()=>{const files=await s.store.files(`${labBase}/methods/${experimentId}/validation`);let found=false;for(const f of files){const receipt=await s.store.read<{planId:string;sufficient:boolean}>(f);if(receipt.planId===p.planId&&receipt.sufficient)found=true;}if(!found)throw Error("同一計画の十分なValidationが必要です");
    if(m.createdAt>new Date().toISOString())throw Error("未来の方式です");const key=`${labBase}/plans/${planId}/selection/original.json`,old=await s.store.read(key,null);if(old){if(old.experimentId!==experimentId)throw Error("Test方式は既に固定されています");return old;}const row={planId,experimentId,createdAt:new Date().toISOString(),rollback:"本番切替なし。採用候補をrejectedにする追記で撤回する。"};await s.store.write(key,row,true);return row;});
}
// Must run under the writer lock, before a Test worker reads any outcomes.
export async function openLabTest(s:Service,p:LabPlan,experimentId:string){const selection=await s.store.read<{experimentId:string}>(`${labBase}/plans/${p.planId}/selection/original.json`,null);if(selection?.experimentId!==experimentId)throw Error("最終Testは方式選択完了まで封印されています");const key=`${labBase}/exposures/${p.planId}/original.json`,old=await s.store.read(key,null);if(old){if(old.experimentId!==experimentId)throw Error("Test開封方式が違います");return;}for(const raw of await s.store.all(`${labBase}/exposures`)){const e=exposureSchema.parse(raw);if(e.mode===p.mode&&e.from<=p.test.to&&e.to>=p.test.from)throw Error("Test期間が既に開封されています");}await s.store.write(key,{planId:p.planId,experimentId,mode:p.mode,...p.test,createdAt:new Date().toISOString()},true);}
