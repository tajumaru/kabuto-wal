import { it,expect,vi } from "vitest";
import { unlink } from "node:fs/promises";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { diagnoseScoutAccuracy } from "../scripts/diagnose-scout-accuracy";
import { percentiles } from "../scripts/benchmark-scout-accuracy";
import { scoutAccuracyBatch } from "../apps/api/src/scout-accuracy-io";

it("scale runnerのp50/p95は実標本から算出する",()=>{
 expect(percentiles([10,30,20])).toEqual({p50:20,p95:30});
});
it("精度検証I/Oは16件以内で順序を保ち、失敗時にも開始済み処理を待つ",async()=>{
 let active=0,peak=0,finished=0,started=0;
 const values=Array.from({length:40},(_,i)=>i);
 const out=await scoutAccuracyBatch(values,async i=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,(i%3)+1));active--;return i;});
 expect(out).toEqual(values);expect(peak).toBeLessThanOrEqual(16);
 await expect(scoutAccuracyBatch(values,async i=>{
  started++;active++;peak=Math.max(peak,active);
  try{await new Promise(r=>setTimeout(r,1));if(i===2)throw Error("fixture");}
  finally{finished++;active--;}
 })).rejects.toThrow("fixture");
 // A streaming pool may start replacement work before an error is observed.
 // Its safety contract is bounded concurrency and draining every started task.
 expect(peak).toBeLessThanOrEqual(16);expect(finished).toBe(started);expect(active).toBe(0);
 const completed=finished;await new Promise(r=>setTimeout(r,5));expect(finished).toBe(completed);
});
it("保存評価を持つ人工履歴で追加・原本改変・欠損を検出し、診断は保存しない",async()=>{
 const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("forbidden")),fixture=await scoutScaleFixture(4);
 try{
  const {s,now}=fixture,call=()=>scoutAccuracy(s,{pageSize:1},now,{persist:false});
  expect((await call()).totalReports).toBe(4);expect((await call()).totalReports).toBe(4);
  await fixture.append(4);expect((await call()).totalReports).toBe(5);
  const evaluation=await s.store.read(fixture.lastEvaluation);
  await fixture.json(fixture.lastEvaluation,{...evaluation,rows:[]});
  await expect(call()).rejects.toThrow();
  await fixture.json(fixture.lastEvaluation,evaluation);
  const reportKey=`research/scout/reports/${fixture.lastReport.reportId}/original.json`;
  await unlink(s.store.path(reportKey));await expect(call()).rejects.toThrow();
  await fixture.json(reportKey,fixture.lastReport);
  await unlink(s.store.path(fixture.lastForecast));expect((await call()).totalReports).toBe(4);
  const before=await s.store.files("research"),diagnostic=await diagnoseScoutAccuracy(fixture.root,"demo",now);
  expect(diagnostic).toMatchObject({status:"confirmed",readOnly:true,persistedEvaluations:0});
  const live=diagnostic.counts?.find(c=>c.recordingMode==="live"),research=diagnostic.counts?.find(c=>c.recordingMode==="research");
  expect(live?.top).toHaveLength(9);expect(live?.groups.every(g=>g.confidence95!==null)).toBe(true);
  expect(research?.availability).toBe("no-predictions");expect(research?.message).toContain("検証対象なし");
  expect(research?.groups.every(g=>g.hitRate===null&&g.confidence95===null)).toBe(true);
  expect(live?.warnings.join(" ")).toContain("選択バイアス");expect(live?.warnings.join(" ")).toContain("入力revision");
  expect(await s.store.files("research")).toEqual(before);expect(network).not.toHaveBeenCalled();
 }finally{await fixture.cleanup();network.mockRestore();}
});
