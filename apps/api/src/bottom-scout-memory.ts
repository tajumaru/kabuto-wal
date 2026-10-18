import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Service } from "./service";
import { hash } from "../../../packages/integrations/adjusted-series";
import { syncMemories } from "../../../packages/integrations/index";
import { scoutId } from "../../../packages/core/bottom-scout-schema";
import { readScoutReport } from "./bottom-scout";
import { evaluateScout } from "./bottom-scout-journal";
import { activeNotebookMemory } from "./kabumaru-notebook-memory";
export const scoutNamespace=(mode:string)=>`kabutowal:bottom-scout:v1:${mode}`;
export const scoutMemoryId=(id:string)=>hash(["scout-memory-v1",id]);
export async function scoutLocalReferences(s:Service,reportId:string){const recordId=scoutMemoryId(reportId),m=await activeNotebookMemory(s,recordId);return m?.reportId===reportId?[{recordId,reportId}]:[];}
export async function saveScoutMemory(s:Service,reportId:string,now=new Date()){
 const report=await readScoutReport(s,reportId),recordId=scoutMemoryId(reportId),review=await evaluateScout(s,report,now),groups=review.groups.filter(g=>g.evaluated>0),outcomeId=groups.length?hash(["scout-outcome-memory-v1",recordId,review.rows]):null;
 return s.store.lock(async()=>{
 const old=await s.store.read(`memories/${recordId}.json`,null),receipt=await s.store.read(`sync/${recordId}.json`,null);if((old||receipt)&&!await activeNotebookMemory(s,recordId))return {recordId,status:"suppressed",note:"削除・無効化済みの記憶を作り直しません"};
 const items=report.rows.filter(r=>r.candidate).slice(0,10).map(r=>({code:r.code,name:r.name,score:r.score,indicators:Object.keys(r.indicators),conditionCodes:r.contributions.filter(c=>c.met).map(c=>c.code),similar:r.similar?{sampleCount:r.similar.sampleCount,bestSimilarity:r.similar.bestSimilarity,horizons:r.similar.horizons}:null,explanation:r.contributions.filter(c=>c.met).map(c=>c.label).join("、"),risks:r.risks}));
 const base={schemaVersion:1,kind:"scout_research_summary",active:true,externalConsent:false,createdAt:now.toISOString(),mode:report.mode,source:report.mode==="demo"?"fixture":"jquants-v2",dataAsOf:report.asOf,namespace:scoutNamespace(report.mode),reportId,methodVersion:report.methodVersion,items,notes:["価格原本・チャート・自由文の質問は送信しません。","上昇確率ではありません。削除状態を優先します。"]};
 if(!old&&!receipt){const payload={...base,recordId,parentRecordId:recordId,outcomes:[]};await s.store.write(`memories/${recordId}.json`,{...payload,text:JSON.stringify({recordId,reportId})},true);await s.store.write(`sync/${recordId}.json`,{status:"pending"});}
 if(outcomeId){const oldOutcome=await s.store.read(`memories/${outcomeId}.json`,null),outcomeState=await s.store.read(`sync/${outcomeId}.json`,null);if(!oldOutcome&&!outcomeState){const payload={...base,recordId:outcomeId,parentRecordId:recordId,outcomes:groups};await s.store.write(`memories/${outcomeId}.json`,{...payload,text:JSON.stringify({recordId:outcomeId,reportId})},true);await s.store.write(`sync/${outcomeId}.json`,{status:"pending"});}}
 return {recordId,outcomeId,status:old?"existing":"pending",note:"ローカル保存のみ。期限後の実績は元の分析と別の追記記憶に保存します。"};});
}
function allow(s:Service,confirm:boolean){if(!confirm||s.mode==="demo"||process.env.ALLOW_MARKET_DATA_TO_MEMWAL!=="true"||process.env.JQUANTS_MEMWAL_RIGHTS_CONFIRMED!=="true")throw Error("今回の明示許可・市場データ送信許可・権利確認が必要です");}
export async function syncScoutMemory(s:Service,reportId:string,confirm:boolean){allow(s,confirm);await readScoutReport(s,reportId);return s.store.lock(async()=>{const root=scoutMemoryId(reportId);if(!await activeNotebookMemory(s,root))throw Error("削除・無効化済み、または未保存の記憶です");const provider=await s.memoryProvider();if(!provider)throw Error("MemWal未接続です。分析結果はローカルに残っています。");const memories=await s.store.all<Record<string,unknown>>("memories"),ids:string[]=[];for(const m of memories){if(m.kind!=="scout_research_summary"||m.reportId!==reportId||m.parentRecordId!==root||typeof m.recordId!=="string"||!await activeNotebookMemory(s,m.recordId))continue;await s.store.write(`memories/${m.recordId}.json`,{...m,externalConsent:true});ids.push(m.recordId);}return syncMemories(s.store,provider,true,ids);});}
export async function recallScoutMemory(s:Service,reportId:string,confirm:boolean){allow(s,confirm);await readScoutReport(s,reportId);const provider=await s.memoryProvider();if(!provider)throw Error("MemWal未接続です");const remote=await provider.recall({query:"底打ち探索の判断条件と確定した実績",namespace:scoutNamespace(s.mode),limit:10}),records=[];for(const entry of remote.results){if(entry.text.length>30000)continue;try{const r=z.object({recordId:scoutId,reportId:scoutId}).parse(JSON.parse(entry.text)),m=await activeNotebookMemory(s,r.recordId),root=scoutMemoryId(r.reportId);if(m?.reportId!==r.reportId||m.kind!=="scout_research_summary"||m.mode!==s.mode||m.namespace!==scoutNamespace(s.mode)||m.parentRecordId!==root||!await activeNotebookMemory(s,root))continue;const original=await readScoutReport(s,r.reportId);records.push({recordId:r.recordId,reportId:original.reportId,asOf:original.asOf,candidates:original.rows.filter(r=>r.candidate).map(r=>({code:r.code,score:r.score}))});}catch{/* Remote prose and deleted references are not evidence. */}}return {records};}
export function registerScoutMemory(app:FastifyInstance,s:Service,origins:string[]){
 const params=z.object({id:scoutId});app.addHook("onRequest",async(req,reply)=>{if(req.url.startsWith("/api/research/scout/")&&!["GET","HEAD"].includes(req.method)&&(!req.headers.origin||!origins.includes(req.headers.origin)||!req.headers["content-type"]?.startsWith("application/json")))return reply.code(403).send({error:"許可されたOriginとJSONで操作してください"});});
 app.post("/api/research/scout/:id/memory",async req=>{z.object({}).strict().parse(req.body);return saveScoutMemory(s,params.parse(req.params).id);});
 app.post("/api/research/scout/:id/sync",async req=>syncScoutMemory(s,params.parse(req.params).id,z.object({confirmExternal:z.literal(true)}).strict().parse(req.body).confirmExternal));
 app.post("/api/research/scout/:id/recall",async req=>recallScoutMemory(s,params.parse(req.params).id,z.object({confirmExternal:z.literal(true)}).strict().parse(req.body).confirmExternal));
 app.get("/api/research/scout/:id/review",async req=>s.store.lock(async()=>evaluateScout(s,await readScoutReport(s,params.parse(req.params).id))));
}
