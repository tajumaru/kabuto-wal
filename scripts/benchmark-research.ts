// Offline fixture benchmark: pnpm exec tsx scripts/benchmark-research.ts
import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Service } from "../apps/api/src/service";
import { buildKabumaruResearch } from "../apps/api/src/kabumaru-research";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { recordHunterForecast,hunterId } from "../apps/api/src/hunter-journal";
import { seedHunterRaw } from "../tests/hunter-fixture";
import { researchOutcomeReport } from "../apps/api/src/kabumaru-outcomes";
import { MarketIngestion } from "../packages/integrations/market-ingestion";

const legacyPath=path.resolve("apps/api/src/benchmark-legacy-research.ts");
const baselineRef=process.env.RESEARCH_BENCHMARK_BASELINE??"536cddf",indexPath=path.resolve("apps/api/src/benchmark-legacy-index.ts"),outcomePath=path.resolve("apps/api/src/benchmark-legacy-outcomes.ts");
let baseline=execFileSync("git",["show",`${baselineRef}:apps/api/src/kabumaru-research.ts`],{encoding:"utf8"});
if(baseline.includes('"./kabumaru-record-index"')){await writeFile(indexPath,execFileSync("git",["show",`${baselineRef}:apps/api/src/kabumaru-record-index.ts`],{encoding:"utf8"}));baseline=baseline.replace('"./kabumaru-record-index"','"./benchmark-legacy-index"').replace('"research-cache-v3"','"benchmark-legacy-cache-v3"');}
if(process.env.BENCHMARK_OUTCOMES==="true")await writeFile(outcomePath,execFileSync("git",["show",`${baselineRef}:apps/api/src/kabumaru-outcomes.ts`],{encoding:"utf8"}));
await writeFile(legacyPath,baseline);
const legacy=(await import(pathToFileURL(legacyPath).href)).buildKabumaruResearch as typeof buildKabumaruResearch;
const legacyOutcomes=process.env.BENCHMARK_OUTCOMES==="true"?(await import(pathToFileURL(outcomePath).href)).researchOutcomeReport as typeof researchOutcomeReport:undefined;
const outputs:unknown[]=[];
const now=new Date("2026-10-17T01:00:00.000Z");
process.env.JQUANTS_PLAN="Light";
// Any accidental external request fails the benchmark immediately.
globalThis.fetch=async()=>{throw Error("Benchmark forbids network");};
try {
  for(const size of process.env.BENCHMARK_SIZES?process.env.BENCHMARK_SIZES.split(",").map(Number):[100,1000,10000]) {
    const root=await mkdtemp(path.join(os.tmpdir(),"research-benchmark-")),service=new Service(root,"live",false);
    try {
      await service.init();const f=await seedHunterRaw(service,160),engine=new HunterJobs(service);
      const job=await engine.create({asOf:f.asOf,from:f.from,cutoff:f.cutoff});await engine.run(job.id);
      const base=(await recordHunterForecast(service,{jobId:job.id,code:"72030"},new Date(`${f.asOf}T10:00:00.000Z`))).records[0];
      // Use direct writes only for disposable fixture setup; production Store durability is unchanged.
      for(let start=0;start<size;start+=32) await Promise.all(Array.from({length:Math.min(32,size-start)},async(_,n)=>{
        const i=start+n,id=hunterId(["benchmark",i]),code=i%100===0?"72030":i%100===1?"67580":String(10000+i%100);
        const dir=service.store.path(`predictions/${id}`);await mkdir(dir,{recursive:true});
        await writeFile(path.join(dir,"original.json"),JSON.stringify({...base,providerCode:code,predictionId:id,recordId:id}));
        await writeFile(path.join(dir,"state.json"),JSON.stringify({status:"pending"}));
        const memory={recordId:`fixture${i}`,active:true,kind:"hunter_reflection",mode:"live",providerCode:code,dataAsOf:base.dataAsOf,createdAt:base.createdAt,predictionId:id,namespace:"fixture",text:"fixture".repeat(150)};
        await mkdir(service.store.path("memories"),{recursive:true});await mkdir(service.store.path("sync"),{recursive:true});
        await writeFile(service.store.path(`memories/fixture${i}.json`),JSON.stringify(memory));
        await writeFile(service.store.path(`sync/fixture${i}.json`),JSON.stringify({status:"pending"}));
      }));
      const input={code:"72030",asOf:"2026-10-09"};
      const measure=async(fn:typeof legacy,raw:unknown)=>{const start=performance.now();await fn(service,raw,now);return +(performance.now()-start).toFixed(2);};
      const oldInitial=await measure(legacy,input),newInitial=await measure(buildKabumaruResearch,input);
      const oldRepeat:number[]=[],newRepeat:number[]=[];
      for(let n=0;n<3;n++){oldRepeat.push(await measure(legacy,input));newRepeat.push(await measure(buildKabumaruResearch,input));}
      const oldSwitch=await measure(legacy,{...input,code:"67580"}),newSwitch=await measure(buildKabumaruResearch,{...input,code:"67580"});
      await service.store.write("sync/fixture0.json",{status:"deleted"});
      const oldDelete=await measure(legacy,input),newDelete=await measure(buildKabumaruResearch,input);
      const median=(v:number[])=>[...v].sort((a,b)=>a-b)[1];
      const result={size,unit:"ms",oldInitial,newInitial,oldRepeat,newRepeat,oldSwitch,newSwitch,oldDelete,newDelete,repeatImprovementPercent:+((1-median(newRepeat)/median(oldRepeat))*100).toFixed(2)};
      let outcome:unknown;
      if(size>=1000&&process.env.BENCHMARK_OUTCOMES==="true"){
        const originalSeries=MarketIngestion.prototype.series,supplied=await new MarketIngestion(service.store,null,"Light").series("72030","2026-10-09",now.toISOString(),f.from,undefined,false);let calls=0;
        MarketIngestion.prototype.series=async()=>{calls++;return supplied;};
        try{const measureReport=async(fn:typeof researchOutcomeReport)=>{const start=performance.now();await fn(service,undefined,now);return +(performance.now()-start).toFixed(2);};
          const old=await measureReport(legacyOutcomes!),oldCalls=calls;calls=0;const fresh=await measureReport(researchOutcomeReport),newCalls=calls;calls=0;const repeat=await measureReport(researchOutcomeReport);outcome={oldMs:old,newMs:fresh,repeatMs:repeat,oldPriceReconstructions:oldCalls,newPriceReconstructions:newCalls,repeatPriceReconstructions:calls,priceSource:"mock of saved fixture series; no network"};
        }finally{MarketIngestion.prototype.series=originalSeries;}
      }
      outputs.push({...result,outcome});console.log(JSON.stringify({...result,outcome}));
    }finally{await rm(root,{recursive:true,force:true,maxRetries:5});}
  }
  await writeFile(process.env.RESEARCH_BENCHMARK_OUTPUT??"docs/research-benchmark.json",JSON.stringify({baseline:baselineRef,externalCalls:0,outputs},null,2));
}finally{await Promise.all([legacyPath,indexPath,outcomePath].map(p=>rm(p,{force:true})));}
