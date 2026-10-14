import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/storage/index";
import { Service } from "../apps/api/src/service";
import { createApp } from "../apps/api/src/server";
const root = await mkdtemp(path.join(os.tmpdir(), "watch-add-check-"));
const service = new Service(root, "demo");
const app = await createApp(service);
try {
  const hashId = "a".repeat(64);
  await service.store.write(`memories/${hashId}.json`,{recordId:hashId,active:true,text:"類似分析のテスト"});
  const disabled = await app.inject({method:"PATCH",url:`/api/memories/${hashId}`,payload:{active:false}});
  assert.equal(disabled.statusCode,200);
  assert.equal((await service.store.read(`memories/${hashId}.json`)).active,false);
  const enabled = await app.inject({method:"PATCH",url:`/api/memories/${hashId}`,payload:{active:true}});
  assert.equal(enabled.statusCode,200);
  assert.equal((await service.store.read(`memories/${hashId}.json`)).active,true);
  const missing = await app.inject("/api/similar?code=72030");
  assert.equal(missing.statusCode,200);
  assert.equal(missing.json().ready,false);
  assert.match(missing.json().message,/日足を取得/);
  assert.equal((await app.inject("/api/similar?code=invalid")).statusCode,400);
  const master = (await app.inject("/api/master")).json();
  master.push({providerCode:"87660",name:"テスト用5銘柄目"});
  await service.store.write("market/master.json",master);
  await service.store.write("settings/watchlist.json", {codes:master.slice(0,4).map((s:any)=>s.providerCode)});
  const result = await app.inject({method:"POST",url:"/api/watchlist",payload:{code:master[4].providerCode}});
  assert.equal(result.statusCode,200);
  assert.equal((await app.inject("/api/watchlist")).json().length,5);
  const available = await app.inject("/api/similar?code=87660");
  assert.equal(available.statusCode,200);
  assert.equal(available.json().ready,true);
  let release!:()=>void;
  let acquired!:()=>void;
  const ready = new Promise<void>(r=>{acquired=r;});
  const hold = service.store.lock(async()=>{acquired();await new Promise<void>(r=>{release=r;});});
  await ready;
  try { await assert.rejects(new Store(root).lock(async()=>{},50),/別の処理/); }
  finally {release();await hold;}
  console.log("5銘柄目追加・混雑時制限・類似検索の未取得案内と正常検索: OK");
} finally {await app.close();await rm(root,{recursive:true,force:true});}
