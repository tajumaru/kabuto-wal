import type { Service } from "./service";
import { hash } from "../../../packages/integrations/adjusted-series";

type Entry<T>={at:number;until:number;value:T;reads:Map<string,{fallback:unknown;digest:string}>;lists:Map<string,string[]>};
const caches=new WeakMap<Service,Map<string,Entry<unknown>>>();
/** Derived in-memory cache. Verify source CONTENTS and file inventories on every hit.
 * No disk cache, stale generation-only keys, source writes, or provider calls. */
export async function cachedScoutAccuracy<T>(s:Service,key:string,now:Date,compute:(view:Service)=>Promise<T>):Promise<T>{
 let entries=caches.get(s);if(!entries){entries=new Map();caches.set(s,entries);}
 const old=entries.get(key) as Entry<T>|undefined,at=now.getTime();
 if(old&&at>=old.at&&at<old.until){
  let valid=true;
  for(const [prefix,files] of old.lists)if(hash((await s.store.files(prefix)).sort())!==hash(files)){valid=false;break;}
  if(valid)for(const [file,{fallback,digest}] of old.reads){
   try{if(hash(await s.store.read(file,fallback))!==digest){valid=false;break;}}catch{valid=false;break;}
  }
  if(valid)return structuredClone(old.value);
 }
 const reads:Entry<T>["reads"]=new Map(),lists:Entry<T>["lists"]=new Map(),memo=new Map<string,Promise<unknown>>();
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
   let value=memo.get(file);
   if(!value){value=target.read<unknown>(file,fallback);memo.set(file,value);}
   const result=await value;reads.set(file,{fallback,digest:hash(result)});observe(result);return structuredClone(result);
  };
  if(property==="files")return async(prefix:string)=>{let files=lists.get(prefix);if(!files){files=(await target.files(prefix)).sort();lists.set(prefix,files);}return [...files];};
  if(property==="write")return async(file:string,value:unknown,immutable=false)=>{
   await target.write(file,value,immutable);memo.set(file,Promise.resolve(value));reads.set(file,{fallback:null,digest:hash(value)});
   for(const [prefix,files] of lists)if(file.startsWith(`${prefix}/`)&&!files.includes(file)){files.push(file);files.sort();}
  };
  return Reflect.get(target,property,receiver);
 }});
 const view=Object.create(s) as Service;view.store=store;
 const value=await compute(view);
 // Do not bless files added concurrently by another writer as inputs we have read.
 for(const [prefix,files] of lists)if(hash((await s.store.files(prefix)).sort())!==hash(files))return value;
 if(entries.size>=4)entries.delete(entries.keys().next().value!);
 entries.set(key,{at,until,value:structuredClone(value),reads,lists});return value;
}
