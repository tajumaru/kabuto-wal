import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendFileSync,mkdirSync } from "node:fs";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { Service } from "../apps/api/src/service";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { measure,percentiles,type Measurement } from "./benchmark-scout-accuracy";

/** Explicit synthetic-only comparison. Baseline is an exported, unmodified
 * implementation of scoutAccuracy from the recorded baseline commit. */
export async function benchmarkScoutConcurrency(sizes:number[],baseline:typeof scoutAccuracy,repeats=3,logFile?:string,variant:"both"|"baseline"|"improved"="both"){
 const emit=(value:unknown)=>{const line=JSON.stringify(value)+"\n";if(logFile)appendFileSync(logFile,line);process.stdout.write(line);};
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("benchmark forbids external requests");};
 emit({environment:{node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,memory:os.totalmem(),repeats,gc:!!global.gc,fixture:"synthetic; 10 candidates/report; 250 symbols; 2 revisions/session; 4 overlapping as-of dates; app-cold, OS cache not flushed; no real data or external requests"}});
 try{for(const size of sizes){
  emit({stage:"fixture",size});
  const f=await scoutScaleFixture(size,{candidates:10,symbols:250,revisions:true});
  emit({stage:"fixture-ready",size,temporaryRoot:f.root});
  const baselineHashes=new Map<string,string>();
  try{for(const [implementation,api] of [["baseline-f204281",baseline],["improved",scoutAccuracy]] as const){
   if(variant==="baseline"&&implementation!=="baseline-f204281"||variant==="improved"&&implementation!=="improved")continue;
   const samples:Record<string,Measurement[]>={cold:[],warm:[],page2:[],page3:[],concurrent:[]};
   for(let run=0;run<repeats;run++){
    const s=new Service(f.root,"demo",false),call=(page=1)=>api(s,{page,pageSize:1},f.now,{persist:false});
    for(const [name,page] of [["cold",1],["warm",1],["page2",2],["page3",3]] as const){
     const sample=await measure(f.root,()=>call(page));samples[name].push(sample);
     const identity=`${run}/${name}`;
     if(implementation==="baseline-f204281")baselineHashes.set(identity,sample.responseHash);
     else if(baselineHashes.has(identity)&&baselineHashes.get(identity)!==sample.responseHash)throw Error("baseline and improved responses differ");
     emit({stage:"sample",size,implementation,run,name,...sample});
    }
    const concurrentService=new Service(f.root,"demo",false);
    const sample=await measure(f.root,()=>Promise.all([1,1].map(page=>api(concurrentService,{page,pageSize:1},f.now,{persist:false}))));samples.concurrent.push(sample);
    if(implementation==="baseline-f204281")baselineHashes.set(`${run}/concurrent`,sample.responseHash);
    else if(baselineHashes.has(`${run}/concurrent`)&&baselineHashes.get(`${run}/concurrent`)!==sample.responseHash)throw Error("concurrent responses differ");
    emit({stage:"sample",size,implementation,run,name:"concurrent",...sample});
   }
   const probeService=new Service(f.root,"demo",false),probe=()=>api(probeService,{pageSize:1},f.now,{persist:false});
   await probe();const originalRead=probeService.store.readBytes.bind(probeService.store),key=`research/scout/reports/${f.lastReport.reportId}/original.json`;
   let changed=false;probeService.store.readBytes=async file=>{
    const value=await originalRead(file);
    if(file===key&&!changed){changed=true;await f.json(key,{...f.lastReport,inputHash:"0".repeat(64)});}
    return value;
   };
   let rejected=false;try{await probe();}catch{rejected=true;}finally{await f.json(key,f.lastReport);probeService.store.readBytes=originalRead;}
   emit({stage:"result",size,implementation,latency:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,percentiles(v.map(x=>x.ms))])),samples,race:{mutationInjected:changed,tamperDuringReadRejected:rejected}});
  }}finally{await f.cleanup();}
 }}finally{globalThis.fetch=originalFetch;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const sizes=(process.argv[2]??"1000,5000,10000").split(",").map(Number),baselineFile=process.argv[3],repeats=Number(process.argv[4]??3),variant=process.argv[5]??"both";
 if(!baselineFile||sizes.some(n=>![100,1000,5000,10000].includes(n))||!Number.isInteger(repeats)||repeats<3||repeats>10||!["both","baseline","improved"].includes(variant))throw Error("invalid benchmark parameters");
 const baseline=await import(pathToFileURL(path.resolve(baselineFile)).href);
 const dir=path.resolve("node_modules/.cache");mkdirSync(dir,{recursive:true});
 await benchmarkScoutConcurrency(sizes,baseline.scoutAccuracy,repeats,path.join(dir,`scout-concurrency-${Date.now()}.jsonl`),variant as "both"|"baseline"|"improved");
}
