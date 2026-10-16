import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { memwalBinding, memwalEnvironment } from "../../../packages/integrations/memwal-config";
import type { Service } from "./service";
import { verifyMainnetChain } from "../../../packages/integrations/sui";
import { verifyMemoryBinding } from "../../../packages/integrations/index";

const systemId = "0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2";
const blobType = "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77::blob::Blob";
export function blobDecimal(blobId: string) {
  const bytes = Buffer.from(blobId, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== blobId) throw Error("blob IDの形式が不正です。");
  return BigInt("0x" + Buffer.from(bytes).reverse().toString("hex")).toString();
}
export function assertDeletableBlob(object: { type: string; owner: unknown; json: Record<string, unknown> | null }, owner: string, blobId: string) {
  const address = (object.owner as { AddressOwner?: string })?.AddressOwner;
  if (object.type !== blobType || !address || normalizeSuiAddress(address) !== normalizeSuiAddress(owner) || object.json?.blob_id !== blobDecimal(blobId)) throw Error("blob・所有者・オブジェクトの照合に失敗しました。");
  if (object.json.deletable !== true) throw Error("このblobは削除可能な形式ではありません。");
}
export function registerBlobDelete(app: FastifyInstance, service: Service, factory = () => new SuiGrpcClient({ network: "mainnet", baseUrl: memwalEnvironment().endpoint })) {
  app.post("/api/memories/:id/blob-delete/:action", async (req) => service.store.lock(async () => {
    if (service.mode === "demo" || !process.env.OWNER_ADDRESS) throw Error("実モードと所有者認証が必要です。");
    const { id, action } = z.object({ id: z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/), action: z.enum(["prepare", "submit", "status", "cancel"]) }).parse(req.params);
    const owner = process.env.OWNER_ADDRESS, binding = memwalBinding(), client = factory();
    const key = `sync/${id}.json`, memoryKey = `memories/${id}.json`;
    const sync = await service.store.read(key), memory = await service.store.read(memoryKey);
    if (!sync.blobId) throw Error("保存完了のblob IDがありません。");
    if ((sync.environmentBinding && sync.environmentBinding !== binding) || (sync.directWalrusDeletion?.binding && sync.directWalrusDeletion.binding !== binding)) throw Error("保存時と現在のMemWal接続先が一致しません。");
    let plan = sync.directWalrusDeletion;
    if ((sync.status === "deleted" || memory.remoteDeletedAt || plan?.state === "completed" || sync.remoteDeletion?.state === "completed") && ["prepare", "submit"].includes(action)) throw Error("Walrusのblobは削除済みです。新しい削除操作はできません。");
    if (action === "prepare") {
      if (sync.status === "deleted" || plan && !["cancelled", "failed"].includes(plan.state)) throw Error("削除済み、または前回の処理があります。削除結果を確認してください。");
      if (sync.remoteDeletion && !["failed", "rolled_back"].includes(sync.remoteDeletion.state)) throw Error("旧削除APIの処理結果を先に確認してください。");
      if (!sync.environmentBinding) {
        const provider = await service.memoryProvider();
        if (!provider) throw Error("旧記憶の保存先を検証する接続設定がありません。");
        await verifyMemoryBinding(service.store, key, sync, memory, provider);
      }
      await verifyMainnetChain(client);
      const target = blobDecimal(sync.blobId);
      const matches = [];
      let cursor: string | null | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listOwnedObjects({ owner, type: blobType, limit: 100, cursor, include: { json: true } });
        for (const object of page.objects) if (object.json?.blob_id === target) matches.push(object);
        cursor = page.hasNextPage ? page.cursor : null;
        if (cursor && seen.has(cursor)) throw Error("所有オブジェクトの一覧を最後まで確認できません。");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (matches.length !== 1) throw Error("対象blobの所有オブジェクトを1件に特定できません。未所有・削除済み・複数登録の可能性があります。");
      const object = matches[0];
      assertDeletableBlob(object, owner, sync.blobId);
      const { object: system } = await client.getObject({ objectId: systemId, include: { json: true } });
      const packageId = z.string().regex(/^0x[a-f0-9]{64}$/).parse(system.json?.package_id);
      const tx = new Transaction();
      tx.setSender(owner); tx.setGasBudget(20_000_000);
      const storage = tx.moveCall({ target: `${packageId}::system::delete_blob`, arguments: [tx.object(systemId), tx.object(object.objectId)] });
      tx.transferObjects([storage], owner);
      const bytes = await tx.build({ client });
      const simulation = await client.simulateTransaction({ transaction: bytes });
      if (simulation.$kind !== "Transaction") throw Error("削除取引の事前検証に失敗しました。");
      plan = { id: randomUUID(), state: "awaiting_signature", binding, objectId: object.objectId, blobId: sync.blobId, digest: await Transaction.from(bytes).getDigest(), txBytes: Buffer.from(bytes).toString("base64"), expiresAt: Date.now() + 600_000 };
      await service.store.write(key, { ...sync, directWalrusDeletion: plan });
      return plan;
    }
    if (!plan?.digest) throw Error("確認する削除取引がありません。");
    if (action === "cancel") {
      if (plan.state !== "awaiting_signature") throw Error("送信済みの取引は中止できません。");
      await service.store.write(key, { ...sync, directWalrusDeletion: { ...plan, state: "cancelled", txBytes: undefined } });
      return { state: "cancelled" };
    }
    if (action === "submit") {
      const { planId, signature } = z.object({ planId: z.string().uuid(), signature: z.string().min(1).max(16000) }).parse(req.body);
      if (plan.id !== planId || !["awaiting_signature", "executing"].includes(plan.state) || (plan.state === "awaiting_signature" && plan.expiresAt < Date.now())) throw Error("削除準備の期限切れ、または送信済みです。結果確認・中止を行ってください。");
      const bytes = Buffer.from(plan.txBytes, "base64");
      if (await Transaction.from(bytes).getDigest() !== plan.digest) throw Error("保存済み取引の照合に失敗しました。");
      const signer = await verifyTransactionSignature(bytes, signature);
      if (normalizeSuiAddress(signer.toSuiAddress()) !== normalizeSuiAddress(owner)) throw Error("削除署名の所有者が一致しません。");
      await verifyMainnetChain(client);
      plan = { ...plan, state: "executing" };
      await service.store.write(key, { ...sync, directWalrusDeletion: plan });
      try { await client.executeTransaction({ transaction: bytes, signatures: [signature] }); }
      catch { return { state: "executing", digest: plan.digest, note: "送信結果未確認です。同じ取引の結果を確認してください。" }; }
    }
    let result;
    try { result = await client.getTransaction({ digest: plan.digest, include: { events: true } }); }
    catch { return { state: plan.state || "unverified", digest: plan.digest, note: "チェーンでの結果を確認できません。時間をおいて再確認してください。" }; }
    const transaction = result.Transaction || result.FailedTransaction;
    if (result.$kind === "FailedTransaction") {
      await service.store.write(key, { ...sync, directWalrusDeletion: { ...plan, state: "failed", txBytes: undefined } });
      return { state: "failed", digest: plan.digest };
    }
    const deleted = transaction.events?.some(event => event.eventType === blobType.replace("::blob::Blob", "::events::BlobDeleted") && (event.json as any)?.object_id === plan.objectId && (event.json as any)?.blob_id === blobDecimal(sync.blobId));
    if (!deleted) throw Error("削除取引の対象blobイベントを照合できません。");
    await service.store.write(key, { ...sync, status: "deleted", directWalrusDeletion: { ...plan, state: "completed", txBytes: undefined, confirmedAt: new Date().toISOString() } });
    await service.store.write(memoryKey, { ...memory, active: false, remoteDeletedAt: new Date().toISOString() });
    await service.store.rebuild();
    return { state: "completed", digest: plan.digest, note: "Walrusのblob削除を確認しました。MemWalの検索索引削除は別の操作です。" };
  }));
}
