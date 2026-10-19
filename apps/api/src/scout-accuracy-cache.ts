import type { Service } from "./service";
import { hash } from "../../../packages/integrations/adjusted-series";
import { scoutAccuracyBatch } from "./scout-accuracy-io";

type Read={file:string;fallback:unknown;digest:string};
type Entry<T>={at:number;until:number;value:T;reads:Map<string,Read>;lists:Map<string,string[]>};
const caches=new WeakMap<Service,Map<string,Entry<unknown>>>();
const pending=new WeakMap<Service,Map<string,Promise<Entry<unknown>>>>();
const readKey=(file:string,fallback:unknown)=>hash([file,typeof fallback,fallback]);
async function unchanged(s:Service,entry:Pick<Entry<unknown>,"lists"|"reads">){
 const inventories=async()=> (await scoutAccuracyBatch([...entry.lists],async([prefix,files])=>hash((await s.store.files(prefix)).sort())===hash(files))).every(Boolean);
 try{
  if(!await inventories())return false;
  if(!(await scoutAccuracyBatch([...entry.reads.values()],async({file,fallback,digest})=>hash(await s.store.read(file,fallback))===digest)).every(Boolean))return false;
  return await inventories();
 }catch{return false;}
}
/** Derived in-memory cache. Verify source CONTENTS and file inventories on every hit.
 * No disk cache, stale generation-only keys, source writes, or provider calls. */
export async function cachedScoutAccuracy<T,R=T>(s:Service,key:string,now:Date,compute:(view:Service)=>Promise<T>,select:(value:T)=>R=(v=>v as unknown as R),writeLock=false):Promise<R>{
 let entries=caches.get(s);if(!entries){entries=new Map();caches.set(s,entries);}
 let flights=pending.get(s);if(!flights){flights=new Map();pending.set(s,flights);}
 const at=now.getTime();let flight=flights.get(key) as Promise<Entry<T>>|undefined;
 if(!flight){
 const resolve=async():Promise<Entry<T>>=>{
 const old=entries.get(key) as Entry<T>|undefined;
 if(old&&at>=old.at&&at<old.until&&await unchanged(s,old))return old;
 entries.delete(key);
 for(let attempt=0;attempt<3;attempt++){
 const reads:Entry<T>["reads"]=new Map(),lists:Entry<T>["lists"]=new Map(),memo=new Map<string,Promise<unknown>>(),writes=new Map<string,unknown>();
 let until=at+60_000;
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
   const id=readKey(file,fallback);let value=memo.get(id);
   if(!value){value=target.read<unknown>(file,fallback);memo.set(id,value);}
   const result=await value;reads.set(id,{file,fallback:structuredClone(fallback),digest:hash(result)});observe(result);return structuredClone(result);
  };
  if(property==="files")return async(prefix:string)=>{let files=lists.get(prefix);if(!files){files=(await target.files(prefix)).sort();lists.set(prefix,files);}return [...files];};
  if(property==="write")return async(file:string,value:unknown,immutable=false)=>{
   if(!writeLock||!immutable)throw Error("精度集計ではロック下の不変評価原本だけを保存できます");
   if(writes.has(file)&&hash(writes.get(file))!==hash(value))throw Error("評価原本の保存内容が競合しています");
   writes.set(file,structuredClone(value));observe(value);
  };
  return Reflect.get(target,property,receiver);
 }});
 const view=Object.create(s) as Service;view.store=store;
 const value=await compute(view);
 const entry={at,until,value,reads,lists};
 if(!await unchanged(s,entry))continue;
 // Publish staged immutable evaluations only after their source snapshot passed.
 // The caller's existing Store lock is held through validation and publication.
 for(const [file,data] of writes){
  const existing=await s.store.read(file,null);
  if(existing!==null){if(hash(existing)!==hash(data))throw Error("評価原本の保存内容が競合しています");}
  else await s.store.write(file,data,true);
  for(const [id,read] of reads)if(read.file===file){memo.set(id,Promise.resolve(data));read.digest=hash(data);}
  reads.set(readKey(file,undefined),{file,fallback:undefined,digest:hash(data)});
  for(const [prefix,files] of lists)if(file.startsWith(`${prefix}/`)&&!files.includes(file)){files.push(file);files.sort();}
 }
 if(writes.size&&!await unchanged(s,entry))continue;
 if(entries.size>=4)entries.delete(entries.keys().next().value!);
 entries.set(key,entry);return entry;
 }
 throw Error("集計中に保存データが変更されました。更新完了後に再試行してください。");
 };
 // Existing cross-process writer lock protects immutable evaluation creation.
 flight=writeLock?s.store.lock(resolve):resolve();flights.set(key,flight);
 void flight.finally(()=>{if(flights.get(key)===flight)flights.delete(key);}).catch(()=>{});
 }
 const entry=await flight;
 // Concurrent callers can cross a close deadline or request an earlier cutoff.
 if(at<entry.at||at>=entry.until)return cachedScoutAccuracy(s,key,now,compute,select,writeLock);
 return structuredClone(select(entry.value));
}
