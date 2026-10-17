import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Service } from "./service";
export const researchCheckpointSchema=z.object({runId:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["queued","running","paused","cancelled","failed","completed"]),processed:z.number().int().nonnegative(),total:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),error:z.string().optional(),lease:z.object({token:z.string().uuid(),pid:z.number(),expiresAt:z.number()}).optional()}).passthrough();
export type ResearchCheckpoint=z.infer<typeof researchCheckpointSchema>;
function alive(l:ResearchCheckpoint["lease"]){if(!l||l.expiresAt<Date.now())return false;try{process.kill(l.pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=="ESRCH";}}
export async function controlResearchJob(s:Service,key:string,action:"pause"|"cancel"|"resume"){
  return s.store.lock(async()=>{const j=researchCheckpointSchema.parse(await s.store.read(key));if(j.status==="completed")return j;
    if(action==="resume"){if(alive(j.lease))throw Error("workerの停止を待ってください");j.status="queued";delete j.lease;delete j.error;}else j.status=action==="pause"?"paused":"cancelled";
    await s.store.write(key,j);return j;});
}
// The existing Store lock serializes leases across processes; no server/queue is added.
export async function runResearchJob(s:Service,key:string,unit:(index:number)=>Promise<void>,maxUnits=Infinity){
  const activeKey="research/lab/active-worker.json",token=randomUUID();
  let job=await s.store.lock(async()=>{const j=researchCheckpointSchema.parse(await s.store.read(key));if(j.status==="completed")return j;if(["paused","cancelled"].includes(j.status))throw Error("再開操作が必要です");
    const a=await s.store.read<{key:string;lease:ResearchCheckpoint["lease"]}|null>(activeKey,null);if(alive(j.lease)||a&&alive(a.lease))throw Error("研究・評価workerが既に実行中です");
    j.status="running";j.lease={token,pid:process.pid,expiresAt:Date.now()+30*60*1000};delete j.error;await s.store.write(key,j);await s.store.write(activeKey,{key,lease:j.lease});return j;});
  if(job.status==="completed")return job;
  let units=0;
  try{while(job.processed<job.total&&units<maxUnits){
    const current=researchCheckpointSchema.parse(await s.store.read(key));if(current.lease?.token!==token)throw Error("workerの所有権が変更されました");if(current.status!=="running"){job=current;break;}
    await unit(current.processed);
    job=await s.store.lock(async()=>{const j=researchCheckpointSchema.parse(await s.store.read(key));if(j.lease?.token!==token)throw Error("workerの所有権不一致");j.processed++;j.lease.expiresAt=Date.now()+30*60*1000;await s.store.write(key,j);await s.store.write(activeKey,{key,lease:j.lease});return j;});units++;
  }}catch(e){await s.store.lock(async()=>{const j=researchCheckpointSchema.parse(await s.store.read(key));if(j.lease?.token===token){j.status="failed";j.failed++;j.error=e instanceof Error?e.message:"計算失敗";await s.store.write(key,j);}return j;});}
  return s.store.lock(async()=>{const j=researchCheckpointSchema.parse(await s.store.read(key));if(j.lease?.token!==token)return j;if(j.status==="running")j.status=j.processed===j.total?"completed":"paused";delete j.lease;await s.store.write(key,j);const a=await s.store.read<{lease?:{token:string}}>(activeKey,{});if(a.lease?.token===token)await s.store.write(activeKey,{released:true});return j;});
}
