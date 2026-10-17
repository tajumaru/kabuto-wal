import { it,expect } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { createCohort,readCohort,cohortBase } from "../apps/api/src/hunter-cohort";
import { demoBars } from "../fixtures/demo";

it("完了時点の候補と対照を不変に固定し、不完全ジョブ・未来・hash改変を拒否する",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"hunter-cohort-")),service=new Service(root,"demo",false);
  try{
    await service.init();await service.store.write("prices/72030/fixture.json",demoBars("72030"));
    const engine=new HunterJobs(service),job=await engine.create({asOf:"2026-10-09",cutoff:"2026-10-09T14:59:59.999Z"});
    await expect(createCohort(service,{jobId:job.id})).rejects.toThrow("完了");
    await engine.run(job.id,{maxSymbols:1});await expect(createCohort(service,{jobId:job.id})).rejects.toThrow("完了");
    await engine.resume(job.id);await engine.run(job.id);
    const [a,b]=await Promise.all([createCohort(service,{jobId:job.id}),createCohort(service,{jobId:job.id})]);expect(b).toEqual(a);expect(a.scoringVersions.length).toBeGreaterThan(0);
    const saved=await readCohort(service,a.cohortId);expect(saved.members).toHaveLength(4);expect(saved.members.filter(m=>m.eligible)).toHaveLength(1);
    expect(saved.members.filter(m=>!m.eligible).every(m=>m.classification==="判定不能")).toBe(true);
    await expect(createCohort(service,{jobId:job.id,experiment:"prospective"})).rejects.toThrow("事前");
    await expect(createCohort(service,{jobId:job.id},new Date("2026-10-08T01:00:00.000Z"))).rejects.toThrow("時点");
    await service.store.write(`${cohortBase(a.cohortId)}/${a.shards[0].key}`,saved.members.map(m=>({...m,score:100})));
    await expect(readCohort(service,a.cohortId)).rejects.toThrow("hash");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5});}
});
