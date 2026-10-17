import { it,expect,vi } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { recordHunterForecast,hunterId } from "../apps/api/src/hunter-journal";
import { researchOutcomeReport } from "../apps/api/src/kabumaru-outcomes";
import { MarketIngestion } from "../packages/integrations/market-ingestion";
import { seedHunterRaw } from "./hunter-fixture";
it("1000未評価予測の系列を共有し、期限前は取得せず、評価revisionでキャッシュを失効する",async()=>{
  vi.stubEnv("JQUANTS_PLAN","Light");const root=await mkdtemp(path.join(os.tmpdir(),"outcome-report-")),s=new Service(root,"live",false),now=new Date("2026-10-17T00:00:00.000Z");
  try{
    await s.init();const f=await seedHunterRaw(s,160),engine=new HunterJobs(s),job=await engine.create({asOf:f.asOf,from:f.from,cutoff:f.cutoff});await engine.run(job.id);
    const original=await recordHunterForecast(s,{jobId:job.id,code:"72030"},new Date(`${f.asOf}T10:00:00.000Z`));
    const records=Array.from({length:1000},(_,i)=>({...original.records[i%3],predictionId:hunterId(["bulk-report",i]),evaluations:[] as unknown[]}));
    records.push({...records[0],predictionId:hunterId(["future-report"]),targetSessionDate:"2027-01-01",evaluations:[]});
    vi.spyOn(s,"predictions").mockResolvedValue(records);const series=vi.spyOn(MarketIngestion.prototype,"series");
    await researchOutcomeReport(s,undefined,now);expect(series).toHaveBeenCalledTimes(3);
    await researchOutcomeReport(s,undefined,now);expect(series).toHaveBeenCalledTimes(3);
    for(const p of records)if(p.targetSessionDate<"2027")p.evaluations.push({predictionId:p.predictionId,methodVersion:p.methodVersion,createdAt:now.toISOString(),evaluatedCutoff:now.toISOString(),actualReturn:-0.5,maxDrawdown:-0.6});
    await s.store.write("evaluations/revision-marker/value.json",{updated:true});
    const updated=await researchOutcomeReport(s,undefined,now);expect(series).toHaveBeenCalledTimes(3);expect(updated.groups.filter(g=>g.evaluated).every(g=>g.meanReturn===-0.5)).toBe(true);
  }finally{vi.restoreAllMocks();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
