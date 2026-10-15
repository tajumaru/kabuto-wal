import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { memwalBinding, memwalEnvironment } from "../../../packages/integrations/memwal-config";
import type { MemoryProvider } from "../../../packages/integrations/index";

export async function verifyDeletedMemory(provider: MemoryProvider | null, memory: { text: string; namespace: string }, blobId: string) {
  if (!provider) throw Error("MemWal再検索の接続設定がありません。");
  const namespace = memory.namespace;
  const result = await provider.recall({ query: memory.text, namespace, limit: 50 });
  if (!Array.isArray(result.results) || result.results.some((hit) => !hit.blob_id || hit.blob_id === blobId))
    throw Error("削除対象が検索に残っているか、blob IDを照合できません。");
  return { state: "absent" as const, namespace, checkedAt: new Date().toISOString(), limit: 50 };
}

const exclusionMessages: Record<string, string> = {
  not_owner: "この記憶の保存オブジェクトを現在のウォレットが所有していないため削除できません。",
  expired: "この記憶の保存期限が切れているか、期限が近いため削除対象から外れています。",
  already_deleted: "この記憶の保存オブジェクトは既に存在しません。今回の削除は実行していません。",
  deleted: "この記憶はMemWal側で削除済みです。今回の削除は実行していません。",
  deleted_external: "この記憶の保存オブジェクトは既に削除されています。今回の削除は実行していません。",
  deleting: "この記憶はMemWal側で別の削除処理中です。完了を待ってから確認してください。",
  deletable: "削除対象の状態が準備中に変わりました。時間をおいて再確認してください。",
};

export class DeleteApiError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(`${message}（${code}）`);
  }
}

