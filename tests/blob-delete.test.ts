import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Service } from "../apps/api/src/service";
import { assertDeletableBlob, blobDecimal, registerBlobDelete } from "../apps/api/src/blob-delete";
import { memwalBinding } from "../packages/integrations/memwal-config";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of cleanups.splice(0)) await close(); });
const blob = "nCTzRyGWI3BHWDXDLBsqg6UwxUVwfJPFSHrid1tA040";
const type = "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77::blob::Blob";
async function fixture() {
  const signer = Ed25519Keypair.generate(), owner = signer.toSuiAddress();
  vi.stubEnv("OWNER_ADDRESS", owner); vi.stubEnv("MEMWAL_NETWORK", "mainnet");
  const tx = new Transaction(); tx.setSender(owner); tx.setGasBudget(20_000_000); tx.setGasPrice(100);
  tx.setGasPayment([{ objectId: "0x1", version: "1", digest: "11111111111111111111111111111111" }]);
  const bytes = await tx.build();
  vi.spyOn(Transaction.prototype, "build").mockResolvedValue(bytes);
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-delete-"));
  const service = new Service(root, "live"), id = "a".repeat(64);
  await service.store.write(`memories/${id}.json`, { recordId: id, active: true, text: "keep local", namespace: "work" });
  await service.store.write(`sync/${id}.json`, { status: "synced", blobId: blob, environmentBinding: memwalBinding() });
  const object = { objectId: "0x" + "2".repeat(64), type, owner: { AddressOwner: owner }, json: { blob_id: blobDecimal(blob), deletable: true } };
  const event = { eventType: type.replace("::blob::Blob", "::events::BlobDeleted"), json: { blob_id: blobDecimal(blob), object_id: object.objectId } };
  const client = {
    getChainIdentifier: vi.fn(async () => ({ chainIdentifier: "35834a8a" })),
    listOwnedObjects: vi.fn(async () => ({ objects: [object], hasNextPage: false, cursor: null })),
    getObject: vi.fn(async () => ({ object: { json: { package_id: "0x" + "3".repeat(64) } } })),
    simulateTransaction: vi.fn(async () => ({ $kind: "Transaction" })),
    executeTransaction: vi.fn(async () => ({ $kind: "Transaction" })),
    getTransaction: vi.fn(async () => ({ $kind: "Transaction", Transaction: { events: [event] } })),
  };
  const app = Fastify(); app.setErrorHandler((e, _req, reply) => reply.code(400).send({ error: (e as Error).message }));
  registerBlobDelete(app, service, () => client as any);
  cleanups.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const request = (action: string, payload = {}) => app.inject({ method: "POST", url: `/api/memories/${id}/blob-delete/${action}`, payload });
  return { signer, owner, bytes, service, id, object, event, client, request };
}
it("blob IDをlittle endianで正確に照合し、別所有者・永久blob・不正IDを拒否する", () => {
  expect(blobDecimal(blob)).toBe("64149360558655471380255629707220797067663839519025788419638834266021452522652");
  expect(() => blobDecimal("invalid")).toThrow();
  const object = { type, owner: { AddressOwner: "0x1" }, json: { blob_id: blobDecimal(blob), deletable: true } };
  expect(() => assertDeletableBlob(object, "0x2", blob)).toThrow();
  expect(() => assertDeletableBlob({ ...object, json: { ...object.json, deletable: false } }, "0x1", blob)).toThrow();
});
it("本人署名と対象の削除イベントを確認した後だけ削除済みにし、記録は残す", async () => {
  const f = await fixture();
  const plan = (await f.request("prepare")).json();
  expect(plan.state).toBe("awaiting_signature");
  expect(f.client.executeTransaction).not.toHaveBeenCalled();
  const signed = await f.signer.signTransaction(f.bytes);
  expect((await f.request("submit", { planId: plan.id, signature: signed.signature })).json().state).toBe("completed");
  expect(f.client.executeTransaction.mock.calls).toHaveLength(1);
  expect(await f.service.store.read(`memories/${f.id}.json`)).toMatchObject({ text: "keep local", active: false });
  const state = await f.service.store.read(`sync/${f.id}.json`);
  expect(state.status).toBe("deleted"); expect(state.directWalrusDeletion.txBytes).toBeUndefined();
  expect(JSON.stringify(state)).not.toContain(signed.signature);
});
it("送信タイムアウト後は重複送信を防ぎ、再起動相当の結果確認で完了する", async () => {
  const f = await fixture(), plan = (await f.request("prepare")).json();
  const signed = await f.signer.signTransaction(f.bytes);
  f.client.executeTransaction.mockRejectedValueOnce(Error("timeout"));
  expect((await f.request("submit", { planId: plan.id, signature: signed.signature })).json().state).toBe("executing");
  expect((await f.request("prepare")).statusCode).toBe(400);
  expect((await f.request("status")).json().state).toBe("completed");
  expect(f.client.executeTransaction).toHaveBeenCalledTimes(1);
});
it("受付前に途切れた削除は再起動後も同じ取引だけを再送できる", async () => {
  const f = await fixture(), plan = (await f.request("prepare")).json();
  const signed = await f.signer.signTransaction(f.bytes);
  f.client.executeTransaction.mockRejectedValueOnce(Error("before acceptance"));
  expect((await f.request("submit", { planId: plan.id, signature: signed.signature })).json().state).toBe("executing");
  f.client.getTransaction.mockRejectedValueOnce(Error("not found"));
  expect((await f.request("status")).json().state).toBe("executing");
  expect((await f.request("submit", { planId: randomUUID(), signature: signed.signature })).statusCode).toBe(400);
  expect((await f.request("submit", { planId: plan.id, signature: signed.signature })).json().state).toBe("completed");
  const calls = f.client.executeTransaction.mock.calls as unknown as [{ transaction: Uint8Array }][];
  expect(calls).toHaveLength(2);
  expect(calls[0][0].transaction).toEqual(calls[1][0].transaction);
});
it("RPCが別チェーンなら削除取引を作成しない", async () => {
  const f = await fixture();
  f.client.getChainIdentifier.mockResolvedValue({ chainIdentifier: "4c78adac" });
  expect((await f.request("prepare")).json().error).toContain("Mainnetではありません");
  expect(f.client.listOwnedObjects).not.toHaveBeenCalled();
});
it("別ウォレット署名・別blobイベントを拒否する", async () => {
  const f = await fixture(), plan = (await f.request("prepare")).json();
  const other = await Ed25519Keypair.generate().signTransaction(f.bytes);
  expect((await f.request("submit", { planId: plan.id, signature: other.signature })).statusCode).toBe(400);
  expect(f.client.executeTransaction).not.toHaveBeenCalled();
  f.event.json.object_id = "0xwrong";
  const signed = await f.signer.signTransaction(f.bytes);
  expect((await f.request("submit", { planId: plan.id, signature: signed.signature })).statusCode).toBe(400);
  expect((await f.service.store.read(`sync/${f.id}.json`)).status).toBe("synced");
});
it("未送信の準備は取消可能、同じblobの複数登録は停止する", async () => {
  const f = await fixture(); await f.request("prepare");
  expect((await f.request("cancel")).json().state).toBe("cancelled");
  f.client.listOwnedObjects.mockResolvedValueOnce({ objects: [f.object, f.object], hasNextPage: false, cursor: null });
  expect((await f.request("prepare")).statusCode).toBe(400);
  expect(f.client.executeTransaction).not.toHaveBeenCalled();
});
