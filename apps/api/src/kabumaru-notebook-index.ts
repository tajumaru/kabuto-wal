import { z } from "zod";
import type { Service } from "./service";
import { notebookOriginalSchema } from "../../../packages/core/kabumaru-notebook-schema";
const meta=notebookOriginalSchema.pick({notebookId:true,theme:true,period:true,createdAt:true,mode:true}).strip();
type Meta=z.infer<typeof meta>;
const cache=new WeakMap<Service,{generation:string;records:Meta[]}>();
export async function notebookCatalog(service:Service){
  const generation=await service.store.generation(),saved=cache.get(service);
  if(process.env.RESEARCH_INDEX_FULL_AUDIT!=="true"&&generation&&generation===saved?.generation)return structuredClone(saved.records);
  const files=(await service.store.files("research/notebooks")).filter(f=>f.endsWith("/original.json")),records:Meta[]=[];
  for(let i=0;i<files.length;i+=32){const rows=await Promise.all(files.slice(i,i+32).map(async key=>meta.parse(await service.store.read(key))));records.push(...rows);}
  records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.notebookId.localeCompare(b.notebookId));
  if(generation&&generation===await service.store.generation())cache.set(service,{generation,records:structuredClone(records)});
  return records;
}
