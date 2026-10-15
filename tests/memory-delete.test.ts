import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Service } from "../apps/api/src/service";
import { DeleteApiError, registerMemoryDelete } from "../apps/api/src/memory-delete";
import { syncMemories } from "../packages/integrations/index";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });
async function fixture() {
  vi.stubEnv("OWNER_ADDRESS", "0x123"); vi.stubEnv("MEMWAL_NETWORK", "mainnet");
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-delete-"));
  const service = new Service(root, "live");
  const id = randomUUID(), batchId = randomUUID();
  await service.store.write(`memories/${id}.json`, { recordId: id, kind: "user_memory", text: "長期の方針", active: true, namespace: "kabutowal:v1:profile" });
  await service.store.write(`sync/${id}.json`, { status: "synced", blobId: "only-this-blob" });
  const calls: { path: string; method?: string; body: any }[] = [];
  let state = "awaiting_signature", submitTimeout = false, available = true;
  const fetcher = vi.fn(async (url: any, init: any) => {
    const route = new URL(url).pathname;
    calls.push({ path: route, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (!available) return Response.json({ error: { code: "FEATURE_DISABLED", action: "NONE", retriable: false } }, { status: 404 });
    if (route.endsWith("/challenge")) return Response.json({ challengeId: "challenge", challenge: "sign exact bytes" });
    if (route.endsWith("/verify")) return Response.json({ token: "ephemeral-test-token" });
    if (route === "/api/security-deletable-blobs") return Response.json({ items: [{ blobId: "only-this-blob", state: "deletable" }, { blobId: "analysis-blob", state: "deletable" }], nextCursor: null });
    if (route.endsWith("/submit")) {
      if (submitTimeout) throw Error("timeout");
      state = "completed";
      return Response.json({ deleted: 1, digest: "tx-digest" });
    }
    if (route === "/api/security-deletions") return Response.json({ batchId, txBytes: "transaction", included: 1, excluded: [], expiresAt: "2026-10-15T00:00:00Z" });
    if (init.method === "DELETE") state = "rolled_back";
    return Response.json({ state, digest: state === "completed" ? "tx-digest" : null, blobCount: 1 });
  });
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => reply.code(e instanceof DeleteApiError ? e.statusCode : 400).send({ error: (e as Error).message, ...(e instanceof DeleteApiError ? { code: e.code } : {}) }));
  const verifySearch = vi.fn(async () => ({ state: "absent" as const, namespace: "kabutowal:v1:profile", checkedAt: new Date().toISOString(), limit: 50 }));
  registerMemoryDelete(app, service, fetcher as typeof fetch, verifySearch);
  cleanups.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const request = (action: string, body: any = { token: "ephemeral-test-token" }) => app.inject({ method: "POST", url: `/api/memories/${id}/remote-delete/${action}`, payload: body });
  return { app, service, id, batchId, calls, request, fetcher, verifySearch, state: (value: string) => { state = value; }, timeout: () => { submitTimeout = true; }, disable: () => { available = false; } };
}
it("削除取引完了後の再検索が失敗したら未確認とし、再送せず検証を再試行する", async () => {
  const f = await fixture();
  await f.request("prepare");
  f.verifySearch.mockRejectedValueOnce(Error("recall failed"));
  const submitted = (await f.request("submit", { token: "token", signature: "signature" })).json();
  expect(submitted).toMatchObject({ state: "completed", searchVerification: { state: "pending" } });
  expect((await f.request("status")).json().searchVerification.state).toBe("absent");
  expect(f.calls.filter((call) => call.path.endsWith("/submit"))).toHaveLength(1);
});
it("保存先変更時は外部APIを呼ぶ前に停止する", async () => {
  const f = await fixture();
  await f.service.store.write(`sync/${f.id}.json`, { status: "synced", blobId: "only-this-blob", environmentBinding: "different-account" });
  expect((await f.request("prepare")).json().code).toBe("ENVIRONMENT_MISMATCH");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("直接削除済みのblobでは旧V1の認証・準備・送信を外部通信前に拒否する", async () => {
  const f = await fixture();
  await f.service.store.write(`sync/${f.id}.json`, { status: "deleted", blobId: "only-this-blob", directWalrusDeletion: { state: "completed", digest: "direct-tx" } });
  for (const action of ["challenge", "verify", "prepare", "submit"]) {
    expect((await f.request(action)).json().code).toBe("BLOB_ALREADY_DELETED");
  }
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("旧V1取引がある削除済みblobは認証と結果確認を続けられるが再削除できない", async () => {
  const f = await fixture(); await f.request("prepare");
  await f.request("submit", { token: "token", signature: "signature" });
  expect((await f.request("challenge", {})).statusCode).toBe(200);
  expect((await f.request("status")).json().state).toBe("completed");
  expect((await f.request("prepare")).json().code).toBe("BLOB_ALREADY_DELETED");
  expect((await f.request("submit", { token: "token", signature: "signature" })).json().code).toBe("BLOB_ALREADY_DELETED");
  expect(f.calls.filter(call => call.path.endsWith("/submit"))).toHaveLength(1);
});
it("所有者認証を使い対象blobを1件だけ準備し、削除完了後もローカル記録を残す", async () => {
  const f = await fixture();
  expect((await f.request("challenge", {})).json().challenge).toBe("sign exact bytes");
  await f.request("verify", { challengeId: "challenge", signature: "wallet-signature" });
  expect(f.calls[1].body.address).toBe("0x123");
  expect((await f.request("prepare")).statusCode).toBe(200);
  expect(f.calls.find((c) => c.path === "/api/security-deletions")?.body).toEqual({ mode: "selection", blobIds: ["only-this-blob"] });
  expect(f.calls[2].path).toBe("/api/security-deletable-blobs");
  expect((await f.request("submit", { token: "ephemeral-test-token", signature: "tx-signature" })).json().state).toBe("completed");
  expect(await f.service.store.read(`memories/${f.id}.json`)).toMatchObject({ active: false, text: "長期の方針" });
  const sync = await f.service.store.read(`sync/${f.id}.json`);
  expect(sync).toMatchObject({ status: "deleted", remoteDeletion: { digest: "tx-digest" } });
  expect(JSON.stringify(sync)).not.toContain("ephemeral-test-token");
  expect(JSON.stringify(sync)).not.toContain("tx-signature");
});
it("結果不明でも再送せず、再起動後のステータス確認で完了を反映", async () => {
  const f = await fixture(); await f.request("prepare"); f.timeout();
  expect((await f.request("submit", { token: "token", signature: "signature" })).json().state).toBe("executing");
  expect((await f.request("prepare")).statusCode).toBe(400);
  expect((await f.request("submit", { token: "token", signature: "signature" })).statusCode).toBe(400);
  const restored = new Service(f.service.store.root, "live");
  expect((await restored.store.read(`sync/${f.id}.json`)).remoteDeletion.batchId).toBe(f.batchId);
  f.state("completed"); expect((await f.request("status")).json().state).toBe("completed");
  expect(f.calls.filter((c) => c.path.endsWith("/submit"))).toHaveLength(1);
});
it("未署名の準備を取り消してから再準備できる", async () => {
  const f = await fixture(); await f.request("prepare");
  expect((await f.request("cancel")).json().state).toBe("rolled_back");
  expect(f.calls.at(-1)?.method).toBe("DELETE");
  expect((await f.request("prepare")).statusCode).toBe(200);
});
it("API非対応、デモ、blob未確認を拒否し削除済みにしない", async () => {
  const f = await fixture(); f.disable();
  expect((await f.request("prepare")).json().error).toContain("削除APIが利用できません");
  expect((await f.service.store.read(`sync/${f.id}.json`)).status).toBe("synced");
  f.service.mode = "demo";
  expect((await f.request("prepare")).json().error).toContain("デモ");
  f.service.mode = "live";
  await f.service.store.write(`sync/${f.id}.json`, { status: "accepted" });
  expect((await f.request("prepare")).json().error).toContain("blob IDがない");
});
it("削除済み記憶を再有効化しても自動でMemWalに保存し直さない", async () => {
  const f = await fixture();
  await f.request("prepare"); await f.request("submit", { token: "token", signature: "signature" });
  const key = `memories/${f.id}.json`;
  await f.service.store.write(key, { ...(await f.service.store.read(key)), active: true });
  const provider = { remember: vi.fn(), waitForRememberJob: vi.fn(), recall: vi.fn() };
  await syncMemories(f.service.store, provider, true);
  expect(provider.remember).not.toHaveBeenCalled();
});
it("類似相場の64桁の記録IDでも正しいblobを選択する", async () => {
  const f = await fixture();
  const id = "a".repeat(64);
  await f.service.store.write(`memories/${id}.json`, { recordId: id, kind: "dejavu_memory", text: "analysis" });
  await f.service.store.write(`sync/${id}.json`, { status: "synced", blobId: "analysis-blob" });
  const response = await f.app.inject({ method: "POST", url: `/api/memories/${id}/remote-delete/prepare`, payload: { token: "test-token" } });
  expect(response.statusCode).toBe(200);
  expect(f.calls.at(-1)?.body).toEqual({ mode: "selection", blobIds: ["analysis-blob"] });
});

it("一覧を全ページ照合し、未登録なら準備APIを呼ばず、形式を断定しない", async () => {
  const f = await fixture();
  f.fetcher.mockImplementation(async (url: any, init: any) => {
    const target = new URL(url);
    expect(target.pathname).toBe("/api/security-deletable-blobs");
    expect(init.method).toBe("GET");
    expect(target.searchParams.get("state")).toContain("not_owner");
    if (!target.searchParams.has("cursor")) return Response.json({ items: [{ blobId: "unrelated", state: "deletable" }], nextCursor: "next-page" });
    return Response.json({ items: [], nextCursor: null });
  });
  const response = await f.request("prepare");
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe("BLOB_NOT_TRACKED");
  expect(response.json().error).toContain("保存先サーバーや保存時の所有者が異なる場合");
  expect(response.json().error).not.toContain("新形式の記憶を削除できません");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(await f.service.store.read(`sync/${f.id}.json`)).toEqual({ status: "synced", blobId: "only-this-blob" });
  expect((await f.service.store.read(`memories/${f.id}.json`)).active).toBe(true);
});

it.each(["not_owner", "expired", "already_deleted"])("除外理由 %s を隠さず表示し、署名用取引を返さない", async (reason) => {
  const f = await fixture();
  f.fetcher.mockImplementation(async (url: any) => new URL(url).pathname === "/api/security-deletable-blobs"
    ? Response.json({ items: [{ blobId: "only-this-blob", state: "deletable" }], nextCursor: null })
    : Response.json({ batchId: null, txBytes: null, included: 0, excluded: [{ blobId: "only-this-blob", reason }], expiresAt: null }));
  const response = await f.request("prepare");
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain(reason === "not_owner" ? "所有していない" : reason === "expired" ? "期限" : "既に存在しません");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect((await f.service.store.read(`sync/${f.id}.json`)).status).toBe("synced");
});

it.each(["not_owner", "expired", "deleting", "deleted"])("一覧の状態 %s を確認して準備・送信を止める", async (state) => {
  const f = await fixture();
  f.fetcher.mockResolvedValue(Response.json({ items: [{ blobId: "only-this-blob", state }], nextCursor: null }));
  const response = await f.request("prepare");
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe(`BLOB_${state.toUpperCase()}`);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect((await f.service.store.read(`sync/${f.id}.json`)).status).toBe("synced");
});

it("ガス不足のAPIエラーを所有者不一致や認証エラーと混同しない", async () => {
  const f = await fixture();
  f.fetcher.mockImplementation(async (url: any) => new URL(url).pathname === "/api/security-deletable-blobs"
    ? Response.json({ items: [{ blobId: "only-this-blob", state: "deletable" }], nextCursor: null })
    : Response.json({ error: { code: "SPONSOR_FUNDS_UNAVAILABLE", action: "RETRY_AFTER", retriable: true } }, { status: 503 }));
  const response = await f.request("prepare");
  expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({ code: "SPONSOR_FUNDS_UNAVAILABLE", error: expect.stringContaining("ガス残高") });
  expect((await f.service.store.read(`sync/${f.id}.json`)).remoteDeletion).toBeUndefined();
});

it("準備中に対象が消えた空バッチは再照合し、完了扱いしない", async () => {
  const f = await fixture();
  let reads = 0;
  f.fetcher.mockImplementation(async (url: any) => {
    if (new URL(url).pathname === "/api/security-deletable-blobs") return Response.json({ items: [{ blobId: "only-this-blob", state: ++reads === 1 ? "deletable" : "deleted_external" }], nextCursor: null });
    return Response.json({ batchId: null, txBytes: null, included: 0, excluded: [], expiresAt: null });
  });
  const response = await f.request("prepare");
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe("BLOB_DELETED_EXTERNAL");
  expect((await f.service.store.read(`sync/${f.id}.json`)).status).toBe("synced");
});
