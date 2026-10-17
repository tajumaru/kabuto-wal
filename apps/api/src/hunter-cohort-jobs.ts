import type { Service } from "./service";
import { z } from "zod";
import { cohortIdSchema } from "../../../packages/core/hunter-cohort-schema";
import { cohortEvaluationJobSchema } from "../../../packages/core/cohort-evaluation-job-schema";
import { readCohort,cohortBase } from "./hunter-cohort";
import { evaluateCohortMembers } from "./hunter-cohort-evaluation";
import { runResearchJob,controlResearchJob } from "./research-json-worker";
import { hash } from "../../../packages/integrations/adjusted-series";
import type { Calendar } from "../../../packages/core/index";
const base="research/lab/cohort-jobs";
export const cohortJobKey=(id:string)=>`${base}/${cohortIdSchema.parse(id)}/checkpoint.json`;
const partSchema=z.object({index:z.number().int(),inputHash:cohortIdSchema,cohortId:cohortIdSchema,evaluated:z.number(),pending:z.number(),missing:z.number(),excluded:z.number(),evaluationIds:z.array(cohortIdSchema),contentHash:cohortIdSchema}).strict();
export async function readCohortJob(s:Service,id:string){const j=cohortEvaluationJobSchema.parse(await s.store.read(cohortJobKey(id)));if(j.runId!==id||hash(["cohort-evaluation-job-v1",j.cohortId,j.manifestHash,j.calendarHash,j.evaluationCutoff,j.batchSize])!==id)throw Error("評価ジョブ入力hash不一致");return j;}
export async function createCohortJob(s:Service,cohortId:string,now=new Date()){
 const {manifest}=await readCohort(s,cohortId),calendar=await s.store.read("market/calendar.json",[]),manifestHash=hash(manifest),calendarHash=hash(calendar),cutoff=now.toISOString();if(manifest.createdAt>cutoff)throw Error("作成前のコホートです");
 return s.store.lock(async()=>{const latest=await s.store.read<{runId:string}|null>(`${cohortBase(cohortId)}/evaluation-job-index.json`,null);if(latest){const old=await readCohortJob(s,latest.runId);if(["queued","running","paused"].includes(old.status)){if(old.manifestHash!==manifestHash||old.calendarHash!==calendarHash)throw Error("評価ジョブ入力の変更を検出しました");return old;}}
 const runId=hash(["cohort-evaluation-job-v1",cohortId,manifestHash,calendarHash,cutoff,25]),job=cohortEvaluationJobSchema.parse({runId,cohortId,manifestHash,calendarHash,evaluationCutoff:cutoff,batchSize:25,symbolTotal:manifest.memberCount,status:"queued",processed:0,total:Math.ceil(manifest.memberCount/25),failed:0});await s.store.write(`${base}/${runId}/calendar/original.json`,calendar,true);await s.store.write(cohortJobKey(runId),job,true);await s.store.write(`${cohortBase(cohortId)}/evaluation-job-index.json`,{runId});return job;});
}
export async function runCohortJob(s:Service,id:string,maxUnits=Infinity){
 const job=await readCohortJob(s,id),{manifest,members}=await readCohort(s,job.cohortId),calendar=await s.store.read<Calendar>(`${base}/${id}/calendar/original.json`);if(hash(manifest)!==job.manifestHash||hash(calendar)!==job.calendarHash||hash(await s.store.read("market/calendar.json",[]))!==job.calendarHash)throw Error("評価再開時のmanifest・calendarが変化しました");
 return runResearchJob(s,cohortJobKey(id),async index=>{const key=`${base}/${id}/parts/${String(index).padStart(5,"0")}.json`,inputHash=hash([job.runId,job.manifestHash,job.calendarHash,job.evaluationCutoff]),old=await s.store.read(key,null);
 if(old){const p=partSchema.parse(old),{contentHash,...body}=p;if(p.index!==index||p.inputHash!==inputHash||p.cohortId!==job.cohortId||hash(body)!==contentHash)throw Error("評価checkpoint破損");return;}
 const result=await evaluateCohortMembers(s,manifest,members.slice(index*25,(index+1)*25),new Date(job.evaluationCutoff),calendar),p=partSchema.parse({...result,index,inputHash,contentHash:"0".repeat(64)}),{contentHash:placeholder,...body}=p;void placeholder;p.contentHash=hash(body);
 await s.store.lock(async()=>{if(!await s.store.read(key,null))await s.store.write(key,p,true);});
 },maxUnits);
}
export async function controlCohortJob(s:Service,id:string,action:"pause"|"cancel"|"resume"){await readCohortJob(s,id);return controlResearchJob(s,cohortJobKey(id),action);}
export async function cohortJobProgress(s:Service,id:string){const job=await readCohortJob(s,id),counts={evaluated:0,pending:0,missing:0,excluded:0};for(let i=0;i<job.processed;i++){const part=partSchema.parse(await s.store.read(`${base}/${id}/parts/${String(i).padStart(5,"0")}.json`)),{contentHash,...body}=part;if(hash(body)!==contentHash||part.index!==i||part.cohortId!==job.cohortId)throw Error("進捗checkpoint破損");for(const k of ["evaluated","pending","missing","excluded"] as const)counts[k]+=part[k];}return {job,completedSymbols:Math.min(job.symbolTotal,job.processed*25),...counts};}
