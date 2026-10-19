import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendFileSync,mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { Service } from "../apps/api/src/service";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { measure } from "./benchmark-scout-accuracy";

/** Synthetic-only before/after comparison, with unchanged production lock limits.
 * A separate Service writes during source reads and during lock ownership.
 * Each variant has one cold save, one cache hit and one page-switch sample.
 * Source read calls exclude the competing writers' lock-owner polling, whereas
 * measure() filesystem counters include every operation inside the fixture root.
 */
export async function benchmarkScoutWriterLock(sizes:number[],logFile?:string,baseline?:typeof scoutAccuracy,variant:"before"|"after"|"both"="after"){
 const emit=(value:unknown)=>{const line=JSON.stringify(value)+"\n";if(logFile)appendFileSync(logFile,line);process.stdout.write(line);};
 const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("synthetic lock benchmark forbids network");};
 emit({environment:{node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,cpus:os.cpus().length,memory:os.totalmem(),samplesPerPhase:1,gc:!!global.gc,variant,fixture:"10 candidates;250 symbols;2 revisions/day;4 overlapping dates;temporary synthetic JSON only; app cold, OS cache not flushed; before then after on identical fixture"}});
 try{for(const size of sizes){
  emit({stage:"fixture",size});
  const f=await scoutScaleFixture(size,{candidates:10,symbols:250,revisions:true});
  emit({stage:"fixture-ready",size});
  const hashes=new Map<string,string>();
  try{for(const [implementation,api] of [["before",baseline],["after",scoutAccuracy]] as const){
   if(variant!=="both"&&variant!==implementation)continue;
   if(!api)throw Error("baseline API required");
   await unlink(f.s.store.path(f.lastEvaluation));
   const s=new Service(f.root,"demo",false),other=new Service(f.root,"demo",false);
   for(const [phase,page] of [["cold-with-one-save",1],["cache-validation-no-save",1],["page2-no-save",2]] as const){
    const lock=s.store.lock.bind(s.store),write=s.store.write.bind(s.store),read=s.store.read.bind(s.store);
    let lockCount=0,holdMs=0,acquireMs=0,saveMs=0,saves=0,sourceReads=0,held=false;
    const writers:Array<Promise<{trigger:string;waitMs:number;writeMs:number;timedOut:boolean}>>=[];
    const startWriter=(trigger:string)=>{
     const start=performance.now();
     writers.push((async()=>{
      let writeStart=0,writeMs=0;
      try{await other.store.lock(async()=>{writeStart=performance.now();await other.store.write(`jobs/lock-probe-${trigger}.json`,{size,phase});writeMs=performance.now()-writeStart;});
       return {trigger,waitMs:writeStart-start,writeMs,timedOut:false};
      }catch(error){
       if(!(error instanceof Error)||!error.message.includes("別の処理"))throw error;
       return {trigger,waitMs:performance.now()-start,writeMs,timedOut:true};
      }
     })());
    };
    s.store.read=async(key,fallback)=>{if(++sourceReads===1)startWriter("first-source-read");return read(key,fallback);};
    s.store.lock=async(fn,waitMs)=>{
     const start=performance.now();
     return lock(async()=>{
      const acquired=performance.now();acquireMs+=acquired-start;lockCount++;held=true;startWriter("lock-acquired");
      try{return await fn();}finally{holdMs+=performance.now()-acquired;held=false;}
     },waitMs);
    };
    s.store.write=async(key,value,immutable)=>{
     if(!held||!immutable)throw Error("evaluation saved outside writer lock");
     const at=performance.now();
     try{await write(key,value,immutable);}finally{saveMs+=performance.now()-at;saves++;}
    };
    let metrics;
    try{metrics=await measure(f.root,()=>api(s,{page,pageSize:1},f.now));}finally{s.store.lock=lock;s.store.write=write;s.store.read=read;}
    const probes=await Promise.all(writers);
    emit({stage:"sample",size,implementation,phase,lockCount,holdMs,acquireMs,saves,saveMs,sourceReads,writers:probes,...metrics});
    if(implementation==="before")hashes.set(phase,metrics.responseHash);
    else if(hashes.has(phase)&&hashes.get(phase)!==metrics.responseHash)throw Error("baseline and improved responses differ");
    if(saves!==(phase==="cold-with-one-save"?1:0))throw Error("unexpected evaluation save count");
    if(implementation==="after"&&(holdMs>=120_000||probes.some(w=>w.timedOut)||phase!=="cold-with-one-save"&&lockCount!==0))throw Error("writer contention target not met");
   }
  }}finally{await f.cleanup();}
 }}finally{globalThis.fetch=fetch;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const sizes=(process.argv[2]??"1000,5000,10000").split(",").map(Number),baselineFile=process.argv[3],variant=process.argv[4]??"after";
 if(sizes.some(n=>![1000,5000,10000].includes(n))||!["before","after","both"].includes(variant))throw Error("invalid parameters");
 const baseline=baselineFile&&baselineFile!=="-"?await import(pathToFileURL(path.resolve(baselineFile)).href):undefined;
 const dir=path.resolve("node_modules/.cache");mkdirSync(dir,{recursive:true});
 await benchmarkScoutWriterLock(sizes,path.join(dir,`scout-writer-lock-two-phase-${Date.now()}.jsonl`),baseline?.scoutAccuracy,variant as "before"|"after"|"both");
}
