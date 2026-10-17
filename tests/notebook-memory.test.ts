import { it,expect,vi,afterEach } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { readNotebook } from "../apps/api/src/kabumaru-notebook";
import { saveNotebookMemory,syncNotebookMemory,recallNotebookMemory } from "../apps/api/src/kabumaru-notebook-memory";
import { syncMemories } from "../packages/integrations/index";
import { notebookOriginalSchema } from "../packages/core/kabumaru-notebook-schema";
vi.mock("../apps/api/src/kabumaru-notebook",()=>({readNotebook:vi.fn()}));
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
it("ローカル保存を自動送信せず、明示許可と削除抑止・原本ID照合を維持する",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"notebook-memory-")),s=new Service(root,"live",false),id="a".repeat(64);
  const note=notebookOriginalSchema.parse({schemaVersion:1,notebookId:id,theme:"rsi-recovery",period:{from:"2026-08-01",to:"2026-08-10"},hypothesis:"private-hypothesis-marker",methodVersion:"kabumaru-notebook-v1",createdAt:"2026-10-16T00:00:00.000Z",mode:"research",cohortIds:["b".repeat(64)],evaluationIds:[],report:{reportId:"c".repeat(64),generatedAt:"2026-10-16T00:00:00.000Z",cohortIds:["b".repeat(64)],evaluationIds:[],groups:[],notes:[]},evidence:[],successes:[],failures:[],limitations:[],nextConditions:[]});
  vi.mocked(readNotebook).mockResolvedValue(note);
  const provider={remember:vi.fn().mockResolvedValue({job_id:"fixture-job"}),waitForRememberJob:vi.fn().mockResolvedValue({blob_id:"fixture-blob"}),recall:vi.fn().mockResolvedValue({results:[]})};
  vi.spyOn(s,"memoryProvider").mockResolvedValue(provider);
  try{
    const saved=await saveNotebookMemory(s,id);expect(provider.remember).not.toHaveBeenCalled();
    vi.stubEnv("ALLOW_MARKET_DATA_TO_MEMWAL","true");vi.stubEnv("JQUANTS_MEMWAL_RIGHTS_CONFIRMED","true");
    await syncMemories(s.store,provider,true);expect(provider.remember).not.toHaveBeenCalled();
    await expect(syncNotebookMemory(s,id,false)).rejects.toThrow("明示");
    await syncNotebookMemory(s,id,true);expect(provider.remember).toHaveBeenCalledTimes(1);
    expect(provider.remember.mock.calls[0][0]).not.toContain("private-hypothesis-marker");
    provider.recall.mockResolvedValue({results:[{text:JSON.stringify({recordId:saved.recordId,notebookId:id,claim:"guaranteed profits"}),distance:0}]});
    expect((await recallNotebookMemory(s,{theme:"rsi-recovery",confirmExternal:true})).records).toHaveLength(1);
    expect((await recallNotebookMemory(s,{theme:"rsi-recovery",confirmExternal:true,asOf:"2026-10-15T00:00:00.000Z"})).records).toHaveLength(0);
    await s.store.write(`sync/${saved.recordId}.json`,{status:"deleted"});
    expect((await saveNotebookMemory(s,id)).status).toBe("suppressed");
    expect((await recallNotebookMemory(s,{theme:"rsi-recovery",confirmExternal:true})).records).toHaveLength(0);
    await expect(syncNotebookMemory(s,id,true)).rejects.toThrow("削除");expect(provider.remember).toHaveBeenCalledTimes(1);
    vi.stubEnv("ALLOW_MARKET_DATA_TO_MEMWAL","false");const count=provider.recall.mock.calls.length;
    await expect(recallNotebookMemory(s,{theme:"rsi-recovery",confirmExternal:true})).rejects.toThrow("許可");expect(provider.recall).toHaveBeenCalledTimes(count);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5});}
});
