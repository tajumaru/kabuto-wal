import type { Service } from "./service";
import { hash } from "../../../packages/integrations/adjusted-series";
import { scoutAccuracyBatch } from "./scout-accuracy-io";

type Read={file:string;digest:string|null};
type Entry<T>={at:number;until:number;value:T;reads:Map<string,Read>;lists:Map<string,string[]>};
const caches=new WeakMap<Service,Map<string,Entry<unknown>>>();
const pending=new WeakMap<Service,Map<string,Promise<Entry<unknown>>>>();
async function unchanged(s:Service,entry:Pick<Entry<unknown>,"lists"|"reads">){
 const inventories=async()=> (await scoutAccuracyBatch([...entry.lists],async([prefix,files])=>hash((await s.store.files(prefix)).sort())===hash(files))).every(Boolean);
 try{
  for(let pass=0;pass<2;pass++){
   if(!await inventories())return false;
   if(!(await scoutAccuracyBatch([...entry.reads.values()],async({file,digest})=>{
    try{return hash(await s.store.read(file))===digest;}
    catch(error){return digest===null&&(error as NodeJS.ErrnoException).code==="ENOENT";}
   })).every(Boolean))return false;
  }
  return await inventories();
 }catch{return false;}
}
/** Verify source contents twice and inventories on every hit. No disk cache,
 * generation-only shortcuts, provider calls, or prediction original writes.
 * Evaluation originals are staged and published under the existing writer lock. */
export async function cachedScoutAccuracy<T,R=T>(s:Service,key:string,now:Date,compute:(view:Service)=>Promise<T>,select:(value:T)=>R=(v=>v as unknown as R),writeLock=false):Promise<R>{
 let entries=caches.get(s);if(!entries){entries=new Map();caches.set(s,entries);}
 let flights=pending.get(s);if(!flights){flights=new Map();pending.set(s,flights);}
 const at=now.getTime(),started=Date.now();let flight=flights.get(key) as Promise<Entry<T>>|undefined;
 if(!flight){
 const resolve=async():Promise<Entry<T>>=>{
 const old=entries.get(key) as Entry<T>|undefined;
 if(old&&at>=old.at&&at<old.until&&await unchanged(s,old))return old;
 entries.delete(key);
 for(let attempt=0;attempt<3;attempt++){
 const reads:Entry<T>["reads"]=new Map(),lists:Entry<T>["lists"]=new Map(),memo=new Map<string,Promise<unknown>>(),listing=new Map<string,Promise<string[]>>(),writes=new Map<string,unknown>();
 let until=Infinity;
 // Expire before a stored future observation, forecast, or close deadline becomes usable.
 const observe=(value:unknown):void=>{
  if(typeof value==="string"&&/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)){
   const ms=Date.parse(value.length===10?`${value}T08:30:00.000Z`:value);if(ms>at)until=Math.min(until,ms);
  }else if(Array.isArray(value))value.forEach(observe);
  else if(value&&typeof value==="object")Object.values(value).forEach(observe);
 };
 const store=new Proxy(s.store,{get(target,property,receiver){
  if(property==="read")return async(file:string,fallback?:unknown)=>{
   if(writes.has(file))return structuredClone(writes.get(file));
   // Memoize the physical read, never its fallback. ENOENT is source evidence;
   // each caller still receives its own null/array/object fallback semantics.
   let value=memo.get(file);
   if(!value){value=target.read<unknown>(file);memo.set(file,value);}
   let result:unknown;
   try{result=await value;reads.set(file,{file,digest:hash(result)});}
   catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"||fallback===undefined)throw error;reads.set(file,{file,digest:null});result=fallback;}
   observe(result);return structuredClone(result);
  };
  if(property==="files")return async(prefix:string)=>{
   let promise=listing.get(prefix);if(!promise){promise=target.files(prefix).then(files=>{files.sort();lists.set(prefix,files);return files;});listing.set(prefix,promise);}
   return [...await promise];
  };
  if(property==="write")return async(file:string,value:unknown,immutable=false)=>{
   if(!writeLock||!immutable)throw Error("精度集計では不変評価原本だけを仮生成できます");
   if(writes.has(file)&&hash(writes.get(file))!==hash(value))throw Error("評価原本の保存内容が競合しています");
   writes.set(file,structuredClone(value));observe(value);
  };
  return Reflect.get(target,property,receiver);
 }});
 const view=Object.create(s) as Service;view.store=store;
 const value=await compute(view);
 const entry={at,until,value,reads,lists};
 if(!await unchanged(s,entry))continue;
 // Phase B rechecks the entire observed snapshot after acquiring the root lock.
 // A conflict returns to Phase A; expensive computation is never retried here.
 const publish=async()=>{
 if(!await unchanged(s,entry))return false;
 for(const [file,data] of writes){
  const existing=await s.store.read(file,null);
  if(existing!==null){if(hash(existing)!==hash(data))throw Error("評価原本の保存内容が競合しています");}
  else await s.store.write(file,data,true);
  memo.set(file,Promise.resolve(data));reads.set(file,{file,digest:hash(data)});
  for(const [prefix,files] of lists)if(file.startsWith(`${prefix}/`)&&!files.includes(file)){files.push(file);files.sort();}
 }
 return unchanged(s,entry);
 };
 if(writes.size&&!await s.store.lock(publish))continue;
 // Long scans must not consume the whole TTL before the response is ready.
 // Keep the evaluation cutoff and every observed future boundary unchanged.
 entry.until=Math.min(until,at+Math.max(0,Date.now()-started)+60_000);
 if(entries.size>=4)entries.delete(entries.keys().next().value!);
 entries.set(key,entry);return entry;
 }
 throw Error("集計中に保存データが変更されました。更新完了後に再試行してください。");
 };
 // Phase A and cache validation never acquire the writer lock. Only staged
 // immutable publications use the existing cross-process exclusion above.
 flight=resolve();flights.set(key,flight);
 void flight.finally(()=>{if(flights.get(key)===flight)flights.delete(key);}).catch(()=>{});
 }
 const entry=await flight;
 // Concurrent callers can cross a close deadline or request an earlier cutoff.
 if(at<entry.at||at>=entry.until)return cachedScoutAccuracy(s,key,now,compute,select,writeLock);
 return structuredClone(select(entry.value));
}
