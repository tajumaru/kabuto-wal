import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JQuants, syncMemories } from "../packages/integrations/index";
import { Store } from "../packages/storage/index";
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
  const p = new JQuants("fake", fetcher);
  const bars = await p.daily("130A0", "2026-10-08", "2026-10-09");
  expect(bars[0].close).toBeNull();
  expect(bars[0].providerCode).toBe("130A0");
  expect(fetcher.mock.calls[1][0]).toContain("pagination_key=next");
  expect(fetcher.mock.calls[0][1].headers["x-api-key"]).toBe("fake");
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
  const pending = new JQuants("fake", fetcher).daily(
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
    expect(await store.read("sync/user.json")).toMatchObject({ status: "accepted" });
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
