import { it,expect,vi } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { createCohort,readCohort } from "../apps/api/src/hunter-cohort";
import { cohortPathOutcome,evaluateCohort,cohortEvaluations } from "../apps/api/src/hunter-cohort-evaluation";
import { calendar,demoBars } from "../fixtures/demo";

it("revision選択は入力順に依存せず、cutoff内の最新時刻を採用し同順位の矛盾を拒否する",()=>{
  const rows=demoBars("72030").slice(-2),[base,target]=rows.map(b=>b.sessionDate),cutoff="2026-10-17T00:00:00.000Z";
  const old={...rows[1],availableAt:"2026-10-15T00:00:00.000Z",revisionId:"old",adjClose:100};
  const latest={...old,availableAt:"2026-10-16T00:00:00.000Z",revisionId:"new",adjClose:110};
  const future={...latest,availableAt:"2026-10-18T00:00:00.000Z",revisionId:"future",adjClose:999};
  const evaluate=(path:typeof rows)=>cohortPathOutcome(path,base,target,calendar(),cutoff);
  const a=evaluate([rows[0],latest,old,future]);
  expect(a?.targetPrice).toBe(110);
  expect(a?.inputRevisionIds).toEqual([rows[0].revisionId,"new"]);
  expect(evaluate([future,old,latest,rows[0]])).toEqual(a);
  expect(evaluate([rows[0],latest,{...latest,adjClose:111}])).toBeNull();
  expect(evaluate([rows[0],latest,{...latest,revisionId:"conflict"}])).toBeNull();
  expect(evaluate([rows[0],latest,{...latest,seriesId:"conflict"}])).toBeNull();
  expect(evaluate([rows[0],latest,{...latest,availableAt:"2026-10-16T09:00:00+09:00",adjClose:111}])).toBeNull();
  expect(evaluate([rows[0],latest,latest])).toEqual(a);
  const reordered=Object.fromEntries(Object.entries(latest).reverse()) as typeof latest;
  expect(evaluate([rows[0],latest,reordered])).toEqual(a);
  expect(evaluate([rows[0],{...latest,seriesId:"another-adjustment-series"}])).toBeNull();
  expect(evaluate([rows[0],{...latest,providerCode:"99990"}])).toBeNull();
  for(const invalid of [{adjClose:Infinity},{adjClose:NaN},{revisionId:""},{seriesId:""}])
    expect(evaluate([rows[0],{...latest,...invalid}])).toBeNull();
});

it("同一調整系列の1/5/20営業日を、欠損・利用時刻・再下落を含めて評価する",()=>{
  const bars=demoBars("72030").slice(-25),dates=bars.map(b=>b.sessionDate),base=dates[0];
  const path=bars.map((b,i)=>({...b,adjClose:i===0?100:i===1?110:i===2?90:105}));
  for(const h of [1,5,20]){
    const result=cohortPathOutcome(path,base,dates[h],calendar(),"2026-10-17T00:00:00.000Z")!;
    expect(result.actualReturn).toBeCloseTo(h===1?0.1:0.05);expect(result.relapse).toBe(h>1);expect(result.maxRise).toBeCloseTo(0.1);
    expect(result.inputRevisionIds).toHaveLength(h+1);
  }
  expect(cohortPathOutcome(path.filter((_,i)=>i!==2),base,dates[5],calendar(),"2026-10-17T00:00:00.000Z")).toBeNull();
  expect(cohortPathOutcome(path,base,dates[5],calendar(),`${dates[5]}T00:00:00.000Z`)).toBeNull();
  expect(cohortPathOutcome(path.map(b=>b.sessionDate===dates[5]?{...b,availableAt:`${dates[5]}T00:00:00-12:00`}:b),base,dates[5],calendar(),`${dates[5]}T09:00:00.000Z`)).toBeNull();
  expect(cohortPathOutcome(path.map(b=>b.sessionDate===dates[5]?{...b,availableAt:"0"}:b),base,dates[5],calendar(),"2026-10-17T00:00:00.000Z")).toBeNull();
  const split=path.map(b=>({...b,adjClose:b.adjClose!/2}));expect(cohortPathOutcome(split,base,dates[5],calendar(),"2026-10-17T00:00:00.000Z")!.actualReturn).toBeCloseTo(0.05);
});
it("評価は冪等な追加保存で、訂正価格は新revision、期限前は価格を読まない",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"cohort-eval-")),s=new Service(root,"demo",false),asOf="2026-08-10";
  try{
    await s.init();const bars=demoBars("72030");await s.store.write("prices/72030/fixture.json",bars);
    const engine=new HunterJobs(s,()=>new Date(`${asOf}T10:00:00.000Z`)),job=await engine.create({asOf,cutoff:`${asOf}T09:00:00.000Z`});await engine.run(job.id);
    const c=await createCohort(s,{jobId:job.id},new Date(`${asOf}T10:00:00.000Z`)),original=await readCohort(s,c.cohortId);
    const history=vi.spyOn(s,"history");await evaluateCohort(s,c.cohortId,new Date(`${asOf}T11:00:00.000Z`));expect(history).not.toHaveBeenCalled();history.mockRestore();
    const first=await evaluateCohort(s,c.cohortId),again=await evaluateCohort(s,c.cohortId);expect(again.evaluationIds).toEqual(first.evaluationIds);expect(first.evaluated).toBe(3);expect(first.excluded).toBe(9);
    const before=await cohortEvaluations(s,c.cohortId),dates=calendar().filter(d=>d.open&&d.date>asOf).map(d=>d.date),date=dates[4];
    await s.store.write("prices/72030/fixture.json",bars.map(b=>b.sessionDate===date?{...b,adjClose:b.adjClose!*0.8,revisionId:"corrected-fixture",availableAt:"2026-10-16T00:00:00.000Z"}:b));
    await evaluateCohort(s,c.cohortId);const after=await cohortEvaluations(s,c.cohortId);expect(after.length).toBeGreaterThan(before.length);
    expect(after.some(row=>row.inputRevisionIds.includes("corrected-fixture"))).toBe(true);
    for(const row of before)expect(after.find(saved=>saved.evaluationId===row.evaluationId)).toEqual(row);
    expect(await readCohort(s,c.cohortId)).toEqual(original);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5});}
});
