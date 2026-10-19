import { expect,it,vi } from "vitest";
import { unlink } from "node:fs/promises";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { Service } from "../apps/api/src/service";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { cachedScoutAccuracy } from "../apps/api/src/scout-accuracy-cache";
import { benchmarkScoutWriterLock } from "../scripts/benchmark-scout-writer-lock";
import { readFile } from "node:fs/promises";

it("writer lock計測はimport時に実行しない",()=>expect(typeof benchmarkScoutWriterLock).toBe("function"));

it("保存のない集計中に別Serviceの通常writerが待機上限内に保存できる",async()=>{
 const f=await scoutScaleFixture(2),other=new Service(f.root,"demo",false);
 let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const aggregation=cachedScoutAccuracy(f.s,"held-without-save",f.now,async()=>{entered();await gate;return 42;},v=>v,true);
 try{
  await ready;
  await other.store.lock(()=>other.store.write("jobs/probe.json",{ok:true}),40);
  expect(await other.store.read("jobs/probe.json")).toEqual({ok:true});
  release();expect(await aggregation).toBe(42);
  await other.store.lock(()=>other.store.write("jobs/probe.json",{ok:true}),1000);
  expect(await other.store.read("jobs/probe.json")).toEqual({ok:true});
 }finally{release();await aggregation;await f.cleanup();}
});

it("評価原本が全件保存済みなら初回・キャッシュ検証・ページ変更でロックを取得しない",async()=>{
 const f=await scoutScaleFixture(2),lock=vi.spyOn(f.s.store,"lock"),write=vi.spyOn(f.s.store,"write");
 try{
  await scoutAccuracy(f.s,{pageSize:1},f.now);
  await scoutAccuracy(f.s,{pageSize:1},f.now);
  await scoutAccuracy(f.s,{pageSize:1,page:2},f.now);
  expect(lock).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
 }finally{lock.mockRestore();write.mockRestore();await f.cleanup();}
});

it("persist:falseはロックも評価原本保存も行わない",async()=>{
 const f=await scoutScaleFixture(2),lock=vi.spyOn(f.s.store,"lock"),write=vi.spyOn(f.s.store,"write");
 try{
  await scoutAccuracy(f.s,{},f.now,{persist:false});await scoutAccuracy(f.s,{},f.now,{persist:false});
  expect(lock).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
 }finally{lock.mockRestore();write.mockRestore();await f.cleanup();}
});

it("別Serviceの同時集計後も保存済み評価原本のbytesを変更しない",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  const files=await f.s.store.files("research/scout/evaluations");
  const before=await Promise.all(files.map(file=>readFile(f.s.store.path(file),"utf8")));
  await Promise.all([f.s,new Service(f.root,"demo",false)].map(s=>scoutAccuracy(s,{},f.now)));
  expect(await Promise.all(files.map(file=>readFile(f.s.store.path(file),"utf8")))).toEqual(before);
  expect((await f.s.store.files("research/scout/evaluations")).sort()).toEqual(files.sort());
 }finally{await f.cleanup();}
});

it.each(["change","delete","add"] as const)("ロックを迂回した原本の%sを検出し、不安定な評価を保存しない",async mutation=>{
 const f=await scoutScaleFixture(2);let attempts=0;
 const evaluation="research/scout/evaluations/lock-investigation/original.json";
 try{
  await f.json("probe/input.json",{n:0});
  await expect(cachedScoutAccuracy(f.s,mutation,f.now,async s=>{
   await s.store.files("probe");await s.store.read("probe/input.json",null);
   await s.store.write(evaluation,{attempt:++attempts},true);
   if(mutation==="change")await f.json("probe/input.json",{n:attempts});
   if(mutation==="delete"){
    if(attempts%2)await unlink(f.s.store.path("probe/input.json"));else await f.json("probe/input.json",{n:attempts});
   }
   if(mutation==="add")await f.json(`probe/extra-${attempts}.json`,{});
   return attempts;
  },v=>v,true)).rejects.toThrow("集計中");
  expect(attempts).toBe(3);expect(await f.s.store.read(evaluation,null)).toBeNull();
 }finally{await f.cleanup();}
});
