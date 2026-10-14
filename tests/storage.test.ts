import { it, expect, beforeEach, afterEach } from "vitest";
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
it("暗号化バックアップで原本・salt・同期状態と索引を復元", async () => {
  await store.write("predictions/p/original.json", { predictionId: "p" });
  await store.write("commitments/p.json", { salt: "abc" });
  await store.write("sync/r.json", { jobId: "j", status: "accepted" });
  await store.rebuild();
  const payload = await store.export("long-passphrase-test");
  expect(payload).not.toContain("predictionId");
  const target = new Store(path.join(root, "restored"));
  await target.import(payload, "long-passphrase-test");
  expect(await target.read("predictions/p/original.json")).toEqual({
    predictionId: "p",
  });
  expect(await target.read("commitments/p.json")).toEqual({ salt: "abc" });
  expect(await target.read("sync/r.json")).toEqual({
    jobId: "j",
    status: "accepted",
  });
  expect(await target.read("indexes/predictions.json")).toEqual([
    "predictions/p/original.json",
  ]);
  await expect(target.import(payload, "incorrect-password")).rejects.toThrow();
});
