import { it,expect } from "vitest";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { cachedScoutAccuracy } from "../apps/api/src/scout-accuracy-cache";

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
