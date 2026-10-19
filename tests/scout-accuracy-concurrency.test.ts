import { it,expect,vi } from "vitest";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { cachedScoutAccuracy } from "../apps/api/src/scout-accuracy-cache";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { Service } from "../apps/api/src/service";
import { unlink } from "node:fs/promises";
import { benchmarkScoutConcurrency } from "../scripts/benchmark-scout-concurrency";

it("負荷試験は明示的に呼び出す関数で、import時には実行しない",()=>{
 expect(typeof benchmarkScoutConcurrency).toBe("function");
});
it("長時間の初回計算後もページ切り替えで全集計をやり直さない",async()=>{
 const f=await scoutScaleFixture(2);let wall=0;
 const clock=vi.spyOn(Date,"now").mockImplementation(()=>wall),original=f.s.history.bind(f.s);
 const history=vi.spyOn(f.s,"history").mockImplementation(async code=>{wall=120_000;return original(code);});
 try{
  const first=await scoutAccuracy(f.s,{pageSize:1},f.now,{persist:false});history.mockClear();
  const next=await scoutAccuracy(f.s,{page:2,pageSize:1},new Date(f.now.getTime()+120_001),{persist:false});
  expect(next.groups).toEqual(first.groups);expect(history).not.toHaveBeenCalled();
 }finally{history.mockRestore();clock.mockRestore();await f.cleanup();}
});
it("計算完了からのTTLでも、計算中に到来した未来データの境界を延長しない",async()=>{
 const f=await scoutScaleFixture(2);let wall=0,calls=0;
 await f.json("boundary.json",{availableAt:new Date(f.now.getTime()+30_000).toISOString()});
 const clock=vi.spyOn(Date,"now").mockImplementation(()=>wall);
 try{
  const call=(offset:number)=>cachedScoutAccuracy(f.s,"elapsed-boundary",new Date(f.now.getTime()+offset),async s=>{
   calls++;const value=await s.store.read("boundary.json");wall+=120_000;return value;
  });
  await call(0);await call(120_001);expect(calls).toBe(2);
 }finally{clock.mockRestore();await f.cleanup();}
});

