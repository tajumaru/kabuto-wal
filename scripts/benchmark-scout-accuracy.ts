import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { Service } from "../apps/api/src/service";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";

type Measurement={ms:number;readAttempts:number;readFiles:number;readBytes:number;directoryReads:number;rssDelta:number;heapDelta:number;peakRssDelta:number;responseBytes:number};
export function percentiles(values:number[]){const xs=[...values].sort((a,b)=>a-b);return {p50:xs[Math.ceil(xs.length*.5)-1],p95:xs[Math.ceil(xs.length*.95)-1]};}
async function measure(root:string,fn:()=>Promise<unknown>):Promise<Measurement>{
 global.gc?.();const before=process.memoryUsage();let peak=before.rss,readAttempts=0,readFiles=0,readBytes=0,directoryReads=0;
 const originalRead=fs.readFile,originalDir=fs.readdir;
 const inside=(v:unknown)=>{const rel=path.relative(root,path.resolve(String(v)));return !rel.startsWith("..")&&!path.isAbsolute(rel);};
 fs.readFile=(async(...args:Parameters<typeof fs.readFile>)=>{const tracked=inside(args[0]);if(tracked)readAttempts++;const result=await Reflect.apply(originalRead,fs,args);if(tracked){readFiles++;readBytes+=Buffer.byteLength(result);}return result;}) as typeof fs.readFile;
 fs.readdir=(async(...args:Parameters<typeof fs.readdir>)=>{if(inside(args[0]))directoryReads++;return Reflect.apply(originalDir,fs,args);}) as typeof fs.readdir;
 const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},10),start=performance.now();
 try{const result=await fn(),end=process.memoryUsage();peak=Math.max(peak,end.rss);return {ms:performance.now()-start,readAttempts,readFiles,readBytes,directoryReads,rssDelta:end.rss-before.rss,heapDelta:end.heapUsed-before.heapUsed,peakRssDelta:peak-before.rss,responseBytes:Buffer.byteLength(JSON.stringify(result))};}
 finally{clearInterval(timer);fs.readFile=originalRead;fs.readdir=originalDir;}
}
export async function benchmarkScoutAccuracy(sizes:number[],repeats=3){
 const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("benchmark forbids external requests");};
 process.stdout.write(JSON.stringify({environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemory:os.totalmem(),gc:!!global.gc,repeats,fixture:"synthetic: 1 candidate/report, 25 symbols, 4 overlapping as-of dates; app-cold, OS filesystem cache not flushed"}})+"\n");
 try{for(const size of sizes){
  process.stdout.write(JSON.stringify({stage:"fixture",size})+"\n");const fixture=await scoutScaleFixture(size);
  try{
   const cold:Measurement[]=[],warm:Measurement[]=[],page:Measurement[]=[];
   for(let run=0;run<repeats;run++){
    const service=new Service(fixture.root,"demo",false),call=(page=1)=>scoutAccuracy(service,{page,pageSize:1},fixture.now,{persist:false});
    cold.push(await measure(fixture.root,()=>call()));warm.push(await measure(fixture.root,()=>call()));page.push(await measure(fixture.root,()=>call(2)));
    process.stdout.write(JSON.stringify({stage:"sample",size,run,cold:cold.at(-1),warm:warm.at(-1),page:page.at(-1)})+"\n");
   }
   // Integrity probes use the same cached service and mutate temporary originals only.
   const service=new Service(fixture.root,"demo",false),call=()=>scoutAccuracy(service,{pageSize:1},fixture.now,{persist:false});
   const before=await call();await fixture.append(size);const added=await call();
   if(added.totalReports!==before.totalReports+1)throw Error("stale cache after addition");
   const report=fixture.lastReport,key=`research/scout/reports/${report.reportId}/original.json`;
   await fixture.json(key,{...report,inputHash:"0".repeat(64)});
   let rejected=false;try{await call();}catch{rejected=true;}if(!rejected)throw Error("tampered original accepted");
   await fixture.json(key,report);await fs.unlink(fixture.s.store.path(fixture.lastForecast));
   const deleted=await call();if(deleted.totalReports!==before.totalReports)throw Error("stale cache after deletion");
   process.stdout.write(JSON.stringify({stage:"result",size,cold:percentiles(cold.map(m=>m.ms)),warm:percentiles(warm.map(m=>m.ms)),page:percentiles(page.map(m=>m.ms)),samples:{cold,warm,page},integrity:{addition:true,tamperRejected:true,deletion:true}})+"\n");
  }finally{await fixture.cleanup();}
 }}finally{globalThis.fetch=fetch;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const sizes=(process.argv[2]??"100,1000,5000,10000").split(",").map(Number),repeats=Number(process.argv[3]??3);
 if(sizes.some(n=>![100,1000,5000,10000].includes(n))||!Number.isInteger(repeats)||repeats<3||repeats>10)throw Error("invalid benchmark parameters");
 await benchmarkScoutAccuracy(sizes,repeats);
}
