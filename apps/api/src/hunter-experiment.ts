import type { Service } from "./service";
import { hash } from "../../../packages/integrations/adjusted-series";
import { labMethodSchema,labMethodInputSchema,labStateSchema,labPlanSchema,LAB_METHOD,type LabMethod } from "../../../packages/core/hunter-experiment-schema";
import { cohortIdSchema } from "../../../packages/core/hunter-cohort-schema";
import { z } from "zod";
export const labBase="research/lab";
export async function readLabPlan(s:Service,id:string){const p=labPlanSchema.parse(await s.store.read(`${labBase}/plans/${cohortIdSchema.parse(id)}/original.json`)),{planId,...body}=p;if(planId!==id||hash(body)!==id||p.mode!==(s.mode==="demo"?"demo":"research"))throw Error("検証計画hash・区分不一致");return p;}
export const methodKey=(id:string)=>`${labBase}/methods/${cohortIdSchema.parse(id)}/original.json`;
export function labMethodIdentity(m:LabMethod){const {experimentId,createdAt,...body}=labMethodSchema.parse(m);void experimentId;void createdAt;return hash(body);}
export async function readLabMethod(s:Service,id:string){const m=labMethodSchema.parse(await s.store.read(methodKey(id)));if(m.experimentId!==id||labMethodIdentity(m)!==id)throw Error("実験方式hash不一致");return m;}
export async function createLabMethod(s:Service,raw:unknown,now=new Date()){
  const m=labMethodSchema.parse({...labMethodInputSchema.parse(raw),schemaVersion:1,experimentId:"0".repeat(64),parentMethodVersion:"bottom-rule-v1",featureVersion:"bottom-80-v1",methodVersion:LAB_METHOD,createdAt:now.toISOString()});m.experimentId=labMethodIdentity(m);
  if(m.proposalId){const {readLabProposal}=await import("./hunter-experiment-hypotheses"),p=await readLabProposal(s,m.proposalId);if(JSON.stringify(m.parameters)!==JSON.stringify(p.proposal.parameters)||m.candidateThreshold!==p.proposal.candidateThreshold||JSON.stringify(m.evidenceIds)!==JSON.stringify(p.proposal.evidenceIds))throw Error("提案の設定・根拠を変更する場合は独立した新方式を作成してください");}
  return s.store.lock(async()=>{const old=await s.store.read(methodKey(m.experimentId),null);if(old)return readLabMethod(s,m.experimentId);await s.store.write(methodKey(m.experimentId),m,true);return m;});
}
const eventSchema=z.object({eventId:cohortIdSchema,experimentId:cohortIdSchema,previous:cohortIdSchema.nullable(),status:labStateSchema,createdAt:z.string().datetime(),reason:z.string().min(1).max(1000)}).strict();
export async function labEvents(s:Service,id:string){await readLabMethod(s,id);const rows=(await s.store.all(`${labBase}/methods/${id}/events`)).map(r=>eventSchema.parse(r));const sorted:typeof rows=[];let previous:string|null=null;while(sorted.length<rows.length){const next=rows.filter(r=>r.previous===previous);if(next.length!==1)throw Error("実験状態履歴が分岐・破損しています");const e=next[0],{eventId,...body}=e;if(e.experimentId!==id||hash(body)!==eventId)throw Error("状態履歴hash不一致");sorted.push(e);previous=e.eventId;}return sorted;}
export async function changeLabState(s:Service,id:string,raw:unknown){const q=z.object({status:labStateSchema,reason:z.string().min(1).max(1000),confirm:z.literal(true)}).strict().parse(raw);return s.store.lock(async()=>{const events=await labEvents(s,id),last=events.at(-1),current=last?.status??"draft";
  const allowed:Record<string,string[]>={draft:["testing","rejected"],testing:["validated","rejected"],validated:["proposed-for-adoption","rejected"],rejected:[],"proposed-for-adoption":["rejected"]};if(!allowed[current].includes(q.status))throw Error("許可されない状態遷移");
  if(q.status==="validated"){const receipts=await s.store.all(`${labBase}/methods/${id}/validation`);if(!receipts.some(r=>r.sufficient===true))throw Error("十分なValidation完了レポートが必要です");}
  const body={experimentId:id,previous:last?.eventId??null,status:q.status,createdAt:new Date().toISOString(),reason:q.reason},event={...body,eventId:hash(body)};await s.store.write(`${labBase}/methods/${id}/events/${event.eventId}.json`,event,true);return event;});}
