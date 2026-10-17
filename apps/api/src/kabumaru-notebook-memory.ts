import { z } from "zod";
import type { Service } from "./service";
import { readNotebook } from "./kabumaru-notebook";
import { notebookTheme,notebookThemes } from "../../../packages/core/kabumaru-notebook-schema";
import { cohortIdSchema } from "../../../packages/core/hunter-cohort-schema";
import { hash } from "../../../packages/integrations/adjusted-series";
import { syncMemories } from "../../../packages/integrations/index";
export function notebookMemoryId(note:Awaited<ReturnType<typeof readNotebook>>){return hash(["notebook-memory-v1",note.mode,note.theme,note.cohortIds,note.report.reportId]);}
export const notebookNamespace=(mode:string,theme:string)=>`kabutowal:notebook:v1:${mode}:${theme}`;
export async function activeNotebookMemory(service:Service,id:string){
  const m=await service.store.read<Record<string,unknown>|null>(`memories/${cohortIdSchema.parse(id)}.json`,null),s=await service.store.read<Record<string,unknown>>(`sync/${id}.json`,{});
  if(!m||m.active!==true||m.remoteDeletedAt||["deleted","disabled"].includes(String(s.status))||s.remoteDeletion||s.searchResetAt||s.blobDeletedAt||s.directWalrusDeletion)return null;
  return m;
}
export async function saveNotebookMemory(service:Service,id:string){
  const note=await readNotebook(service,id),recordId=notebookMemoryId(note);
  return service.store.lock(async()=>{
    const old=await service.store.read(`memories/${recordId}.json`,null),state=await service.store.read(`sync/${recordId}.json`,null);
    // A receipt/tombstone alone is enough to prohibit regeneration.
    if(old||state)return {recordId,status:await activeNotebookMemory(service,recordId)?"existing":"suppressed",note:"既存の記憶・削除状態を維持しました。"};
    const compact={theme:note.theme,period:note.period,cohortIds:note.cohortIds,methodVersion:note.methodVersion,evidenceIds:note.evidence.map(e=>e.evidenceId),conditionCodes:[...new Set([...note.successes,...note.failures].flatMap(c=>c.conditions))],
      outcomes:note.report.groups.slice(0,12).map(g=>({mode:g.mode,experiment:g.experiment,horizon:g.horizon,candidate:g.candidate,control:g.control,difference:g.difference,lowSample:g.lowSample})),displayedSuccessExamples:note.successes.length,displayedFailureExamples:note.failures.length,warnings:["原因ではなく観測された関連性。少数標本・欠損・選択バイアスに注意。","最大12集計。全価格系列・市場原本・自由記述の仮説は含めません。"]};
    const memory={schemaVersion:1,kind:"notebook_research_summary",recordId,active:true,externalConsent:false,createdAt:new Date().toISOString(),mode:service.mode,source:service.mode==="demo"?"fixture":"jquants-v2",dataAsOf:note.period.to,notebookId:note.notebookId,namespace:notebookNamespace(service.mode,note.theme),...compact};
    await service.store.write(`memories/${recordId}.json`,{...memory,text:JSON.stringify({recordId,notebookId:note.notebookId,...compact})},true);await service.store.write(`sync/${recordId}.json`,{status:"pending"});return {recordId,status:"pending",note:"ローカルにコンパクトな研究記憶を保存しました。外部送信はしていません。"};
  });
}
function allowed(service:Service,confirm:boolean){if(!confirm||service.mode==="demo"||process.env.ALLOW_MARKET_DATA_TO_MEMWAL!=="true"||process.env.JQUANTS_MEMWAL_RIGHTS_CONFIRMED!=="true")throw Error("MemWalの送信許可・権利確認・今回の明示操作が必要です");}
export async function syncNotebookMemory(service:Service,id:string,confirm:boolean){
  allowed(service,confirm);const note=await readNotebook(service,id),recordId=notebookMemoryId(note);
  return service.store.lock(async()=>{const m=await activeNotebookMemory(service,recordId);if(!m)throw Error("削除・無効化済み、または未保存の記憶です");const provider=await service.memoryProvider();if(!provider)throw Error("MemWal未接続");await service.store.write(`memories/${recordId}.json`,{...m,externalConsent:true});return syncMemories(service.store,provider,true,[recordId]);});
}
export async function recallNotebookMemory(service:Service,raw:unknown){
  const input=z.object({theme:notebookTheme,confirmExternal:z.boolean().default(false),asOf:z.string().datetime().optional()}).strict().parse(raw);allowed(service,input.confirmExternal);
  const cutoff=input.asOf??new Date().toISOString();if(cutoff>new Date().toISOString())throw Error("未来時点の記憶は検索できません");const provider=await service.memoryProvider();if(!provider)throw Error("MemWal未接続");
  const response=await provider.recall({query:notebookThemes[input.theme],namespace:notebookNamespace(service.mode,input.theme),limit:20}),records=[];
  for(const item of response.results){if(item.text.length>50000)continue;try{const r=z.object({recordId:cohortIdSchema,notebookId:cohortIdSchema}).parse(JSON.parse(item.text)),memory=await activeNotebookMemory(service,r.recordId);if(memory?.notebookId!==r.notebookId||memory.mode!==service.mode||memory.namespace!==notebookNamespace(service.mode,input.theme))continue;const note=await readNotebook(service,r.notebookId);if(note.theme!==input.theme||note.createdAt>cutoff||note.notebookId!==r.notebookId||notebookMemoryId(note)!==r.recordId)continue;records.push({notebookId:note.notebookId,theme:note.theme,createdAt:note.createdAt,evidenceIds:note.evidence.map(e=>e.evidenceId)});}catch{/* Remote prose and unverified references are never facts. */}}
  return {records,note:"リモート文章ではなく、ローカル原本と照合した参照IDだけを返しました。"};
}
