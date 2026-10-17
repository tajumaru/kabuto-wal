import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { researchRecordIndex, researchRecords } from "../apps/api/src/kabumaru-record-index";

it("派生索引を再構築し、銘柄・日付・方式・削除世代を識別する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"research-index-")), s = new Service(root,"demo",false);
  try {
    for (let i=0;i<100;i++) await s.store.write(`memories/m${i}.json`,{ recordId:`m${i}`,kind:"hunter_reflection",providerCode:i%2?"72030":"67580",dataAsOf:"2026-10-09",createdAt:"2026-10-09T00:00:00.000Z",mode:"demo",active:true });
    const first = await researchRecordIndex(s);
    expect(first.entries).toHaveLength(100);
    expect((await researchRecords(s,"72030","2026-10-09")).memories).toHaveLength(50);
    expect((await researchRecords(s,"72030","2026-10-08")).memories).toHaveLength(0);
    expect((await researchRecords(s,"72030","2026-10-09","wrong")).memories).toHaveLength(0);
    await writeFile(s.store.path("indexes/kabumaru-records.json"),"corrupt");
    expect((await researchRecordIndex(s)).generation).toBe(first.generation);
    const corrupted = await researchRecordIndex(s); corrupted.entries=[];
    await s.store.write("indexes/kabumaru-records.json",corrupted);
    expect((await researchRecordIndex(s)).entries).toHaveLength(100);
    await s.store.write("sync/m1.json",{status:"deleted"});
    expect((await researchRecordIndex(s)).generation).not.toBe(first.generation);
    expect((await Promise.all([researchRecordIndex(s),researchRecordIndex(s)])).map(i=>i.generation)).toEqual([(await researchRecordIndex(s)).generation,(await researchRecordIndex(s)).generation]);
  } finally { await rm(root,{recursive:true,force:true,maxRetries:5}); }
});
