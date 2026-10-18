import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import {
  runResearchJob,
  controlResearchJob,
  recoverResearchJob,
} from "../apps/api/src/research-json-worker";
it("二重workerを拒否し、中断・再開・キャンセル後も同じcheckpointから処理する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lab-worker-")),
    s = new Service(root, "demo", false),
    key = "research/lab/runs/test/checkpoint.json";
  try {
    await s.store.write(key, {
      runId: "a".repeat(64),
      status: "queued",
      processed: 0,
      total: 3,
      failed: 0,
    });
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r)),
      block = new Promise<void>((r) => (release = r)),
      seen: number[] = [];
    const first = runResearchJob(
      s,
      key,
      async (i) => {
        seen.push(i);
        entered();
        await block;
      },
      1,
    );
    await ready;
    await expect(runResearchJob(s, key, async () => {})).rejects.toThrow(
      "既に",
    );
    release();
    expect((await first).status).toBe("paused");
    await controlResearchJob(s, key, "resume");
    expect(
      (
        await runResearchJob(s, key, async (i) => {
          seen.push(i);
          await controlResearchJob(s, key, "cancel");
        })
      ).status,
    ).toBe("cancelled");
    await controlResearchJob(s, key, "resume");
    expect(
      (
        await runResearchJob(s, key, async (i) => {
          seen.push(i);
        })
      ).status,
    ).toBe("completed");
    expect(seen).toEqual([0, 1, 2]);
    expect(
      (
        await runResearchJob(s, key, async () => {
          throw Error("unexpected");
        })
      ).status,
    ).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("期限切れworkerをpausedへ復旧し、同じ入力から再開する",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"lab-worker-recover-")),s=new Service(root,"demo",false),key="research/lab/runs/test/checkpoint.json";try{await s.store.write(key,{runId:"a".repeat(64),status:"running",processed:0,total:1,failed:0,lease:{token:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",pid:process.pid,expiresAt:0}});expect((await recoverResearchJob(s,key)).status).toBe("paused");await controlResearchJob(s,key,"resume");expect((await runResearchJob(s,key,async()=>{})).status).toBe("completed");}finally{await rm(root,{recursive:true,force:true});}});
it("計算例外は欠損と区別して失敗状態になり、次回に再開できる", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lab-worker-failed-")),
    s = new Service(root, "demo", false),
    key = "research/lab/runs/test/checkpoint.json";
  try {
    await s.store.write(key, {
      runId: "a".repeat(64),
      status: "queued",
      processed: 0,
      total: 1,
      failed: 0,
    });
    const j = await runResearchJob(s, key, async () => {
      throw Error("computation-error");
    });
    expect(j.status).toBe("failed");
    expect(j.processed).toBe(0);
    expect(j.failed).toBe(1);
    await controlResearchJob(s, key, "resume");
    expect((await runResearchJob(s, key, async () => {})).status).toBe(
      "completed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
