import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { memwalEnvironment, assertRpcUrl } from "./memwal-config";
import { fromBase58, normalizeSuiAddress } from "@mysten/sui/utils";
import { memoryResetClient } from "./memwal-reset";

export function assertMainnetIdentifier(identifier: string) {
  // gRPC returns the full genesis digest; JSON-RPC returns its first four bytes.
  let short = identifier;
  if (!/^[a-f0-9]{8}$/i.test(identifier)) {
    const bytes = fromBase58(identifier);
    if (bytes.length !== 32) throw Error("Suiチェーン識別子の形式が不正です。");
    short = Buffer.from(bytes.subarray(0, 4)).toString("hex");
  }
  if (short.toLowerCase() !== "35834a8a") throw Error("MemWalのSui接続先がMainnetではありません。");
}
export async function verifyMainnetChain(client: Pick<SuiGrpcClient, "getChainIdentifier">) {
  const { chainIdentifier } = await client.getChainIdentifier({ signal: AbortSignal.timeout(20000) });
  assertMainnetIdentifier(chainIdentifier);
}
export async function verifyRelayerRpc(deployment: { suiTransport?: string; suiGrpcUrl?: string; suiRpcUrl?: string }, fetcher: typeof fetch = fetch) {
  const transport = deployment.suiTransport ?? (deployment.suiGrpcUrl ? "grpc" : "jsonrpc");
  if (!["grpc", "jsonrpc"].includes(transport) || (transport === "jsonrpc" && !deployment.suiRpcUrl) || (transport === "grpc" && !deployment.suiGrpcUrl && !deployment.suiRpcUrl)) throw Error("RelayerのSui接続設定が不正です。");
  if (transport === "grpc" && deployment.suiGrpcUrl) {
    await verifyMainnetChain(new SuiGrpcClient({ network: "mainnet", baseUrl: assertRpcUrl(deployment.suiGrpcUrl) }));
  }
  if (deployment.suiRpcUrl) {
    const response = await fetcher(assertRpcUrl(deployment.suiRpcUrl), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sui_getChainIdentifier", params: [] }), signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    if (!response.ok || typeof body.result !== "string" || body.error) throw Error("RelayerのSuiチェーンを確認できません。");
    assertMainnetIdentifier(body.result);
  }
}
export function assertMemwalAccount(
  object: { type: string; json: Record<string, unknown> | null },
  owner: string,
  delegate: string,
  packageId: string,
) {
  if (object.type !== `${normalizeSuiAddress(packageId)}::account::MemWalAccount` && object.type !== `${packageId}::account::MemWalAccount`)
    throw Error("MemWal account package/type不一致");
  const data = object.json;
  if (
    !data ||
    typeof data.owner !== "string" || normalizeSuiAddress(data.owner) !== normalizeSuiAddress(owner) ||
    data.active !== true ||
    data.admin_quarantined === true
  )
    throw Error("MemWal owner不一致・無効account");
  if (
    !Array.isArray(data.delegate_keys) ||
    !data.delegate_keys.some((d: any) => typeof d.sui_address === "string" && normalizeSuiAddress(d.sui_address) === normalizeSuiAddress(delegate))
  )
    throw Error("MemWal delegate未登録・不明なobject形式");
  return { owner, delegate, packageId, verifiedAt: new Date().toISOString() };
}
export async function verifyMemwalAccount() {
  const accountId = process.env.MEMWAL_ACCOUNT_ID,
    key = process.env.MEMWAL_DELEGATE_KEY,
    owner = process.env.OWNER_ADDRESS,
    packageId = process.env.MEMWAL_PACKAGE_ID;
  if (!accountId || !key || !owner || !packageId)
    throw Error(
      "MEMWAL_ACCOUNT_ID/DELEGATE_KEY/PACKAGE_ID/OWNER_ADDRESSが必要",
    );
  const { network, endpoint, serverUrl } = memwalEnvironment();
  const response = await fetch(new URL("/config", serverUrl), { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error("MemWal Relayerの公開設定を確認できません。");
  const deployment = await response.json();
  if (deployment.network !== network || deployment.packageId !== packageId)
    throw Error("MemWal Relayerのnetwork/packageがMainnet設定と一致しません。");
  const secret = key.startsWith("suiprivkey")
    ? decodeSuiPrivateKey(key).secretKey
    : Buffer.from(key.replace(/^0x/, ""), "hex");
  const delegate = Ed25519Keypair.fromSecretKey(secret).toSuiAddress();
  const client = new SuiGrpcClient({
    network,
    baseUrl: endpoint,
  });
  await verifyMainnetChain(client);
  await verifyRelayerRpc(deployment);
  const { object } = await client.core.getObject({
    objectId: accountId,
    include: { json: true },
  });
  const result = assertMemwalAccount(object, owner, delegate, packageId);
  await memoryResetClient().identity();
  return result;
}