it("同一キーの進行中集計だけ共有し、返却値を分離する",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  let calls=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const compute=async()=>{calls++;await gate;return {n:calls};};
  const a=cachedScoutAccuracy(f.s,"a",f.now,compute),b=cachedScoutAccuracy(f.s,"a",f.now,compute);
  const c=cachedScoutAccuracy(f.s,"b",f.now,compute);release();
  const [x,y]=await Promise.all([a,b,c]);expect(calls).toBe(2);x.n=99;expect(y.n).not.toBe(99);
 }finally{await f.cleanup();}
});
it("キャッシュ検証の読み取り途中で内容だけが変わっても古い値を返さない",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  await f.json("probe.json",{n:1});const compute=(s:Service)=>s.store.read("probe.json");
  await cachedScoutAccuracy(f.s,"validation",f.now,compute);
  const read=f.s.store.read.bind(f.s.store);let changed=false;
  f.s.store.read=async(key,fallback)=>{const value=await read(key,fallback);if(key==="probe.json"&&!changed){changed=true;await f.json(key,{n:2});}return value;};
  expect(await cachedScoutAccuracy(f.s,"validation",f.now,compute)).toEqual({n:2});
 }finally{await f.cleanup();}
});
it("ページ・分析ID変更では系列を再構築せず、区分と保存可否は共有しない",async()=>{
 const f=await scoutScaleFixture(4,{candidates:10,symbols:20,revisions:true});
 try{
  const a=await scoutAccuracy(f.s,{pageSize:1},f.now,{persist:false});
  let histories=0;const history=f.s.history.bind(f.s);f.s.history=async code=>{histories++;return history(code);};
  const [b,c]=await Promise.all([
   scoutAccuracy(f.s,{page:2,pageSize:1},f.now,{persist:false}),
   scoutAccuracy(f.s,{reportId:f.lastReport.reportId,pageSize:2},f.now,{persist:false}),
  ]);
  expect(histories).toBe(0);expect(a.groups).toEqual(b.groups);expect(a.cumulative).toEqual(c.cumulative);
  expect(c.totalReports).toBe(1);expect(c.predictions).toHaveLength(10);
  expect(c.predictions[0].results[0].revisionIds.every(id=>!id.startsWith("older-"))).toBe(true);
  b.predictions[0].included=false;
  expect((await scoutAccuracy(f.s,{recordingMode:"research"},f.now,{persist:false})).totalReports).toBe(0);
  expect(histories).toBe(0);
 }finally{await f.cleanup();}
});
it("複数Serviceで同時保存しても同一評価原本を上書きせず予測も変えない",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  const keys=await f.s.store.files("research/scout/forecasts"),before=await Promise.all(keys.map(k=>f.s.store.read(k)));
  for(const key of await f.s.store.files("research/scout/evaluations"))await unlink(f.s.store.path(key));
  await scoutAccuracy(f.s,{},f.now,{persist:false});
  expect(await f.s.store.files("research/scout/evaluations")).toEqual([]);
  const [a,b]=await Promise.all([scoutAccuracy(f.s,{},f.now),scoutAccuracy(new Service(f.root,"demo",false),{},f.now)]);
  expect(a.groups).toEqual(b.groups);expect((await f.s.store.files("research/scout/evaluations")).length).toBe(2);
  expect(await Promise.all(keys.map(k=>f.s.store.read(k)))).toEqual(before);
 }finally{await f.cleanup();}
});
it("不安定な入力から作った評価は保存せず、失敗したPromiseも次回に残さない",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  await f.json("probe.json",{n:0});let n=0;
  const file="research/scout/evaluations/probe/original.json";
  await expect(cachedScoutAccuracy(f.s,"staged",f.now,async s=>{
   await s.store.read("probe.json");await s.store.write(file,{n},true);await f.json("probe.json",{n:++n});return n;
  },v=>v,true)).rejects.toThrow("集計中");
  expect(await f.s.store.read(file,null)).toBeNull();
  expect(await cachedScoutAccuracy(f.s,"staged",f.now,async()=>42)).toBe(42);
 }finally{await f.cleanup();}
});
it("締切を跨いだ同時要求では古い計算を共有せず、時刻の逆行も分離する",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  let calls=0;const future=new Date(f.now.getTime()+1000),earlier=new Date(f.now.getTime()-1000);
  await f.json("time.json",{next:future.toISOString()});
  const call=(now:Date)=>cachedScoutAccuracy(f.s,"time",now,async s=>({at:now.toISOString(),...await s.store.read("time.json"),calls:++calls}));
  const [a,b]=await Promise.all([call(f.now),call(future)]);
  expect(a.at).toBe(f.now.toISOString());expect(b.at).toBe(future.toISOString());
  expect((await call(earlier)).at).toBe(earlier.toISOString());expect(calls).toBe(3);
 }finally{await f.cleanup();}
});
it("同じ欠損ファイルでもfallbackを混同しない",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  const result=await cachedScoutAccuracy(f.s,"fallback",f.now,async s=>[
   await s.store.read("missing.json",null),await s.store.read("missing.json",[]),
  ]);
  expect(result).toEqual([null,[]]);
 }finally{await f.cleanup();}
});
it("計算中の原本変更を返却前に検出し、安定した入力で再計算する",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  await f.json("probe.json",{n:1});let calls=0;
  const result=await cachedScoutAccuracy(f.s,"race",f.now,async s=>{
   const value=await s.store.read("probe.json");if(++calls===1)await f.json("probe.json",{n:2});return value;
  });
  expect(result).toEqual({n:2});expect(calls).toBe(2);
 }finally{await f.cleanup();}
});
it("計算中のファイル追加を見逃さず、継続的な変更は安全に拒否する",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  let calls=0;
  await expect(cachedScoutAccuracy(f.s,"unstable",f.now,async s=>{
   const files=await s.store.files("probe");await f.json(`probe/${++calls}.json`,{});return files;
  })).rejects.toThrow();
  expect(calls).toBeLessThanOrEqual(3);
 }finally{await f.cleanup();}
});
