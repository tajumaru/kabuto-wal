import { randomBytes } from "node:crypto";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { commitment } from "../core/commitment";
import type { Store } from "../storage/index";
export async function prepareAnchor(store: Store, predictionId: string) {
  if (
    process.env.ENABLE_SUI_COMMITMENTS !== "true" ||
    process.env.SUI_NETWORK !== "testnet"
  )
    throw Error("予測アンカーはtestnetの明示有効化が必要");
  if (!process.env.COMMITMENT_PACKAGE_ID || !process.env.COMMITMENT_REGISTRY_ID)
    throw Error("Move packageと本人registryを設定してください");
  const p = await store.read(`predictions/${predictionId}/original.json`);
  let state = await store.read(`commitments/${predictionId}.json`, null);
  if (!state) {
    const salt = randomBytes(32);
    state = {
      schemaVersion: 1,
      recordId: predictionId,
      kind: "commitment",
      createdAt: new Date().toISOString(),
      source: "local",
      predictionId,
      salt: salt.toString("hex"),
      hash: commitment(p, salt),
      status: "prepared",
    };
    await store.write(`commitments/${predictionId}.json`, state, true);
  }
  return {
    predictionId,
    hash: state.hash,
    generatedAt: Date.parse(p.generatedAt),
    targetSessionDate: p.targetSessionDate,
    packageId: process.env.COMMITMENT_PACKAGE_ID,
    registryId: process.env.COMMITMENT_REGISTRY_ID,
  };
}
export async function verifyAnchor(
  store: Store,
  predictionId: string,
  receiptId: string,
  txDigest: string,
) {
  const prepared = await prepareAnchor(store, predictionId);
  const client = new SuiGrpcClient({
    network: "testnet",
    baseUrl: process.env.SUI_ENDPOINT || "https://fullnode.testnet.sui.io:443",
  });
  const { object } = await client.core.getObject({
    objectId: receiptId,
    include: { json: true, previousTransaction: true },
  });
  const j = object.json;
  if (
    object.type !==
      `${prepared.packageId}::prediction_commitment::PredictionReceipt` ||
    !j ||
    j.owner !== process.env.OWNER_ADDRESS ||
    object.previousTransaction !== txDigest
  )
    throw Error("receiptのowner/type/transaction不一致");
  const bytes = (v: unknown): Buffer =>
    Array.isArray(v)
      ? Buffer.from(v)
      : typeof v === "string"
        ? Buffer.from(v, "base64")
        : Buffer.alloc(0);
  if (
    bytes(j.commitment_hash).toString("hex") !== prepared.hash ||
    bytes(j.prediction_id).toString() !== predictionId
  )
    throw Error("コミットメント内容不一致・未対応レスポンス");
  const anchoredAt = Number(j.anchored_at);
  if (!Number.isFinite(anchoredAt)) throw Error("アンカー時刻なし");
  const p = await store.read(`predictions/${predictionId}/original.json`),
    state = await store.read(`commitments/${predictionId}.json`);
  // Conservatively claim prior evidence only before the target session starts in JST.
  const prior =
    anchoredAt < Date.parse(p.targetSessionDate + "T00:00:00+09:00");
  const result = {
    ...state,
    status: "anchored",
    receiptId,
    txDigest,
    anchoredAt,
    priorEvidence: prior,
    note: "内容へのコミットメント。予測精度・データ品質の保証ではありません。",
  };
  await store.write(`commitments/${predictionId}.json`, result);
  return result;
}
