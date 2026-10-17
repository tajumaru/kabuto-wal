import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MemwalResetClient } from "../packages/integrations/memwal-reset";
import { registerMemoryReset } from "../apps/api/src/memory-reset";
import { Service } from "../apps/api/src/service";
import { syncMemories } from "../packages/integrations/index";
import { createApp } from "../apps/api/src/server";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.unstubAllEnvs(); });

it("公式のcanonical messageでEd25519署名し、GETは空body・POSTは送信JSONをハッシュする", async () => {
  const key = "01".repeat(32), keypair = Ed25519Keypair.fromSecretKey(Buffer.from(key, "hex"));
  const nonces = new Set<string>();
  const fetcher = vi.fn(async (url: any, init: any) => {
    const target = new URL(url), headers = init.headers;
    const hash = createHash("sha256").update(init.body || "").digest("hex");
    const message = `${headers["x-timestamp"]}.${init.method}.${target.pathname}${target.search}.${hash}.${headers["x-nonce"]}.0x456`;
    expect(await keypair.getPublicKey().verify(new TextEncoder().encode(message), Buffer.from(headers["x-signature"], "hex"))).toBe(true);
    expect(headers["x-public-key"]).toBe(Buffer.from(keypair.getPublicKey().toRawBytes()).toString("hex"));
    expect(headers["x-account-id"]).toBe("0x456");
    expect(headers["x-delegate-key"]).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(nonces.has(headers["x-nonce"])).toBe(false); nonces.add(headers["x-nonce"]);
    if (target.pathname === "/api/whoami") { expect(init.body).toBeUndefined(); return Response.json({ owner: "0x123", account_id: "0x456" }); }
    if (target.pathname.endsWith("/namespaces")) return Response.json(target.searchParams.has("updated_after")
      ? { namespaces: [{ name: "work", memory_count: 1 }], next_cursor: "last", has_more: false }
      : { namespaces: [{ name: "personal", memory_count: 2 }], next_cursor: "a+b/==", has_more: true });
    expect(JSON.parse(init.body)).toEqual({ namespace: "personal" });
    if (target.pathname === "/api/forget") return Response.json({ owner: "0x123", namespace: "personal", deleted: 2 });
    expect(target.pathname).toBe("/api/stats");
    return Response.json({ owner: "0x123", namespace: "personal", memory_count: 0 });
  });
  const client = new MemwalResetClient({ key, owner: "0x123", accountId: "0x456", serverUrl: "https://example.test/" }, fetcher as typeof fetch);
  await client.identity();
  expect(await client.namespaces()).toEqual([{ name: "personal", memory_count: 2 }, { name: "work", memory_count: 1 }]);
  expect(await client.forget("personal")).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("所有者不一致・残存件数を検出し、成功扱いしない", async () => {
  const config = { key: "01".repeat(32), owner: "0x123", accountId: "0x456", serverUrl: "https://example.test" };
  const wrong = new MemwalResetClient(config, vi.fn(async () => Response.json({ owner: "0x999", account_id: "0x456" })));
  await expect(wrong.identity()).rejects.toThrow("所有者");
  const remaining = new MemwalResetClient(config, vi.fn(async (url: any) => Response.json(new URL(url).pathname === "/api/forget"
    ? { owner: "0x123", namespace: "work", deleted: 2 }
    : { owner: "0x123", namespace: "work", memory_count: 1 })));
  await expect(remaining.forget("work")).rejects.toThrow("0件");
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-reset-"));
  const service = new Service(root, "live");
  const remote = { identity: vi.fn(async () => {}), namespaces: vi.fn(async () => [{ name: "kabutowal:v1:profile", memory_count: 2 }, { name: "other-app", memory_count: 3 }]), forget: vi.fn(async (ns: string) => { void ns; return 2; }) };
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => reply.code(400).send({ error: (err as Error).message }));
  registerMemoryReset(app, service, () => remote);
  cleanup.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await service.store.write("memories/existing.json", { recordId: "existing", namespace: "kabutowal:v1:profile", active: true, kind: "user_memory", text: "keep local" });
  await service.store.write("sync/existing.json", { status: "pending" });
  const preview = () => app.inject({ method: "POST", url: "/api/memory-reset/preview", payload: {} });
  const execute = (planId: string, confirmation = "検索リセット") => app.inject({ method: "POST", url: "/api/memory-reset/execute", payload: { planId, confirmation, namespaces: ["kabutowal:v1:profile", "other-app"] } });
  return { app, service, remote, preview, execute };
}

it("索引の有無は対象区分の実件数で確認し、同期中でも削除計画を作らない", async () => {
  const f = await fixture();
  await f.service.store.write("sync/existing.json", { status: "uncertain" });
  const availability = () => f.app.inject({ method: "POST", url: "/api/memory-reset/availability", payload: { memoryId: "existing" } });
  expect((await availability()).json()).toEqual({ available: true });
  f.remote.namespaces.mockResolvedValue([{ name: "kabutowal:v1:profile", memory_count: 0 }, { name: "other-app", memory_count: 3 }]);
  expect((await availability()).json()).toEqual({ available: false });
  f.remote.namespaces.mockRejectedValue(Error("offline"));
  expect((await availability()).statusCode).toBe(400);
  expect(await f.service.store.read("settings/memwal-search-reset.json", null)).toBeNull();
  expect(f.remote.forget).not.toHaveBeenCalled();
});

it("確認済みの全区分だけリセットし、既存記録の再送を止めて新しい記録は同期できる", async () => {
  const f = await fixture(), plan = (await f.preview()).json();
  expect(f.remote.forget).not.toHaveBeenCalled();
  expect((await f.execute(plan.id, "DELETE")).statusCode).toBe(400);
  const result = (await f.execute(plan.id)).json();
  expect(result.state).toBe("completed");
  expect(f.remote.forget.mock.calls.map(([ns]) => ns)).toEqual(["kabutowal:v1:profile", "other-app"]);
  expect((await f.service.store.read("memories/existing.json")).active).toBe(true);
  expect((await f.service.store.read("sync/existing.json")).searchResetAt).toBeTruthy();
  expect((await f.execute(plan.id)).statusCode).toBe(400);
  await f.service.store.write("memories/new.json", { recordId: "new", namespace: "kabutowal:v1:profile", active: true, kind: "user_memory", text: "new memory" });
  const provider = { remember: vi.fn(async (text: string, namespace: string) => { void text; void namespace; return { job_id: "job" }; }), waitForRememberJob: vi.fn(async () => ({ blob_id: "new-blob" })), recall: vi.fn() };
  await syncMemories(f.service.store, provider, true);
  expect(provider.remember).toHaveBeenCalledTimes(1);
  expect(provider.remember.mock.calls[0][0]).toContain("new memory");
});

it("選択した区分だけを削除し、未確認・重複・空の区分指定は拒否する", async () => {
  const f = await fixture(), plan = (await f.preview()).json();
  const execute = (namespaces: string[]) => f.app.inject({ method: "POST", url: "/api/memory-reset/execute", payload: { planId: plan.id, confirmation: "検索リセット", namespaces } });
  for (const names of [[], ["unknown"], ["other-app", "other-app"]]) expect((await execute(names)).statusCode).toBe(400);
  expect((await f.app.inject({ method: "POST", url: "/api/memory-reset/execute", payload: { planId: plan.id, confirmation: "検索リセット" } })).statusCode).toBe(400);
  expect(f.remote.forget).not.toHaveBeenCalled();
  expect((await execute(["other-app"])).json().state).toBe("completed");
  expect(f.remote.forget).toHaveBeenCalledExactlyOnceWith("other-app");
  expect((await f.service.store.read("sync/existing.json")).searchResetAt).toBeUndefined();
});

it("途中失敗は部分完了として保存し、成功した区分を再送しない", async () => {
  const f = await fixture(), plan = (await f.preview()).json();
  f.remote.forget.mockResolvedValueOnce(2).mockRejectedValueOnce(Error("timeout"));
  const result = (await f.execute(plan.id)).json();
  expect(result.state).toBe("partial");
  expect(result.namespaces.map((ns: any) => ns.state)).toEqual(["completed", "failed"]);
  expect((await f.service.store.read("settings/memwal-search-reset.json")).state).toBe("partial");
  expect((await f.execute(plan.id)).statusCode).toBe(400);
  expect(f.remote.forget).toHaveBeenCalledTimes(2);
  // A fresh preview reconciles the prior receipt; only unfinished scopes are resumed.
  f.remote.namespaces.mockResolvedValue([{ name: "other-app", memory_count: 3 }]);
  const resumed = (await f.preview()).json();
  expect(resumed).toMatchObject({ recovery: true, state: "prepared" });
  expect(resumed.id).not.toBe(plan.id);
  expect((await f.execute(plan.id)).statusCode).toBe(400);
  expect(resumed.namespaces.map((ns: any) => ns.state)).toEqual(["completed", "pending"]);
  const response = await f.app.inject({ method: "POST", url: "/api/memory-reset/execute", payload: { planId: resumed.id, confirmation: "検索リセット", namespaces: ["other-app"] } });
  expect(response.json().state).toBe("completed");
  expect(f.remote.forget.mock.calls.map(([ns]) => ns)).toEqual(["kabutowal:v1:profile", "other-app", "other-app"]);
});
it("リセット受付後の応答喪失は0件を確認して復旧し、再削除しない", async () => {
  const f = await fixture(), plan = (await f.preview()).json();
  f.remote.forget.mockRejectedValueOnce(Error("response lost"));
  expect((await f.execute(plan.id)).json().state).toBe("partial");
  f.remote.namespaces.mockResolvedValue([]);
  const reconciled = (await f.preview()).json();
  expect(reconciled.state).toBe("completed");
  expect(f.remote.forget).toHaveBeenCalledTimes(1);
  expect((await f.service.store.read("sync/existing.json")).searchResetAt).toBeTruthy();
});

it("記憶から開いた確認では実際の保存区分だけを返し、他区分への改変を拒否する", async () => {
  const f = await fixture();
  await f.service.store.write("sync/existing.json", { status: "synced", namespace: "other-app" });
  const plan = (await f.app.inject({ method: "POST", url: "/api/memory-reset/preview", payload: { memoryId: "existing" } })).json();
  expect(plan.namespaces.map((ns: any) => ns.name)).toEqual(["other-app"]);
  const execute = (namespaces: string[]) => f.app.inject({ method: "POST", url: "/api/memory-reset/execute", payload: { planId: plan.id, confirmation: "検索リセット", namespaces } });
  expect((await execute(["kabutowal:v1:profile"])).statusCode).toBe(400);
  expect(f.remote.forget).not.toHaveBeenCalled();
  f.remote.namespaces.mockResolvedValue([{ name: "kabutowal:v1:profile", memory_count: 100 }, { name: "other-app", memory_count: 3 }]);
  expect((await execute(["other-app"])).json().state).toBe("completed");
  expect(f.remote.forget).toHaveBeenCalledExactlyOnceWith("other-app");
});

it("対象区分がなければ空を返し、無関係な区分に切り替えない", async () => {
  const f = await fixture();
  f.remote.namespaces.mockResolvedValue([{ name: "default", memory_count: 2 }, { name: "work-log", memory_count: 2 }]);
  const plan = (await f.app.inject({ method: "POST", url: "/api/memory-reset/preview", payload: { memoryId: "existing" } })).json();
  expect(plan.namespaces).toEqual([]);
  expect((await f.app.inject({ method: "POST", url: "/api/memory-reset/execute", payload: { planId: plan.id, confirmation: "検索リセット", namespaces: ["default"] } })).statusCode).toBe(400);
  expect(f.remote.forget).not.toHaveBeenCalled();
});

it("確認後に記憶の保存区分が変わった場合と不正な記録IDを拒否する", async () => {
  const f = await fixture();
  expect((await f.app.inject({ method: "POST", url: "/api/memory-reset/preview", payload: { memoryId: "../settings" } })).statusCode).toBe(400);
  const plan = (await f.app.inject({ method: "POST", url: "/api/memory-reset/preview", payload: { memoryId: "existing" } })).json();
  await f.service.store.write("sync/existing.json", { namespace: "other-app" });
  expect((await f.execute(plan.id)).statusCode).toBe(400);
  expect(f.remote.forget).not.toHaveBeenCalled();
});

it("確認後に対象が変わった場合、未確認の区分をリセットしない", async () => {
  const f = await fixture(), plan = (await f.preview()).json();
  f.remote.namespaces.mockResolvedValue([{ name: "new-namespace", memory_count: 9 }]);
  expect((await f.execute(plan.id)).json().error).toContain("変わりました");
  expect(f.remote.forget).not.toHaveBeenCalled();
});

it("保存中や結果不明でも対象と件数を確認でき、実行は拒否する", async () => {
  const f = await fixture();
  for (const status of ["accepted", "submitting", "uncertain"]) {
    await f.service.store.write("sync/existing.json", { status, jobId: "inflight" });
    const preview = await f.app.inject({ method: "POST", url: "/api/memory-reset/preview", payload: { memoryId: "existing" } });
    expect(preview.statusCode).toBe(200);
    const plan = preview.json();
    expect(plan.namespaces).toEqual([{ name: "kabutowal:v1:profile", memory_count: 2, state: "pending" }]);
    const result = await f.app.inject({ method: "POST", url: "/api/memory-reset/execute", payload: { planId: plan.id, confirmation: "検索リセット", namespaces: ["kabutowal:v1:profile"] } });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toContain("送信中");
    expect((await f.service.store.read("sync/existing.json")).searchResetAt).toBeUndefined();
  }
  expect(f.remote.forget).not.toHaveBeenCalled();
});

it("デモでは対象確認もリセットもしない", async () => {
  const f = await fixture();
  f.service.mode = "demo";
  expect((await f.preview()).json().error).toContain("デモ");
  expect(f.remote.forget).not.toHaveBeenCalled();
});

it("実モードのリセットAPIは本人認証と同一Originを要求する", async () => {
  vi.stubEnv("OWNER_ADDRESS", "0x123"); vi.stubEnv("SESSION_SECRET", "test-secret".repeat(4));
  const root = await mkdtemp(path.join(os.tmpdir(), "reset-auth-"));
  const app = await createApp(new Service(root, "live"));
  cleanup.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  for (const action of ["preview", "execute"]) {
    expect((await app.inject({ method: "POST", url: `/api/memory-reset/${action}`, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/memory-reset/${action}`, headers: { origin: "https://other.test" }, payload: {} })).statusCode).toBe(403);
  }
});
