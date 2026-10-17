import { stat } from "node:fs/promises";
import { z } from "zod";
import type { Service } from "./service";
import { predictionSchema } from "../../../packages/core/index";
import { hash } from "../../../packages/integrations/adjusted-series";

const entrySchema = z.object({ key: z.string(), code: z.string(), asOf: z.string(), method: z.string(), id: z.string(), kind: z.enum(["prediction","memory","research","chat"]), knownAt: z.string(), mode: z.string() });
const indexSchema = z.object({ version: z.literal(1), generation: z.string(), sourceGeneration:z.string(), checksum: z.string(), entries: z.array(entrySchema) });
type Index = z.infer<typeof indexSchema>;
const inflight = new WeakMap<Service, Promise<Index>>();
const warm=new WeakMap<Service,{token:string;stamp:string;index:Index}>();
async function indexStamp(service:Service){try{const s=await stat(service.store.path("indexes/kabumaru-records.json"),{bigint:true});return `${s.size}/${s.mtimeNs}/${s.ctimeNs}`;}catch{return "";}}
// Derived metadata only. Stat fingerprints detect writes by other processes and repaired JSON.
export async function researchRecordIndex(service: Service): Promise<Index> {
  const pending = inflight.get(service); if (pending) return pending;
  const task = (async () => {
    const token=await service.store.generation(),previous=warm.get(service);
    if(process.env.RESEARCH_INDEX_FULL_AUDIT!=="true"&&token&&previous?.token===token&&previous.stamp===await indexStamp(service))return structuredClone(previous.index);
    const remember=async(result:Index)=>{if(token&&token===await service.store.generation())warm.set(service,{token,stamp:await indexStamp(service),index:structuredClone(result)});return result;};
    const files = (await Promise.all(["predictions","evaluations","memories","sync","research/results","research/chats"].map(p => service.store.files(p)))).flat().sort();
    const descriptors: unknown[] = [];
    for (let i=0;i<files.length;i+=32) descriptors.push(...await Promise.all(files.slice(i,i+32).map(async key => {
      const s = await stat(service.store.path(key), { bigint: true }); return [key,s.size.toString(),s.mtimeNs.toString(),s.ctimeNs.toString()];
    })));
    const generation = hash(descriptors);
    const isSource=(key:string)=>key.endsWith("/original.json")||key.startsWith("memories/")||key.startsWith("research/results/")||key.startsWith("research/chats/");
    const sourceGeneration=hash(descriptors.filter(d=>isSource((d as string[])[0])));
    let saved: unknown = null;
    try { saved = await service.store.read("indexes/kabumaru-records.json",null); } catch { /* Rebuild corrupt derived JSON. */ }
    const parsed = indexSchema.safeParse(saved);
    if (parsed.success && parsed.data.generation === generation && parsed.data.checksum === hash(parsed.data.entries)) return remember(parsed.data);
    if (parsed.success && parsed.data.sourceGeneration===sourceGeneration && parsed.data.checksum===hash(parsed.data.entries)) {
      const result={...parsed.data,generation};
      await service.store.lock(()=>service.store.write("indexes/kabumaru-records.json",result));return remember(result);
    }
    const entries: Index["entries"] = [];
    const sources = files.filter(isSource);
    for (let i=0;i<sources.length;i+=32) {
      const batch = await Promise.all(sources.slice(i,i+32).map(async key => {
        const r = await service.store.read<Record<string,unknown>>(key);
        const kind = key.startsWith("predictions/") ? "prediction" : key.startsWith("memories/") ? "memory" : key.startsWith("research/chats/")?"chat":"research";
        const context = (r.hunter ?? r.dejavu ?? {}) as Record<string,unknown>;
        const times = [r.createdAt,r.generatedAt,context.recordedAt,context.cutoff,context.dataCutoff].filter((v): v is string => typeof v === "string").sort();
        return entrySchema.safeParse({ key,kind,code:r.providerCode ?? r.code,asOf:r.dataAsOf ?? r.asOf,method:r.methodVersion ?? r.explanationMethodVersion ?? r.kind,id:r.predictionId ?? r.recordId ?? r.researchId,knownAt:times.at(-1) ?? "",mode:r.mode });
      }));
      for (const p of batch) if (p.success) entries.push(p.data);
    }
    entries.sort((a,b) => a.asOf.localeCompare(b.asOf) || a.key.localeCompare(b.key));
    const result = { version:1 as const,generation,sourceGeneration,entries,checksum:hash(entries) };
    await service.store.lock(() => service.store.write("indexes/kabumaru-records.json",result));
    return remember(result);
  })();
  inflight.set(service,task);
  try { return await task; } finally { inflight.delete(service); }
}
export async function researchRecords(service: Service, code: string, asOf: string, method?: string, page = 1, pageSize = 20, cutoff = new Date().toISOString(), allowedMethods?: string[]) {
  const index = await researchRecordIndex(service);
  const size = Math.min(100,Math.max(1,Math.floor(pageSize))), offset = (Math.max(1,Math.floor(page))-1)*size;
  const selected = index.entries.filter(e => e.code === code && e.asOf <= asOf && e.knownAt <= cutoff && (service.mode === "demo" ? e.mode === "demo" : e.mode !== "demo") && (!method || e.method === method) && (e.kind !== "prediction" || !allowedMethods || allowedMethods.includes(e.method)));
  const predictions = selected.filter(e => e.kind === "prediction").reverse();
  const records = await Promise.all(predictions.slice(offset,offset+size).map(async e => {
    const p = predictionSchema.parse(await service.store.read(e.key));
    // Relationship is resolved from the immutable original ID, never an index-supplied evaluation ID.
    const evaluationFiles = (await service.store.files(`evaluations/${p.predictionId}`)).sort();
    // Refuse pathological revision fan-out rather than silently selecting an arbitrary evaluation.
    if (evaluationFiles.length > 100) throw Error("1予測の評価改訂が100件を超えています。評価履歴を確認してください。");
    const evaluations = await Promise.all(evaluationFiles.map(f=>service.store.read<Record<string,unknown>>(f)));
    return { ...p,evaluations };
  }));
  const memories = await Promise.all(selected.filter(e => e.kind === "memory").reverse().slice(0,100).map(e => service.store.read<unknown>(e.key)));
  const research = selected.filter(e=>e.kind==="research").reverse();
  return { generation:index.generation,records,memories,research:research.slice(offset,offset+size).map(e=>({id:e.id,asOf:e.asOf,method:e.method})),researchTotal:research.length,total:predictions.length,page:Math.max(1,Math.floor(page)),pageSize:size };
}
