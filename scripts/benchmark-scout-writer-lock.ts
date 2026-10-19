import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendFileSync,mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { Service } from "../apps/api/src/service";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";

/** Investigation only: wraps fixture instances, never changes the production lock.
 * A cooperating writer from a separate Service uses the default 120s wait limit.
 * Each size has one cold sample (one missing evaluation), then one cache hit.
 */
export async function benchmarkScoutWriterLock(sizes:number[],logFile?:string){
 const emit=(value:unknown)=>{const line=JSON.stringify(value)+"\n";if(logFile)appendFileSync(logFile,line);process.stdout.write(line);};
 const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("synthetic lock benchmark forbids network");};
 emit({environment:{node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,cpus:os.cpus().length,memory:os.totalmem(),samplesPerPhase:1,fixture:"10 candidates;250 symbols;2 revisions/day;4 overlapping dates;temporary synthetic JSON only; app cold, OS cache not flushed"}});
 try{for(const size of sizes){
  emit({stage:"fixture",size});
  const f=await scoutScaleFixture(size,{candidates:10,symbols:250,revisions:true});
  try{
   await unlink(f.s.store.path(f.lastEvaluation));
   const s=new Service(f.root,"demo",false),other=new Service(f.root,"demo",false);
   for(const phase of ["cold-with-one-save","cache-validation-no-save"] as const){
    const lock=s.store.lock.bind(s.store),write=s.store.write.bind(s.store);
    let acquired=0,released=0,acquireMs=0,saveMs=0,saves=0,firstSaveOffsetMs:number|null=null;
    let competitor:Promise<{waitMs:number;writeMs:number;timedOut:boolean}>|undefined;
    const started=performance.now();
    s.store.lock=async(fn,waitMs)=>lock(async()=>{
     acquired=performance.now();acquireMs=acquired-started;
     const competingStart=performance.now();
     competitor=(async()=>{
      let writeStart=0,writeMs=0;
      try{await other.store.lock(async()=>{writeStart=performance.now();await other.store.write("jobs/lock-probe.json",{size,phase});writeMs=performance.now()-writeStart;});
       return {waitMs:writeStart-competingStart,writeMs,timedOut:false};
      }catch(error){
       if(!(error instanceof Error)||!error.message.includes("別の処理"))throw error;
       return {waitMs:performance.now()-competingStart,writeMs,timedOut:true};
      }
     })();
     try{return await fn();}finally{released=performance.now();}
    },waitMs);
    s.store.write=async(key,value,immutable)=>{
     const at=performance.now();firstSaveOffsetMs??=at-acquired;
     try{await write(key,value,immutable);}finally{saveMs+=performance.now()-at;saves++;}
    };
    let response;
    try{response=await scoutAccuracy(s,{pageSize:1},f.now);}finally{s.store.lock=lock;s.store.write=write;}
    const apiMs=performance.now()-started,writer=await competitor;
    emit({stage:"sample",size,phase,apiMs,acquireMs,holdMs:released-acquired,saves,saveMs,firstSaveOffsetMs,
     preSaveMs:firstSaveOffsetMs,postSaveMs:firstSaveOffsetMs===null?null:released-acquired-firstSaveOffsetMs-saveMs,
     writer,totalReports:response.totalReports});
   }
  }finally{await f.cleanup();}
 }}finally{globalThis.fetch=fetch;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const sizes=(process.argv[2]??"1000,5000,10000").split(",").map(Number);
 if(sizes.some(n=>![1000,5000,10000].includes(n)))throw Error("invalid sizes");
 const dir=path.resolve("node_modules/.cache");mkdirSync(dir,{recursive:true});
 await benchmarkScoutWriterLock(sizes,path.join(dir,`scout-writer-lock-${Date.now()}.jsonl`));
}
