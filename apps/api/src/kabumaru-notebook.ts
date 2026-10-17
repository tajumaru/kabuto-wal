import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { notebookInputSchema,notebookOriginalSchema,notebookEvidenceSchema,type NotebookOriginal } from "../../../packages/core/kabumaru-notebook-schema";
import { cohortIdSchema } from "../../../packages/core/hunter-cohort-schema";
import { hash } from "../../../packages/integrations/adjusted-series";
import { cohortObservations,comparativeCohortReport } from "./hunter-cohort-report";
import { notebookInsights,notebookPattern,notebookEvidenceId } from "./kabumaru-notebook-insights";
import { saveNotebookMemory,syncNotebookMemory,recallNotebookMemory } from "./kabumaru-notebook-memory";
import { notebookAnswer } from "./kabumaru-notebook-answer";
export const notebookBase=(id:string)=>`research/notebooks/${cohortIdSchema.parse(id)}`;
export function notebookIdentity(note:NotebookOriginal){const {notebookId,...body}=notebookOriginalSchema.parse(note);void notebookId;return hash(body);}
export async function readNotebook(service:Service,id:string){
  const note=notebookOriginalSchema.parse(await service.store.read(`${notebookBase(id)}/original.json`));
  if(note.notebookId!==id||notebookIdentity(note)!==id||note.mode!==(service.mode==="demo"?"demo":"research"))throw Error("研究ノートの識別情報不一致");
  const rows=await cohortObservations(service,note.cohortIds,note.createdAt),report=comparativeCohortReport(rows.filter(r=>notebookPattern(note.theme,r)),note.cohortIds,new Date(note.report.generatedAt));
  if(JSON.stringify(report)!==JSON.stringify(note.report))throw Error("研究ノートとコホート・評価原本が一致しません");
  for(const e of note.evidence){const {evidenceId,...body}=e;if(notebookEvidenceId(body)!==evidenceId||e.reportId!==report.reportId||!report.groups.some(g=>g.key===e.groupKey&&g.candidate.evaluated+g.control.evaluated===e.sampleCount))throw Error("研究Evidence不一致");}
  return note;
}
export async function createNotebook(service:Service,raw:unknown,now=new Date()){
  const input=notebookInputSchema.parse(raw),ids=[...new Set(input.cohortIds)].sort(),rows=await cohortObservations(service,ids,now.toISOString());
  if(!rows.length)throw Error("利用可能なコホートがありません");
  const selected=rows.filter(r=>notebookPattern(input.theme,r)),report=comparativeCohortReport(selected,ids,now),evidence=report.groups.map(g=>{const body={groupKey:g.key,sampleCount:g.candidate.evaluated+g.control.evaluated,reportId:report.reportId,cohortIds:ids,evaluationIds:report.evaluationIds};return notebookEvidenceSchema.parse({...body,evidenceId:notebookEvidenceId(body)});});
  const cases=selected.flatMap(r=>r.evaluation?.status==="evaluated"?[{code:r.member.code,cohortId:r.cohort.cohortId,evaluationId:r.evaluation.evaluationId,horizon:r.horizon,candidate:r.member.candidate,score:r.member.score,actualReturn:r.evaluation.actualReturn!,conditions:r.member.conditions}]:[]);
  const successes=cases.filter(c=>c.actualReturn>0).sort((a,b)=>b.actualReturn-a.actualReturn).slice(0,5),failures=cases.filter(c=>c.actualReturn<0&&(input.theme!=="high-score-failure"||(c.score??-1)>=80)).sort((a,b)=>a.actualReturn-b.actualReturn).slice(0,5);
  const note=notebookOriginalSchema.parse({schemaVersion:1,notebookId:"0".repeat(64),theme:input.theme,period:{from:rows.map(r=>r.cohort.asOf).sort()[0],to:rows.map(r=>r.cohort.asOf).sort().at(-1)},hypothesis:input.hypothesis,methodVersion:"kabumaru-notebook-v1",createdAt:now.toISOString(),mode:service.mode==="demo"?"demo":"research",cohortIds:ids,evaluationIds:report.evaluationIds,report,evidence,successes,failures,
    limitations:[...report.notes,"仮説は研究時点の記録で、観測された事実や因果関係の証明ではありません。","成功・失敗例は例示で、全体成績は固定母集団の集計を参照してください。",...(input.theme==="v-recovery"?["V字回復テーマは短期平均回復・上向き・RSI回復の代理条件です。V字の形状が実証されたとは解釈しません。"]:[]),...(input.theme==="dejavu-similarity"?["このコホートは固定された類似度を含まないため、デジャヴ類似度と成績の関係は判断できません。"]:[]),...(["false-rebound","high-score-failure"].includes(input.theme)?["失敗テーマは期限後の記述的研究です。将来の失敗を予測できるという意味ではありません。"]:[])],nextConditions:["support","volume_rebound","rsi_recovery","above_sma20"]});
  note.notebookId=notebookIdentity(note);
  return service.store.lock(async()=>{const key=`${notebookBase(note.notebookId)}/original.json`;if(await service.store.read(key,null))return readNotebook(service,note.notebookId);await service.store.write(key,note,true);await service.store.write(`${notebookBase(note.notebookId)}/summary.json`,notebookInsights(note));return note;});
}
export function registerKabumaruNotebook(app:FastifyInstance,service:Service){
  app.post("/api/research/notebook/answer",async req=>notebookAnswer(service,req.body));
  app.post("/api/research/notebook/recall",async req=>recallNotebookMemory(service,req.body));
  app.post("/api/research/notebook/:id/memory",async req=>{const {id}=z.object({id:cohortIdSchema}).parse(req.params);return saveNotebookMemory(service,id);});
  app.post("/api/research/notebook/:id/sync",async req=>{const {id}=z.object({id:cohortIdSchema}).parse(req.params),body=z.object({confirmExternal:z.boolean()}).strict().parse(req.body);return syncNotebookMemory(service,id,body.confirmExternal);});
  app.post("/api/research/notebook/:id/summary",async req=>{const {id}=z.object({id:cohortIdSchema}).parse(req.params),original=await readNotebook(service,id),summary=notebookInsights(original);await service.store.lock(()=>service.store.write(`${notebookBase(id)}/summary.json`,summary));return summary;});
  app.post("/api/research/notebook",async req=>createNotebook(service,req.body));
  app.get("/api/research/notebook",async req=>{const q=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).parse(req.query),files=(await service.store.files("research/notebooks")).filter(f=>f.endsWith("/original.json")).reverse();const records=await Promise.all(files.slice((q.page-1)*q.pageSize,q.page*q.pageSize).map(async f=>{const n=notebookOriginalSchema.parse(await service.store.read(f));return {notebookId:n.notebookId,theme:n.theme,period:n.period,createdAt:n.createdAt,mode:n.mode};}));return {records,total:files.length,...q};});
  app.get("/api/research/notebook/:id",async req=>{const {id}=z.object({id:cohortIdSchema}).parse(req.params);const original=await readNotebook(service,id);return {original,summary:notebookInsights(original)};});
}