// No owner keys or bearer tokens are written to disk. Only the batch receipt is durable.
export function registerMemoryDelete(app: FastifyInstance, service: Service, fetcher: typeof fetch = fetch,
  verifySearch = async (memory: { text: string; namespace: string }, blobId: string) => verifyDeletedMemory(await service.memoryProvider(), memory, blobId)) {
  const tokenSchema = z.string().min(1).max(16000);
  async function remote(path: string, token?: string, body?: unknown, method?: string) {
    const base = memwalEnvironment().serverUrl;
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method: method || (body === undefined ? "GET" : "POST"),
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(45000),
      });
    } catch { throw Error("MemWalに接続できません。削除結果の確認から再開してください。"); }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const code = data?.error?.code;
      const messages: Record<string, string> = {
        BATCH_NOT_FOUND: "このウォレットに対応する削除処理が見つかりません。保存先サーバーと所有者を確認してください。",
        BATCH_CONFLICT: "削除対象の状態が変わりました。対象一覧を再確認してください。",
        AUTH_INVALID_SIGNATURE: "本人確認の署名が一致しません。所有者ウォレットで再認証してください。",
        AUTH_CHALLENGE_EXPIRED: "本人確認の署名依頼が期限切れ、または使用済みです。再認証してください。",
        AUTH_TOKEN_EXPIRED: "MemWalの削除認証が期限切れです。再認証してください。",
        FEATURE_DISABLED: "このMemWalサーバーでは削除APIが利用できません。",
        ACTIVE_BATCH_LIMIT: "署名待ち・実行中の削除が上限に達しています。公式画面で既存の処理を確認してください。",
        BATCH_EXPIRED: "準備した削除処理の期限が切れています。削除結果を確認してください。",
        BATCH_ALREADY_RESOLVED: "削除処理は既に状態が変わっています。削除結果を確認してください。",
        INVALID_REQUEST: "MemWalが削除リクエストを受け付けませんでした。対象一覧とAPIの対応状況を確認してください。",
        INVALID_SIGNATURE: "削除取引の署名が一致しません。削除結果を確認してください。",
        SPONSOR_FUNDS_UNAVAILABLE: "MemWal側の削除用ガス残高が不足しています。時間をおいて再確認してください。",
        RATE_LIMITED: "MemWalへの操作回数が上限に達しています。時間をおいて再確認してください。",
        RPC_UNAVAILABLE: "MemWal側でチェーンへの接続・結果確認ができません。時間をおいて削除結果を確認してください。",
        TX_EXECUTION_FAILED: "削除取引が失敗しました。削除結果を確認してください。",
      };
      const knownCode = typeof code === "string" && Object.hasOwn(messages, code) ? code : null;
      throw new DeleteApiError(knownCode || "MEMWAL_HTTP_ERROR", knownCode ? messages[knownCode] : `MemWal削除APIエラー（HTTP ${response.status}）`, response.status);
    }
    return data;
  }
  async function trackedState(blobId: string, token: string): Promise<string | null> {
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
      const query = new URLSearchParams({ state: "deletable,deleting,deleted,deleted_external,not_owner,expired", limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const page = z.object({ items: z.array(z.object({ blobId: z.string(), state: z.string() })), nextCursor: z.string().nullable() }).parse(await remote(`/api/security-deletable-blobs?${query}`, token));
      const item = page.items.find((item) => item.blobId === blobId);
      if (item) return item.state;
      cursor = page.nextCursor;
      if (cursor && visited.has(cursor)) throw new DeleteApiError("INVALID_CURSOR", "MemWalの削除対象一覧を確認できませんでした。時間をおいて再確認してください。", 502);
      if (cursor) visited.add(cursor);
    } while (cursor);
    return null;
  }
  function unavailable(state: string | null): never {
    if (state && exclusionMessages[state]) throw new DeleteApiError(`BLOB_${state.toUpperCase()}`, exclusionMessages[state]);
    throw new DeleteApiError("BLOB_NOT_TRACKED", "この記憶のblob IDが、このサーバー・所有者の旧V1削除対象一覧に見つかりません。保存先サーバーや保存時の所有者が異なる場合もあります。Security Delete APIは旧V1追跡済みblob専用です。現在の保存APIの記憶は対象外の場合があります。名前空間全体の検索リセットへの自動切替は行わず、削除は実行していません。");
  }
  app.get("/api/memory-delete/config", async () => ({
    enabled: service.mode !== "demo" && !!process.env.OWNER_ADDRESS && ["mainnet", "testnet"].includes(process.env.MEMWAL_NETWORK || ""),
    owner: process.env.OWNER_ADDRESS,
    network: memwalEnvironment().network,
    endpoint: memwalEnvironment().endpoint,
  }));
  app.post("/api/memories/:id/remote-delete/:action", async (req) => service.store.lock(async () => {
    if (service.mode === "demo") throw Error("デモではMemWalの削除を実行できません。");
    if (!process.env.OWNER_ADDRESS || !["mainnet", "testnet"].includes(process.env.MEMWAL_NETWORK || "")) throw Error("所有者とMEMWAL_NETWORK（mainnet/testnet）の設定が必要です。");
    const { id, action } = z.object({ id: z.union([z.string().uuid(), z.string().regex(/^[a-f0-9]{64}$/)]), action: z.enum(["challenge", "verify", "prepare", "submit", "status", "cancel"]) }).parse(req.params);
    const memoryKey = `memories/${id}.json`, syncKey = `sync/${id}.json`;
    const memory = await service.store.read(memoryKey);
    const sync = await service.store.read(syncKey, {});
    const environmentBinding = memwalBinding();
    if ((sync.environmentBinding && sync.environmentBinding !== environmentBinding) ||
        (sync.remoteDeletion?.environmentBinding && sync.remoteDeletion.environmentBinding !== environmentBinding))
      throw new DeleteApiError("ENVIRONMENT_MISMATCH", "保存時・削除準備時と現在のMemWal接続先が一致しません。設定を確認してください。");
    if (!sync.blobId) throw Error("MemWal保存完了のblob IDがないため削除できません。");
    const blobDeleted = sync.status === "deleted" || !!memory.remoteDeletedAt || sync.directWalrusDeletion?.state === "completed" || sync.remoteDeletion?.state === "completed";
    const existingBatchCheck = !!sync.remoteDeletion?.batchId && ["challenge", "verify", "status", "cancel"].includes(action);
    if (blobDeleted && !existingBatchCheck) throw new DeleteApiError("BLOB_ALREADY_DELETED", "Walrusのblobは削除済みです。新しい削除は実行できません。検索索引は別の操作で確認してください。");
    if (["awaiting_signature", "executing"].includes(sync.directWalrusDeletion?.state) && !existingBatchCheck) throw new DeleteApiError("BLOB_DELETE_PENDING", "直接blob削除の処理があります。先にその削除結果を確認してください。");
    if (action === "challenge") return z.object({ challengeId: z.string(), challenge: z.string() }).parse(await remote("/api/security-delete-auth/challenge", undefined, { address: process.env.OWNER_ADDRESS }));
    if (action === "verify") {
      const body = z.object({ challengeId: z.string().max(200), signature: z.string().max(16000) }).parse(req.body);
      return z.object({ token: tokenSchema }).parse(await remote("/api/security-delete-auth/verify", undefined, { ...body, address: process.env.OWNER_ADDRESS }));
    }
    const { token, signature } = z.object({ token: tokenSchema, signature: z.string().max(16000).optional() }).parse(req.body);
    const previous = sync.remoteDeletion;
    if (action === "prepare") {
      if (sync.status === "deleted") throw Error("この記憶はMemWalから削除済みです。");
      if (previous && !["failed", "rolled_back"].includes(previous.state)) throw Error("前回の削除結果を確認してください。重複送信を停止しました。");
      const state = await trackedState(sync.blobId, token);
      if (state !== "deletable") unavailable(state);
      // Request exactly this memory's blob, never all memories in the wallet.
      const prepared = z.object({ batchId: z.string().uuid().nullable(), txBytes: z.string().nullable(), included: z.number(), excluded: z.array(z.object({ blobId: z.string(), reason: z.string() })), expiresAt: z.string().nullable() }).parse(await remote("/api/security-deletions", token, { mode: "selection", blobIds: [sync.blobId] }));
      if (!prepared.batchId || !prepared.txBytes || prepared.included !== 1 || prepared.excluded.length) {
        const excluded = prepared.excluded.find((item) => item.blobId === sync.blobId);
        if (excluded && exclusionMessages[excluded.reason]) unavailable(excluded.reason);
        // An empty batch is not proof of deletion. Look up this exact blob in all
        // tracked states; never substitute another blob or enroll an untracked one.
        unavailable(await trackedState(sync.blobId, token));
      }
      await service.store.write(syncKey, { ...sync, remoteDeletion: { batchId: prepared.batchId, state: "awaiting_signature", expiresAt: prepared.expiresAt, environmentBinding } });
      return { ...prepared, blobId: sync.blobId };
    }
    if (!previous?.batchId) throw Error("確認する削除処理がありません。");
    const batchPath = `/api/security-deletions/${encodeURIComponent(previous.batchId)}`;
    if (action === "submit") {
      if (!signature || previous.state !== "awaiting_signature") throw Error("署名待ちの削除処理ではありません。結果を確認してください。");
      // Persist uncertainty BEFORE submitting. A timeout must never cause a fresh deletion.
      await service.store.write(syncKey, { ...sync, remoteDeletion: { ...previous, state: "executing" } });
      try { await remote(`${batchPath}/submit`, token, { signature }); }
      catch (error) { return { state: "executing", ...(error instanceof DeleteApiError ? { code: error.code } : {}), note: `${error instanceof DeleteApiError ? error.message + " " : ""}送信結果未確認です。「削除結果を確認」で確認してください。` }; }
    }
    const status = z.object({ state: z.enum(["awaiting_signature", "executing", "completed", "failed", "rolled_back"]), digest: z.string().nullable(), blobCount: z.number() }).parse(await remote(batchPath, token, undefined, action === "cancel" ? "DELETE" : "GET"));
    if (status.state === "completed" && (status.blobCount !== 1 || !status.digest)) throw Error("削除完了の取引情報が未確認です。");
    await service.store.write(syncKey, { ...sync, status: status.state === "completed" ? "deleted" : sync.status, remoteDeletion: { ...previous, ...status } });
    if (status.state === "completed") {
      await service.store.write(memoryKey, { ...memory, active: false, remoteDeletedAt: new Date().toISOString() });
      await service.store.rebuild();
      let searchVerification;
      try { searchVerification = await verifySearch({ ...memory, namespace: sync.namespace || memory.namespace }, sync.blobId); }
      catch { searchVerification = { state: "pending" as const, note: "削除取引は完了しましたが、MemWal再検索での消失は未確認です。削除結果を再確認してください。" }; }
      await service.store.write(syncKey, { ...sync, status: "deleted", remoteDeletion: { ...previous, ...status, searchVerification } });
      return { ...status, searchVerification };
    }
    return status;
  }));
}
