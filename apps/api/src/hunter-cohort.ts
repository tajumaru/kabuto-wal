import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { cohortInputSchema,cohortManifestSchema,cohortMemberSchema,cohortIdSchema,COHORT_METHOD,type CohortManifest,type CohortMember } from "../../../packages/core/hunter-cohort-schema";
import { hunterUniverseSchema,hunterCoverageSchema } from "../../../packages/core/hunter-schema";
import { HunterJobs } from "./hunter-jobs";
import { readHunterDetail } from "./hunter-consistency";
import { hash } from "../../../packages/integrations/adjusted-series";
import { planCapabilities } from "../../../packages/integrations/jquants-plan";
import { evaluateCohort,cohortEvaluations } from "./hunter-cohort-evaluation";
export const cohortBase=(id:string)=>`market/hunter/cohorts/${cohortIdSchema.parse(id)}`;
export function cohortIdentity(m:Omit<CohortManifest,"cohortId"|"createdAt">){return hash(m);}
export async function readCohort(service:Service,id:string){
  const base=cohortBase(id),manifest=cohortManifestSchema.parse(await service.store.read(`${base}/manifest.json`));
  const {cohortId,createdAt,...identity}=manifest;void createdAt;
  if(cohortId!==id||cohortIdentity(identity)!==id||manifest.mode!==(service.mode==="demo"?"demo":"research"))throw Error("コホートの識別情報不一致");
  const members:CohortMember[]=[];
  for(const shard of manifest.shards){const rows=z.array(cohortMemberSchema).max(200).parse(await service.store.read(`${base}/${shard.key}`));if(hash(rows)!==shard.hash||rows.length!==shard.count)throw Error("コホート内容hash不一致");members.push(...rows);}
  if(members.length!==manifest.memberCount||new Set(members.map(m=>m.code)).size!==members.length)throw Error("コホートの件数・銘柄不一致");
  return {manifest,members};
}
export async function createCohort(service:Service,raw:unknown,now=new Date()){
  const input=cohortInputSchema.parse(raw),engine=new HunterJobs(service),job=await engine.get(input.jobId),today=now.toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
  if(job.status!=="completed"||job.cancelRequested||job.processed!==job.total||!job.datasetId||!job.analysisId||!job.universeId)throw Error("完了済みの整合したジョブが必要です");
  if(job.input.asOf>today||job.cutoff>now.toISOString()||job.mode!==(service.mode==="demo"?"demo":"research"))throw Error("コホートの時点・区分不一致");
  if(input.experiment==="prospective"&&(job.input.asOf!==today||job.createdAt.slice(0,10)!==now.toISOString().slice(0,10)))throw Error("過去研究を事前記録として保存できません");
  if(input.experiment==="walk-forward"&&job.cutoff>`${job.input.asOf}T14:59:59.999Z`)throw Error("walk-forwardの取得締切は当日までです");
  const universe=hunterUniverseSchema.parse(await service.store.read(`market/hunter/universe/${job.universeId}.json`));
  if(universe.id!==job.universeId||universe.asOf!==job.input.asOf||universe.cutoff!==job.cutoff||universe.mode!==job.mode)throw Error("ユニバース不一致");
  const members:CohortMember[]=[];
  for(const u of [...universe.entries].sort((a,b)=>a.code.localeCompare(b.code))){
    if(!u.included){members.push(cohortMemberSchema.parse({code:u.code,score:null,candidate:false,classification:"判定不能",referencePrice:null,inputRevisionIds:[],eligible:false,exclusionReasons:u.reasons,conditions:[],risks:[],indicators:{},adjustmentVersion:null}));continue;}
    const {row,analysis:a}=await readHunterDetail(service,job,u.code);
    const price=a.chart.find(b=>b.sessionDate===job.input.asOf)?.close??null;
    const known=!!a.observedAt&&a.observedAt<=job.cutoff&&a.dataAsOf===job.input.asOf&&a.inputRevisionIds.length>0;
    const eligible=known&&a.status==="ready"&&a.score!==null&&row.acquisitionStatus==="ready"&&!!price&&price>0;
    members.push(cohortMemberSchema.parse({code:u.code,score:a.score,candidate:row.candidate,classification:row.category,referencePrice:price,inputRevisionIds:a.inputRevisionIds,eligible,
      exclusionReasons:eligible?[]:[...a.reasonCodes,...(!known?["unknown-at-cutoff"]:[]),...(!price?["missing-reference"]:[])],conditions:a.conditions.filter(c=>c.met).map(c=>c.code),risks:a.riskCodes,indicators:a.indicators??{},adjustmentVersion:a.adjustmentVersion??null}));
  }
  const coverage=hunterCoverageSchema.parse(await service.store.read(`market/hunter/coverage/${job.id}.json`));
  if(coverage.jobId!==job.id||coverage.cutoff!==job.cutoff||coverage.asOf!==job.input.asOf||coverage.processedCount!==job.total)throw Error("取得範囲とジョブの不一致");
  const plan=service.mode==="demo"?"fixture":(coverage.plan??process.env.JQUANTS_PLAN??"Free"),shards:CohortManifest["shards"]=[];
  for(let i=0;i<members.length;i+=200){const rows=members.slice(i,i+200);shards.push({key:`members/${String(i/200).padStart(5,"0")}.json`,hash:hash(rows),count:rows.length});}
  const identity:Omit<CohortManifest,"cohortId"|"createdAt">={schemaVersion:1 as const,jobId:job.id,datasetId:job.datasetId,analysisId:job.analysisId,asOf:job.input.asOf,cutoff:job.cutoff,methodVersion:job.methodVersion,cohortMethod:COHORT_METHOD,universeId:job.universeId,mode:job.mode,experiment:input.experiment,plan,delayDays:plan==="fixture"?0:planCapabilities(plan).delayDays,memberCount:members.length,shards};
  const id=cohortIdentity(identity),base=cohortBase(id);
  return service.store.lock(async()=>{
    const current=await engine.get(job.id);if(current.status!=="completed"||current.analysisId!==job.analysisId||current.cancelRequested)throw Error("保存前にジョブが変化しました");
    if(await service.store.read(`${base}/manifest.json`,null))return (await readCohort(service,id)).manifest;
    for(let i=0;i<shards.length;i++){const key=`${base}/${shards[i].key}`,rows=members.slice(i*200,(i+1)*200),old=await service.store.read(key,null);if(old&&hash(old)!==shards[i].hash)throw Error("中断コホートの内容不一致");if(!old)await service.store.write(key,rows,true);}
    const manifest=cohortManifestSchema.parse({...identity,cohortId:id,createdAt:now.toISOString()});await service.store.write(`${base}/manifest.json`,manifest,true);return manifest;
  });
}
export function registerHunterCohorts(app:FastifyInstance,service:Service){
  app.post("/api/bottom/hunter/cohorts/:id/evaluate",async req=>{const {id}=z.object({id:cohortIdSchema}).parse(req.params);return evaluateCohort(service,id);});
  app.get("/api/bottom/hunter/cohorts/:id/evaluations",async req=>{const {id}=z.object({id:cohortIdSchema}).parse(req.params);const q=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).parse(req.query);const rows=await cohortEvaluations(service,id);return {records:rows.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:rows.length,...q};});
  app.post("/api/bottom/hunter/cohorts",async req=>createCohort(service,req.body));
  app.get("/api/bottom/hunter/cohorts",async req=>{
    const q=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).parse(req.query);
    const files=(await service.store.files("market/hunter/cohorts")).filter(f=>f.endsWith("/manifest.json")).sort().reverse();
    const records=await Promise.all(files.slice((q.page-1)*q.pageSize,q.page*q.pageSize).map(f=>service.store.read(f).then(r=>cohortManifestSchema.parse(r))));return {records,total:files.length,...q};
  });
  app.get("/api/bottom/hunter/cohorts/:id",async req=>{const {id}=z.object({id:cohortIdSchema}).parse(req.params);return readCohort(service,id);});
}
