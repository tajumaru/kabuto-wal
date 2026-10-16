import { expect, it } from "vitest";
import { projectDejavuMemory } from "../packages/core/dejavu-memory";
import { dejavuMemorySchema, dejavuMemoriesSchema, dejavuResultSchema } from "../packages/core/dejavu-api-schema";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { Store } from "../packages/storage/index";
import { syncMemories } from "../packages/integrations/index";

it("旧記憶を読める投影を作り、ローカル原本を変更せず冗長な系列を送信しない", () => {
  const original = { kind: "dejavu_memory", active: true, recordId: "a".repeat(64), mode: "research", providerCode: "72030", namespace: "kabutowal:dejavu:v1:research:72030", createdAt: "2026-10-01T00:00:00.000Z", dataAsOf: "2026-10-01", text: "x".repeat(20000), payload: { recordId: "a".repeat(64), asOf: "2026-10-01", mode: "research", providerCode: "72030", featureVersion: "ohlcv-20-v1", examples: [{ start: "2020-01-01", end: "2020-01-31", score: 90, shape: Array(20).fill(100) }] } };
  const before = JSON.stringify(original);
  const projected = projectDejavuMemory(original);
  expect(dejavuMemorySchema.parse(projected)).toMatchObject({ recordId: original.recordId, payload: { examples: [{ score: 90 }] } });
  expect(dejavuMemorySchema.safeParse(original).success).toBe(true);
  expect(JSON.stringify(projected).length).toBeLessThan(before.length / 5);
  expect(JSON.stringify(original)).toBe(before);
  expect(projectDejavuMemory({ kind: "user_memory", text: "hello" })).toEqual({ kind: "user_memory", text: "hello" });
});
it("API境界は空配列を許可し、不正な値・null応答を拒否する", () => {
  expect(dejavuMemoriesSchema.parse({ search: "local-demo", memories: [] }).memories).toEqual([]);
  expect(dejavuMemoriesSchema.safeParse(null).success).toBe(false);
  expect(dejavuResultSchema.safeParse({ consensus: null, dna: [] }).success).toBe(false);
});
it("市場データの許可・削除状態・旧pendingTextを投影送信でも維持する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dejavu-projection-sync-"));
  const store = new Store(root);
  const memory = { kind: "dejavu_memory", active: true, recordId: "a".repeat(64), mode: "research", providerCode: "72030", namespace: "kabutowal:dejavu:v1:research:72030", createdAt: "2026-10-01T00:00:00.000Z", dataAsOf: "2026-10-01", text: "original", payload: { recordId: "a".repeat(64), asOf: "2026-10-01", mode: "research", providerCode: "72030", featureVersion: "ohlcv-20-v1", examples: [] } };
  const provider = { remember: vi.fn().mockResolvedValue({ job_id: "mock-job" }), waitForRememberJob: vi.fn().mockResolvedValue({ blob_id: "mock-blob" }), recall: vi.fn() };
  const key = `sync/${memory.recordId}.json`;
  try {
    await store.write(`memories/${memory.recordId}.json`, memory);
    await syncMemories(store, provider, false);
    expect(provider.remember).not.toHaveBeenCalled();
    for (const state of [{ status: "deleted" }, { status: "pending", searchResetAt: "2026-10-01" }]) {
      await store.write(key, state);
      await syncMemories(store, provider, true);
      expect(provider.remember).not.toHaveBeenCalled();
    }
    await store.write(key, { status: "pending" });
    expect((await syncMemories(store, provider, true)).synced).toBe(1);
    expect(JSON.parse(provider.remember.mock.calls[0][0])).toHaveProperty("transportVersion", 2);
    expect(await store.read(`memories/${memory.recordId}.json`)).toEqual(memory);
    const oldText = JSON.stringify(memory);
    await store.write(key, { status: "uncertain", idempotencyKey: "old-key", pendingText: oldText });
    await syncMemories(store, provider, true);
    expect(provider.remember.mock.calls[1][0]).toBe(oldText);
    expect(provider.remember.mock.calls[1][2]).toEqual({ idempotencyKey: "old-key" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
