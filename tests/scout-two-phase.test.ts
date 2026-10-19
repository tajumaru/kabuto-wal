import { expect,it,vi } from "vitest";
import { unlink,readFile } from "node:fs/promises";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { Service } from "../apps/api/src/service";
import { cachedScoutAccuracy } from "../apps/api/src/scout-accuracy-cache";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";

it("計算と再試行はロック外、評価1件の保存はロック内だけで行う",async()=>{
 const f=await scoutScaleFixture(2),other=new Service(f.root,"demo",false);
 const lock=f.s.store.lock.bind(f.s.store),write=f.s.store.write.bind(f.s.store);
 let held=false,computes=0,writes=0;
 f.s.store.lock=(fn,wait)=>lock(async()=>{held=true;try{return await fn();}finally{held=false;}},wait);
 f.s.store.write=async(key,value,immutable)=>{expect(held).toBe(true);expect(immutable).toBe(true);writes++;await write(key,value,immutable);};
 try{
  await f.json("probe/input.json",{n:0});
  const result=await cachedScoutAccuracy(f.s,"retry-outside",f.now,async s=>{
   expect(held).toBe(false);computes++;
   await other.store.lock(()=>other.store.write("jobs/probe.json",{}),40);
   const input=await s.store.read<{n:number}>("probe/input.json");
   await s.store.write("evaluation.json",input,true);
   if(computes===1)await f.json("probe/input.json",{n:1});
   return input;
  },v=>v,true);
  expect(result).toEqual({n:1});expect(computes).toBe(2);expect(writes).toBe(1);
 }finally{await f.cleanup();}
});

it.each(["change","add","delete"] as const)("ロック取得直前の%sを検出し、3回で拒否して仮評価を保存しない",async mutation=>{
 const f=await scoutScaleFixture(2),lock=f.s.store.lock.bind(f.s.store);
 let computes=0,locks=0;
 try{
  await f.json("probe/input.json",{n:0});
  f.s.store.lock=async(fn,wait)=>{
   locks++;
   if(mutation==="change")await f.json("probe/input.json",{n:locks});
   if(mutation==="add")await f.json(`probe/new-${locks}.json`,{});
   if(mutation==="delete"){
    if(locks%2)await unlink(f.s.store.path("probe/input.json"));else await f.json("probe/input.json",{n:locks});
   }
   return lock(fn,wait);
  };
  await expect(cachedScoutAccuracy(f.s,mutation,f.now,async s=>{
   computes++;await s.store.files("probe");const data=await s.store.read("probe/input.json",null);
   await s.store.write("evaluation.json",{data},true);return data;
  },v=>v,true)).rejects.toThrow("集計中");
  expect(computes).toBe(3);expect(locks).toBe(3);expect(await f.s.store.read("evaluation.json",null)).toBeNull();
 }finally{await f.cleanup();}
});

it("評価1件だけ不足する場合、1件をimmutableで保存し既存評価bytesを保つ",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  const existing=(await f.s.store.files("research/scout/evaluations")).filter(k=>k!==f.lastEvaluation);
  const before=await Promise.all(existing.map(k=>readFile(f.s.store.path(k),"utf8")));
  await unlink(f.s.store.path(f.lastEvaluation));
  const writes=vi.spyOn(f.s.store,"write"),locks=vi.spyOn(f.s.store,"lock");
  await scoutAccuracy(f.s,{},f.now);
  expect(writes).toHaveBeenCalledTimes(1);expect(writes.mock.calls[0][2]).toBe(true);expect(locks).toHaveBeenCalledTimes(1);
  expect(await Promise.all(existing.map(k=>readFile(f.s.store.path(k),"utf8")))).toEqual(before);
 }finally{await f.cleanup();}
});

it("ロック待機タイムアウト後は失敗Promiseを残さず再計算・保存できる",async()=>{
 const f=await scoutScaleFixture(2),other=new Service(f.root,"demo",false),lock=f.s.store.lock.bind(f.s.store);
 let release!:()=>void,entered!:()=>void,computes=0;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const holder=other.store.lock(async()=>{entered();await gate;});
 f.s.store.lock=fn=>lock(fn,40);
 const call=()=>cachedScoutAccuracy(f.s,"timeout",f.now,async s=>{computes++;await s.store.write("evaluation.json",{n:1},true);return 1;},v=>v,true);
 try{
  await ready;await expect(call()).rejects.toThrow("別の処理");expect(await f.s.store.read("evaluation.json",null)).toBeNull();
  release();await holder;expect(await call()).toBe(1);expect(computes).toBe(2);
 }finally{release();await holder;await f.cleanup();}
});

it("保存先の矛盾を全件確認し、先行する評価も部分保存しない",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  await f.json("b.json",{n:2});
  await expect(cachedScoutAccuracy(f.s,"conflict",f.now,async s=>{
   await s.store.write("a.json",{n:1},true);await s.store.write("b.json",{n:999},true);return 1;
  },v=>v,true)).rejects.toThrow("競合");
  expect(await f.s.store.read("a.json",null)).toBeNull();expect(await f.s.store.read("b.json")).toEqual({n:2});
 }finally{await f.cleanup();}
});

it("別Serviceが異なる評価時刻で同じ評価を仮生成しても先行原本を再利用する",async()=>{
 const f=await scoutScaleFixture(2),other=new Service(f.root,"demo",false);
 try{
  for(const file of await f.s.store.files("research/scout/evaluations"))await unlink(f.s.store.path(file));
  let arrived=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const writes=[vi.spyOn(f.s.store,"write"),vi.spyOn(other.store,"write")];
  for(const service of [f.s,other]){
   const lock=service.store.lock.bind(service.store);
   service.store.lock=async(fn,wait)=>{if(++arrived===2)release();await gate;return lock(fn,wait);};
  }
  const [a,b]=await Promise.all([scoutAccuracy(f.s,{},f.now),scoutAccuracy(other,{},new Date(f.now.getTime()+1))]);
  expect(a.groups).toEqual(b.groups);
  expect(a.predictions.map(p=>p.results.map(r=>r.evaluationId))).toEqual(b.predictions.map(p=>p.results.map(r=>r.evaluationId)));
  expect(writes.reduce((sum,spy)=>sum+spy.mock.calls.length,0)).toBe(2);
  expect((await f.s.store.files("research/scout/evaluations")).length).toBe(2);
 }finally{await f.cleanup();}
});
