import { it, expect,vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { researchRecordIndex, researchRecords } from "../apps/api/src/kabumaru-record-index";
import Fastify from "fastify";
import { registerKabumaruResearch } from "../apps/api/src/kabumaru-research";
import { deterministicResearch } from "../apps/api/src/kabumaru-explanation";

it("派生索引を再構築し、銘柄・日付・方式・削除世代を識別する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"research-index-")), s = new Service(root,"demo",false);
  try {
    for (let i=0;i<100;i++) await s.store.write(`memories/m${i}.json`,{ recordId:`m${i}`,kind:"hunter_reflection",providerCode:i%2?"72030":"67580",dataAsOf:"2026-10-09",createdAt:"2026-10-09T00:00:00.000Z",mode:"demo",active:true });
    const first = await researchRecordIndex(s);
    expect(first.entries).toHaveLength(100);
    const scan=vi.spyOn(s.store,"files");await researchRecordIndex(s);expect(scan).not.toHaveBeenCalled();scan.mockRestore();
    expect((await researchRecords(s,"72030","2026-10-09")).memories).toHaveLength(50);
    expect((await researchRecords(s,"72030","2026-10-08")).memories).toHaveLength(0);
    expect((await researchRecords(s,"72030","2026-10-09","wrong")).memories).toHaveLength(0);
    await writeFile(s.store.path("indexes/kabumaru-records.json"),"corrupt");
    expect((await researchRecordIndex(s)).generation).toBe(first.generation);
    const corrupted = await researchRecordIndex(s); corrupted.entries=[];
    await s.store.write("indexes/kabumaru-records.json",corrupted);
    expect((await researchRecordIndex(s)).entries).toHaveLength(100);
    await s.store.write("sync/m1.json",{status:"deleted"});
    const read=vi.spyOn(s.store,"read");
    expect((await researchRecordIndex(s)).generation).not.toBe(first.generation);
    expect(read.mock.calls.some(([key])=>key.startsWith("memories/"))).toBe(false);
    read.mockRestore();
    expect((await Promise.all([researchRecordIndex(s),researchRecordIndex(s)])).map(i=>i.generation)).toEqual([(await researchRecordIndex(s)).generation,(await researchRecordIndex(s)).generation]);
  } finally { await rm(root,{recursive:true,force:true,maxRetries:5}); }
});
it("研究履歴は銘柄・方式・基準日で検索し、ページ単位で返す",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"research-history-")),service=new Service(root,"demo",false),app=Fastify();
  try{
    for(let i=0;i<25;i++)await service.store.write(`research/chats/chat${String(i).padStart(2,"0")}.json`,{
      schemaVersion:1,researchId:"a".repeat(64),code:i<23?"72030":"67580",asOf:"2026-10-09",cutoff:"2026-10-09T14:59:59.999Z",analysisId:null,jobId:null,evidenceIds:[],inputRevisionIds:[],explanationMethodVersion:"kabumaru-grounded-v1",generatedAt:"2026-10-09T14:59:59.999Z",mode:"demo",dataCoverage:null,evidence:[],explanation:deterministicResearch([]),reliability:"根拠不足",warnings:[],question:"summary",provider:"deterministic",memorySearch:"local"
    });
    registerKabumaruResearch(app,service);
    const r=await app.inject({method:"GET",url:"/api/research/chats?code=72030&page=2&pageSize=20"});
    expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({total:23,page:2,pageSize:20});expect(r.json().records).toHaveLength(3);
    expect((await app.inject({method:"GET",url:"/api/research/chats?asOf=2026-10-08"})).json().records).toHaveLength(0);
    expect((await app.inject({method:"GET",url:"/api/research/chats?method=other"})).json().records).toHaveLength(0);
  }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
