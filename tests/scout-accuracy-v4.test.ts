import { expect,it,vi } from "vitest";
import { readFile,writeFile,stat,utimes,unlink } from "node:fs/promises";
import { scoutScaleFixture } from "../fixtures/scout-accuracy-scale";
import { cachedScoutAccuracy } from "../apps/api/src/scout-accuracy-cache";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { Service } from "../apps/api/src/service";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createScoutOutcomeCache,scoutOutcome } from "../apps/api/src/bottom-scout-journal";
import { scoutAccuracyBatch } from "../apps/api/src/scout-accuracy-io";
import { scoutReviewSchema } from "../packages/core/bottom-scout-schema";
import { hash } from "../packages/integrations/adjusted-series";

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

it("遅い一覧読込があっても他の入力を処理し、同時数16と結果順を維持する",async()=>{
 let release!:()=>void,active=0,peak=0,started17!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started17=r;});
 const task=scoutAccuracyBatch(Array.from({length:40},(_,i)=>i),async i=>{
  active++;peak=Math.max(peak,active);
  try{if(i===17)started17();if(i===0)await gate;return i;}
  finally{active--;}
 });
 try{await ready;expect(peak).toBeLessThanOrEqual(16);}
 finally{release();}
 expect(await task).toEqual(Array.from({length:40},(_,i)=>i));
});

it("読込エラー時も開始済み処理の完了を待ってから拒否する",async()=>{
 let release!:()=>void,settled=false;
 const gate=new Promise<void>(r=>{release=r;});
 const task=scoutAccuracyBatch([0,1,2],async i=>{if(i===0)await gate;if(i===1)throw Error("fixture error");return i;});
 const result=task.then(()=>{settled=true;},error=>{settled=true;return error;});
 await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
 release();expect((await result).message).toBe("fixture error");
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

it("計算入力と別のバイト内容から指紋だけを作って信用しない",async()=>{
 const f=await scoutScaleFixture(2);let computes=0;
 try{
  await f.json("probe.json",{n:1});const read=f.s.store.read.bind(f.s.store);
  f.s.store.read=async<T>(key:string,fallback?:unknown)=>key==="probe.json"?{n:999} as unknown as T:read<T>(key,fallback);
  await expect(cachedScoutAccuracy(f.s,"bind",f.now,async s=>{computes++;return s.store.read("probe.json");})).rejects.toThrow("集計中");
  expect(computes).toBe(3);
 }finally{await f.cleanup();}
});

it("空白だけの変更も再計算し、原本のバイトを正規化して上書きしない",async()=>{
 const f=await scoutScaleFixture(2);let computes=0;
 try{
  await f.json("probe.json",{n:1});const call=()=>cachedScoutAccuracy(f.s,"format",f.now,async s=>{computes++;return s.store.read("probe.json");});
  await call();await writeFile(f.s.store.path("probe.json"),'{ "n": 1 }');
  expect(await call()).toEqual({n:1});expect(computes).toBe(2);
  expect(await readFile(f.s.store.path("probe.json"),"utf8")).toBe('{ "n": 1 }');
  expect(JSON.parse((await f.s.store.readBytes("probe.json")).toString("utf8"))).toEqual({n:1});
  await expect(f.s.store.readBytes("../outside.json")).rejects.toThrow("保存パス");
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

it("予測追加・評価revision追加を検出し、未来の別評価を現在の成績へ混ぜない",async()=>{
 const f=await scoutScaleFixture(2),history=vi.spyOn(f.s,"history");
 try{
  const call=()=>scoutAccuracy(f.s,{},f.now,{persist:false}),before=await call();
  history.mockClear();await call();expect(history).not.toHaveBeenCalled();
  const extra=scoutReviewSchema.parse({...await f.s.store.read(f.lastEvaluation),notes:["future fixture evaluation"],evaluatedAt:new Date(f.now.getTime()+3600_000).toISOString()});
  const {evaluationId,evaluatedAt,...identity}=extra;void evaluationId;void evaluatedAt;
  extra.evaluationId=hash(identity);
  await f.json(`research/scout/evaluations/${extra.reportId}/${extra.evaluationId}/original.json`,extra);
  expect(await call()).toEqual(before);expect(history).toHaveBeenCalled();
  history.mockClear();await f.append(2);
  expect((await call()).totalReports).toBe(before.totalReports+1);expect(history).toHaveBeenCalled();
 }finally{history.mockRestore();await f.cleanup();}
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

it("別プロセスの手動編集を検出し、再起動したプロセスでも変更後の内容を確認する",async()=>{
 const f=await scoutScaleFixture(2),run=promisify(execFile);
 try{
  await f.json("probe.json",{n:1});
  const call=()=>cachedScoutAccuracy(f.s,"process",f.now,s=>s.store.read("probe.json"));
  expect(await call()).toEqual({n:1});
  const child=(action:string)=>run(process.execPath,["--import","tsx",path.resolve("fixtures/scout-accuracy-process.ts"),f.root,action]);
  expect(JSON.parse((await child("manual")).stdout)).toEqual({n:2});
  expect(await call()).toEqual({n:2});
  expect(JSON.parse((await child("read")).stdout)).toEqual({n:2});
 }finally{await f.cleanup();}
});

it("共有outcomeはcutoff・期間・カレンダー・安値要件・別revision系列を混同しない",async()=>{
 const f=await scoutScaleFixture(2);
 try{
  const bars=await f.s.history("10000"),calendar=await f.s.store.read<Array<{date:string;open:boolean}>>("market/calendar.json"),asOf=f.lastReport.asOf;
  const cached=createScoutOutcomeCache();
  for(const horizon of [5,10,20])for(const intraday of [true,false])for(const now of [new Date(`${asOf}T09:00:00Z`),f.now]){
   expect(cached(bars,asOf,horizon,calendar,now,intraday)).toEqual(scoutOutcome(bars,asOf,horizon,calendar,now,intraday));
   const other=bars.map(b=>({...b,revisionId:`changed-${b.revisionId}`}));
   expect(cached(other,asOf,horizon,calendar,now,intraday)).toEqual(scoutOutcome(other,asOf,horizon,calendar,now,intraday));
  }
  const changed=calendar.filter(d=>d.date!==asOf);
  expect(cached(bars,asOf,5,changed,f.now)).toEqual(scoutOutcome(bars,asOf,5,changed,f.now));
  const a=cached(bars,asOf,5,calendar,f.now);a.revisionIds.push("mutated");
  expect(cached(bars,asOf,5,calendar,f.now).revisionIds).not.toContain("mutated");
  expect(Object.isFrozen(bars)).toBe(true);expect(Object.isFrozen(bars[0])).toBe(true);
  expect(()=>{bars[0].revisionId="in-place revision";}).toThrow();
 }finally{await f.cleanup();}
});
