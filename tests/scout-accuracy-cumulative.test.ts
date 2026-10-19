import { it,expect,vi } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { scoutFixture } from "../fixtures/bottom-scout";
import { scoutChat } from "../apps/api/src/bottom-scout-chat";
import { readScoutReport,scoutReportKey } from "../apps/api/src/bottom-scout";
import { saveScoutForecast } from "../apps/api/src/bottom-scout-forecast";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { hash } from "../packages/integrations/adjusted-series";
import { wilsonInterval } from "../packages/core/scout-accuracy";
import { diagnoseScoutAccuracy } from "../scripts/diagnose-scout-accuracy";

it("95%区間は未評価でnull、全勝でも将来の100%成功を意味しない",()=>{
 expect(wilsonInterval(0,0)).toBeNull();
 expect(wilsonInterval(5,10)?.lower).toBeCloseTo(.23659,4);
 expect(wilsonInterval(5,10)?.upper).toBeCloseTo(.76341,4);
 expect(wilsonInterval(1,1)?.lower).toBeCloseTo(.20655,4);
 expect(wilsonInterval(0,10)?.upper).toBeCloseTo(.27753,4);
 expect(()=>wilsonInterval(11,10)).toThrow();
});

it("全ページを累積し、後からの重複予測は最初の原本だけに統合し、診断では書き込まない",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"scout-cumulative-")),s=new Service(root,"demo",false);
 const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network forbidden"));
 try{
  const f=await scoutFixture(s,2),reply=await scoutChat(s,"底打ち候補を探して",undefined,f.now);
  const original=await readScoutReport(s,reply.scout.reportId!);
  for(let i=1;i<7;i++){
   const {reportId,...body}=original;void reportId;
   const report={...body,createdAt:new Date(f.now.getTime()+i*1000).toISOString()};
   const copy={...report,reportId:hash(report)};
   await s.store.write(scoutReportKey(copy.reportId),copy,true);
   await saveScoutForecast(s,copy,f.dates.map(date=>({date,open:true})));
  }
  const before=await s.store.files("research"),write=vi.spyOn(s.store,"write").mockRejectedValue(Error("read-only"));
  const now=new Date(`${f.dates[345]}T12:00:00Z`);
  const first=await scoutAccuracy(s,{page:1,pageSize:1},now,{persist:false});
  const last=await scoutAccuracy(s,{page:7,pageSize:1},now,{persist:false});
  expect(first.totalReports).toBe(7);expect(first.groups).toEqual(last.groups);
  expect(first.groups.every(g=>g.total===2&&g.evaluated===2)).toBe(true);
  expect(first.predictions.every(p=>!p.included)).toBe(true);
  expect(last.predictions.every(p=>p.included)).toBe(true);
  expect(first.cumulative).toMatchObject({predictions:14,included:2,duplicates:12});
  expect(first.regimes.every(g=>g.regime==="unknown"||g.total===0)).toBe(true);
  const history=vi.spyOn(s,"history");
  expect((await scoutAccuracy(s,{page:7,pageSize:1},now,{persist:false})).groups).toEqual(last.groups);
  expect(history).not.toHaveBeenCalled();history.mockRestore();
  expect(write).not.toHaveBeenCalled();expect(await s.store.files("research")).toEqual(before);
  const diagnostic=await diagnoseScoutAccuracy(root,"demo",now);
  expect(diagnostic).toMatchObject({status:"confirmed",readOnly:true,persistedEvaluations:0});
  expect(await s.store.files("research")).toEqual(before);
  expect(await diagnoseScoutAccuracy(path.join(root,"missing"),"live",now)).toMatchObject({status:"unconfirmed",counts:null});
  expect(network).not.toHaveBeenCalled();
 }finally{network.mockRestore();await rm(root,{recursive:true,force:true});}
});

it("100分析原本でも明細を1件に制限し、再表示は系列再構成を省略、価格更新で失効する",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"scout-scale-")),s=new Service(root,"demo",false);
 try{
  const f=await scoutFixture(s,1),reply=await scoutChat(s,"底打ち候補を探して",undefined,f.now);
  const original=await readScoutReport(s,reply.scout.reportId!);
  for(let i=1;i<100;i++){
   const {reportId,...body}=original;void reportId;
   const report={...body,createdAt:new Date(f.now.getTime()+i*1000).toISOString()};
   const copy={...report,reportId:hash(report)};
   await s.store.write(scoutReportKey(copy.reportId),copy,true);
   await saveScoutForecast(s,copy,f.dates.map(date=>({date,open:true})));
  }
  const now=new Date(`${f.dates[345]}T12:00:00Z`),start=performance.now();
  const result=await scoutAccuracy(s,{pageSize:1},now,{persist:false}),firstMs=performance.now()-start;
  const again=performance.now(),history=vi.spyOn(s,"history");
  expect((await scoutAccuracy(s,{pageSize:1},now,{persist:false})).groups).toEqual(result.groups);
  const repeatMs=performance.now()-again;expect(history).not.toHaveBeenCalled();
  expect(result.predictions).toHaveLength(1);expect(result.cumulative.predictions).toBe(100);expect(result.cumulative.included).toBe(1);
  process.stdout.write(JSON.stringify({fixtureReports:100,firstMs,repeatMs,responseBytes:Buffer.byteLength(JSON.stringify(result))})+"\n");
  const code=f.master[0].providerCode;await s.store.write(`prices/${code}/fixture.json`,[]);
  expect((await scoutAccuracy(s,{pageSize:1},now,{persist:false})).groups.every(g=>g.unavailable===1)).toBe(true);
  expect(history).toHaveBeenCalled();history.mockRestore();
 }finally{await rm(root,{recursive:true,force:true});}
},30_000);
