import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/storage/index";
let root: string, store: Store;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "stock-memory-"));
  store = new Store(root);
});
afterEach(async () => rm(root, { recursive: true, force: true }));
it("排他で更新を直列化し再起動後も保持する", async () => {
  await store.write("settings/counter.json", 0);
  await Promise.all(
    Array.from({ length: 12 }, () =>
      store.lock(async () => {
        const n = await store.read<number>("settings/counter.json");
        await store.write("settings/counter.json", n + 1);
      }),
    ),
  );
  expect(await new Store(root).read("settings/counter.json")).toBe(12);
});
it("日足取得相当の長い処理を待って別の保存処理を実行できる", async () => {
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const first = store.lock(async () => {
    acquired();
    await new Promise((resolve) => setTimeout(resolve, 5_300));
    await store.write("settings/long-job.json", "done");
  });
  await ready;
  const second = new Store(root).lock(async () => {
    expect(await store.read("settings/long-job.json")).toBe("done");
    await store.write("settings/queued.json", true);
  });
  await Promise.all([first, second]);
  expect(await store.read("settings/queued.json")).toBe(true);
}, 10_000);
it("パストラバーサルと元予測の上書きを拒否", async () => {
  expect(() => store.path("../secret")).toThrow();
  expect(() => store.path("a\\..\\secret")).toThrow();
  await store.write("predictions/id/original.json", { value: 1 }, true);
  await expect(
    store.write("predictions/id/original.json", { value: 2 }, true),
  ).rejects.toThrow();
});
it("別インスタンスにも世代を公開し、書込中の世代をキャッシュへ使わせない",async()=>{
  await store.write("sync/first.json",{status:"pending"});const first=await store.generation();expect(first).not.toBeNull();expect(await new Store(root).generation()).toBe(first);
  const rename=fs.rename.bind(fs);let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const spy=vi.spyOn(fs,"rename").mockImplementationOnce(async(a,b)=>{entered();await gate;return rename(a,b);});
  try{const pending=store.write("sync/second.json",{status:"deleted"});await ready;expect(await new Store(root).generation()).toBeNull();release();await pending;expect(await store.generation()).not.toBe(first);}finally{release();spy.mockRestore();}
});
it("暗号化バックアップで原本・salt・同期状態と索引を復元", async () => {
  await store.write("predictions/p/original.json", { predictionId: "p" });
  await store.write("commitments/p.json", { salt: "abc" });
  await store.write("sync/r.json", { jobId: "j", status: "accepted" });
  await store.write("research/results/research.json", { researchId:"fixture",evidenceIds:["immutable-reference"] },true);
  await store.rebuild();
  const payload = await store.export("long-passphrase-test");
  expect(payload).not.toContain("predictionId");
  const target = new Store(path.join(root, "restored"));
  await target.import(payload, "long-passphrase-test");
  expect(await target.read("predictions/p/original.json")).toEqual({
    predictionId: "p",
  });
  expect(await target.read("commitments/p.json")).toEqual({ salt: "abc" });
  expect(await target.read("research/results/research.json")).toEqual({researchId:"fixture",evidenceIds:["immutable-reference"]});
  expect(await target.read("sync/r.json")).toEqual({
    jobId: "j",
    status: "accepted",
  });
  expect(await target.read("indexes/predictions.json")).toEqual([
    "predictions/p/original.json",
  ]);
  await expect(target.import(payload, "incorrect-password")).rejects.toThrow();
  await target.write("research/results/research.json",{researchId:"conflict"});
  await expect(target.import(payload,"long-passphrase-test")).rejects.toThrow("競合");
});

it.runIf(process.platform === "win32")("一時的なrename競合を再試行し、恒久失敗でも旧JSONを削除しない", async () => {
  await store.write("settings/retry.json", { value: 1 });
  const error = Object.assign(Error("temporarily busy"), { code: "EPERM" });
  const transient = vi.spyOn(fs, "rename").mockRejectedValueOnce(error);
  try {
    await store.write("settings/retry.json", { value: 2 });
    expect(transient).toHaveBeenCalledTimes(2);
    expect(await store.read("settings/retry.json")).toEqual({ value: 2 });
  } finally { transient.mockRestore(); }
  const permanent = vi.spyOn(fs, "rename").mockRejectedValue(error);
  try {
    await expect(store.write("settings/retry.json", { value: 3 })).rejects.toThrow("temporarily busy");
    expect(permanent).toHaveBeenCalledTimes(6);
    expect(await store.read("settings/retry.json")).toEqual({ value: 2 });
  } finally { permanent.mockRestore(); }
});
