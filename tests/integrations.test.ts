import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JQuants, syncMemories, syncWarning, verifyMemoryBinding } from "../packages/integrations/index";
import { Store } from "../packages/storage/index";
const immediate = { wait: async () => {}, deferUntil: async () => {} };
it("5桁と英数字コード、ページ送り、nullを保持する", async () => {
  const row = {
    Code: "130A0",
    Date: "2026-10-09",
    C: null,
    AdjC: null,
    AdjVo: null,
    AdjFactor: 1,
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [row], pagination_key: "next" })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { ...row, Date: "2026-10-08", C: 100, AdjC: 100, AdjVo: 1000 },
          ],
        }),
      ),
    );
  const p = new JQuants("fake", fetcher, { gate: immediate });
  const bars = await p.daily("130A0", "2026-10-08", "2026-10-09");
  expect(bars[0].close).toBeNull();
  expect(bars[0].providerCode).toBe("130A0");
  expect(fetcher.mock.calls[1][0]).toContain("pagination_key=next");
  expect(fetcher.mock.calls[0][1].headers["x-api-key"]).toBe("fake");
});
it("送信結果不明を再起動後も同じ受付キーで照合し、確定失敗と未発見を分ける", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-recovery-")), store = new Store(root);
  try {
    await store.write("memories/user.json", { recordId: "user", active: true, kind: "user_memory", namespace: "profile", text: "keep" });
    const remember = vi.fn().mockRejectedValueOnce(Error("connection lost")).mockResolvedValue({ job_id: "job" });
    const status = vi.fn().mockResolvedValue({ job_id: "job", status: "failed" });
    const provider = { remember, getRememberStatus: status, waitForRememberJob: vi.fn(), recall: vi.fn() };
    const first = await syncMemories(store, provider, false);
    expect(first.uncertain).toBe(1);
    expect(syncWarning(first)).toContain("結果不明 1件");
    const persisted = await store.read("sync/user.json");
    expect(persisted.idempotencyKey).toBeTruthy();
    const restarted = new Store(root);
    expect((await syncMemories(restarted, provider, false)).failed).toBe(1);
    expect(remember.mock.calls[0][2]).toEqual(remember.mock.calls[1][2]);
    expect((await restarted.read("sync/user.json"))).toMatchObject({ status: "failed", terminal: true, errorCode: "JOB_FAILED" });
    await syncMemories(restarted, provider, false);
    expect(remember).toHaveBeenCalledTimes(2);
    await store.write("sync/user.json", { status: "accepted", jobId: "missing" });
    status.mockResolvedValue({ job_id: "missing", status: "not_found" });
    expect((await syncMemories(store, provider, false)).uncertain).toBe(1);
    expect((await store.read("sync/user.json"))).toMatchObject({ status: "uncertain", errorCode: "JOB_NOT_FOUND" });
    expect(provider.waitForRememberJob).not.toHaveBeenCalled();
    await store.write("sync/user.json", { status: "accepted", jobId: "partially-uploaded" });
    status.mockResolvedValue({ job_id: "partially-uploaded", status: "failed", blob_id: "paid-blob" });
    await syncMemories(store, provider, false);
    expect(await store.read("sync/user.json")).toMatchObject({ status: "failed", blobId: "paid-blob", terminal: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("認証拒否は設定修正後に同じキーで再試行し、旧結果不明の送信は再送しない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-auth-")), store = new Store(root);
  try {
    await store.write("memories/user.json", { recordId: "user", active: true, kind: "user_memory", namespace: "profile", text: "keep" });
    const provider = { remember: vi.fn().mockRejectedValueOnce(Object.assign(Error("sensitive error body"), { status: 401 })).mockResolvedValue({ job_id: "job" }), waitForRememberJob: vi.fn().mockResolvedValue({ blob_id: "blob" }), recall: vi.fn() };
    expect((await syncMemories(store, provider, false)).failed).toBe(1);
    expect(await store.read("sync/user.json")).toMatchObject({ status: "failed", errorCode: "HTTP_401" });
    expect(JSON.stringify(await store.read("sync/user.json"))).not.toContain("sensitive");
    expect((await syncMemories(store, provider, false)).synced).toBe(1);
    expect(provider.remember.mock.calls[0][2]).toEqual(provider.remember.mock.calls[1][2]);
    await store.write("sync/user.json", { status: "submitting" });
    await syncMemories(store, provider, false);
    await syncMemories(store, provider, false);
    expect(provider.remember).toHaveBeenCalledTimes(2);
    expect(await store.read("sync/user.json")).toMatchObject({ status: "uncertain" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("旧レシートはowner・名前空間・blobを照合してから保存先を関連付ける", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-binding-")), store = new Store(root);
  const oldOwner = process.env.OWNER_ADDRESS;
  try {
    process.env.OWNER_ADDRESS = "0x123";
    const memory = { namespace: "stock-memory:v1:profile" };
    const state = { status: "synced", jobId: "job", blobId: "blob" };
    await store.write("sync/user.json", state);
    const job = { job_id: "job", status: "done", owner: "0x123", namespace: memory.namespace, blob_id: "blob" };
    const provider = { environmentBinding: "verified-env", getRememberStatus: vi.fn().mockResolvedValue({ ...job, owner: "0x999" }), remember: vi.fn(), recall: vi.fn(), waitForRememberJob: vi.fn() };
    await expect(verifyMemoryBinding(store, "sync/user.json", { ...state }, memory, provider)).rejects.toThrow();
    expect((await store.read("sync/user.json")).environmentBinding).toBeUndefined();
    provider.getRememberStatus.mockResolvedValue({ ...job, namespace: "different" });
    await expect(verifyMemoryBinding(store, "sync/user.json", { ...state }, memory, provider)).rejects.toThrow();
    provider.getRememberStatus.mockResolvedValue({ ...job, blob_id: "other" });
    await expect(verifyMemoryBinding(store, "sync/user.json", { ...state }, memory, provider)).rejects.toThrow();
    provider.getRememberStatus.mockResolvedValue(job);
    await verifyMemoryBinding(store, "sync/user.json", { ...state }, memory, provider);
    expect(await store.read("sync/user.json")).toMatchObject({ environmentBinding: "verified-env", namespace: memory.namespace });
  } finally {
    if (oldOwner === undefined) delete process.env.OWNER_ADDRESS; else process.env.OWNER_ADDRESS = oldOwner;
    await rm(root, { recursive: true, force: true });
  }
});
it("429を再試行する", async () => {
  vi.useFakeTimers();
  const row = {
    Code: "72030",
    Date: "2026-10-09",
    C: 100,
    AdjC: 100,
    AdjVo: 1000,
    AdjFactor: 1,
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "1" } }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [row] })));
  const pending = new JQuants("fake", fetcher, { gate: immediate }).daily(
    "72030",
    "2026-10-09",
    "2026-10-09",
  );
  await vi.runAllTimersAsync();
  expect(await pending).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
it("受付と完了を区別し、既知jobを再送せず外部送信禁止を適用", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stock-sync-")),
    store = new Store(root);
  try {
    await store.write("memories/user.json", {
      recordId: "user",
      kind: "user_memory",
      active: true,
      namespace: "profile",
      text: "方針",
    });
    await store.write("memories/market.json", {
      recordId: "market",
      kind: "market_snapshot",
      active: true,
      text: "株価",
    });
    const p = {
      remember: vi.fn().mockResolvedValue({ job_id: "job-1" }),
      waitForRememberJob: vi
        .fn()
        .mockRejectedValueOnce(Error("timeout"))
        .mockResolvedValue({ blob_id: "blob-1" }),
      recall: vi.fn(),
    };
    await syncMemories(store, p, false);
    expect(await store.read("sync/user.json")).toMatchObject({
      status: "accepted",
      jobId: "job-1",
    });
    // A completed polling response without a blob must never be called saved.
    await store.write("sync/user.json", { status: "accepted", jobId: "job-1" });
    p.waitForRememberJob.mockResolvedValueOnce({ blob_id: "" });
    await syncMemories(store, p, false);
    expect(await store.read("sync/user.json")).toMatchObject({
      status: "accepted",
    });
    expect(p.remember).toHaveBeenCalledTimes(1);
    await syncMemories(store, p, false);
    expect(p.remember).toHaveBeenCalledTimes(1);
    expect(await store.read("sync/user.json")).toMatchObject({
      status: "synced",
      blobId: "blob-1",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
