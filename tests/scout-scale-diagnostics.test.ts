import { it,expect,vi } from "vitest";
import { unlink } from "node:fs/promises";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { diagnoseScoutAccuracy } from "../scripts/diagnose-scout-accuracy";
import { percentiles } from "../scripts/benchmark-scout-accuracy";

it("scale runnerのp50/p95は実標本から算出する",()=>{
 expect(percentiles([10,30,20])).toEqual({p50:20,p95:30});
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
