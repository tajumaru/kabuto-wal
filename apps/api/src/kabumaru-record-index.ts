import { stat } from "node:fs/promises";
import { z } from "zod";
import type { Service } from "./service";
import { predictionSchema } from "../../../packages/core/index";
import { hash } from "../../../packages/integrations/adjusted-series";

const entrySchema = z.object({ key: z.string(), code: z.string(), asOf: z.string(), method: z.string(), id: z.string(), kind: z.enum(["prediction","memory","research"]), knownAt: z.string(), mode: z.string() });
const indexSchema = z.object({ version: z.literal(1), generation: z.string(), checksum: z.string(), entries: z.array(entrySchema) });
type Index = z.infer<typeof indexSchema>;
const inflight = new WeakMap<Service, Promise<Index>>();
// Derived metadata only. Stat fingerprints detect writes by other processes and repaired JSON.
export async function researchRecordIndex(service: Service): Promise<Index> {
  const pending = inflight.get(service); if (pending) return pending;
  const task = (async () => {
    const files = (await Promise.all(["predictions","evaluations","memories","sync","research/results"].map(p => service.store.files(p)))).flat().sort();
    const descriptors: unknown[] = [];
    for (let i=0;i<files.length;i+=32) descriptors.push(...await Promise.all(files.slice(i,i+32).map(async key => {
      const s = await stat(service.store.path(key), { bigint: true }); return [key,s.size.toString(),s.mtimeNs.toString(),s.ctimeNs.toString()];
    })));
    const generation = hash(descriptors);
    let saved: unknown = null;
    try { saved = await service.store.read("indexes/kabumaru-records.json",null); } catch { /* Rebuild corrupt derived JSON. */ }
    const parsed = indexSchema.safeParse(saved);
    if (parsed.success && parsed.data.generation === generation && parsed.data.checksum === hash(parsed.data.entries)) return parsed.data;
    const entries: Index["entries"] = [];
    const sources = files.filter(f => f.endsWith("/original.json") || f.startsWith("memories/") || f.startsWith("research/results/"));
    for (let i=0;i<sources.length;i+=32) {
      const batch = await Promise.all(sources.slice(i,i+32).map(async key => {
        const r = await service.store.read<Record<string,unknown>>(key);
        const kind = key.startsWith("predictions/") ? "prediction" : key.startsWith("memories/") ? "memory" : "research";
        const context = (r.hunter ?? r.dejavu ?? {}) as Record<string,unknown>;
        const times = [r.createdAt,r.generatedAt,context.recordedAt,context.cutoff,context.dataCutoff].filter((v): v is string => typeof v === "string").sort();
        return entrySchema.safeParse({ key,kind,code:r.providerCode ?? r.code,asOf:r.dataAsOf ?? r.asOf,method:r.methodVersion ?? r.explanationMethodVersion ?? r.kind,id:r.predictionId ?? r.recordId ?? r.researchId,knownAt:times.at(-1) ?? "",mode:r.mode });
      }));
      for (const p of batch) if (p.success) entries.push(p.data);
    }
    entries.sort((a,b) => a.asOf.localeCompare(b.asOf) || a.key.localeCompare(b.key));
    const result = { version:1 as const,generation,entries,checksum:hash(entries) };
    await service.store.lock(() => service.store.write("indexes/kabumaru-records.json",result));
    return result;
  })();
  inflight.set(service,task);
  try { return await task; } finally { inflight.delete(service); }
}
export async function researchRecords(service: Service, code: string, asOf: string, method?: string, page = 1, pageSize = 20, cutoff = "9999", allowedMethods?: string[]) {
  const index = await researchRecordIndex(service);
  const size = Math.min(100,Math.max(1,Math.floor(pageSize))), offset = (Math.max(1,Math.floor(page))-1)*size;
  const selected = index.entries.filter(e => e.code === code && e.asOf <= asOf && e.knownAt <= cutoff && (service.mode === "demo" ? e.mode === "demo" : e.mode !== "demo") && (!method || e.method === method) && (e.kind !== "prediction" || !allowedMethods || allowedMethods.includes(e.method)));
  const predictions = selected.filter(e => e.kind === "prediction").reverse();
  const records = await Promise.all(predictions.slice(offset,offset+size).map(async e => {
    const p = predictionSchema.parse(await service.store.read(e.key));
    // Relationship is resolved from the immutable original ID, never an index-supplied evaluation ID.
    const evaluations = await service.store.all<Record<string,unknown>>(`evaluations/${p.predictionId}`);
    return { ...p,evaluations };
  }));
  const memories = await Promise.all(selected.filter(e => e.kind === "memory").reverse().slice(0,100).map(e => service.store.read<unknown>(e.key)));
  return { generation:index.generation,records,memories,total:predictions.length,page:Math.max(1,Math.floor(page)),pageSize:size };
}
