import { expect,it,vi } from "vitest";
import { readFile,writeFile,stat,utimes,unlink } from "node:fs/promises";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { cachedScoutAccuracy } from "../apps/api/src/scout-accuracy-cache";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { Service } from "../apps/api/src/service";

it("検証済みの入力を再確認するときJSONを再解析せず、内容の全読込は続ける",async()=>{
 const f=await scoutScaleFixture(2);let calls=0;
 try{
  await f.json("probe.json",{n:1});
  const call=()=>cachedScoutAccuracy(f.s,"bytes",f.now,async s=>{calls++;return s.store.read("probe.json");});
  await call();const parse=vi.spyOn(JSON,"parse");
  try{expect(await call()).toEqual({n:1});expect(parse).not.toHaveBeenCalled();expect(calls).toBe(1);}
  finally{parse.mockRestore();}
 }finally{await f.cleanup();}
});

it("同サイズ・同mtimeの手動編集を検出する",async()=>{
 const f=await scoutScaleFixture(2);let calls=0;
 try{
  await f.json("probe.json",{n:1});const file=f.s.store.path("probe.json"),before=await stat(file);
  const call=()=>cachedScoutAccuracy(f.s,"mtime",f.now,async s=>{calls++;return s.store.read("probe.json");});
  await call();await writeFile(file,'{"n":2}');await utimes(file,before.atime,before.mtime);
  expect((await stat(file)).size).toBe(before.size);expect(await call()).toEqual({n:2});expect(calls).toBe(2);
 }finally{await f.cleanup();}
});

it("欠損したindexや自己hash風の値を持つ壊れたindexを原本の代わりに信用しない",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  const a=await scoutAccuracy(f.s,{},f.now,{persist:false});
  await f.json("research/scout/accuracy-index/v1/index.json",{hash:"0".repeat(64),groups:[{hitRate:1}]});
  const b=await scoutAccuracy(new Service(f.root,"demo",false),{},f.now,{persist:false});
  expect(b).toEqual(a);
  const key=`research/scout/reports/${f.lastReport.reportId}/original.json`,body=await f.s.store.read(key);
  await f.json(key,{...body,inputHash:"0".repeat(64)});
  await expect(scoutAccuracy(new Service(f.root,"demo",false),{},f.now,{persist:false})).rejects.toThrow();
 }finally{await f.cleanup();}
});

it.each(["price","calendar","evaluation","delete"] as const)("別Serviceによる%sの変更をキャッシュに残さない",async kind=>{
 const f=await scoutScaleFixture(2),other=new Service(f.root,"demo",false);
 try{
  const before=await scoutAccuracy(f.s,{},f.now,{persist:false});
  if(kind==="price"){
   const key="prices/10000/fixture.json",bars=await other.store.read<Array<{revisionId:string}>>(key);
   await other.store.write(key,bars.map(b=>({...b,revisionId:`updated-${b.revisionId}`})));
   const after=await scoutAccuracy(f.s,{},f.now,{persist:false});expect(after).not.toEqual(before);
  }else if(kind==="calendar"){
   const days=await other.store.read<Array<{date:string;open:boolean}>>("market/calendar.json");
   await other.store.write("market/calendar.json",days.map(d=>d.date===f.lastReport.asOf?{...d,open:false}:d));
   expect(await scoutAccuracy(f.s,{},f.now,{persist:false})).not.toEqual(before);
  }else if(kind==="evaluation"){
   const raw=await readFile(other.store.path(f.lastEvaluation),"utf8");
   await writeFile(other.store.path(f.lastEvaluation),raw.replace('"methodVersion":"scout-outcome-v2"','"methodVersion":"invalid"'));
   await expect(scoutAccuracy(f.s,{},f.now,{persist:false})).rejects.toThrow();
  }else{
   await unlink(other.store.path(f.lastForecast));expect((await scoutAccuracy(f.s,{},f.now,{persist:false})).totalReports).toBe(before.totalReports-1);
  }
 }finally{await f.cleanup();}
});
