import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { memwalEnvironment } from "./memwal-config";
import { memoryResetClient } from "./memwal-reset";
export function assertMemwalAccount(
  object: { type: string; json: Record<string, unknown> | null },
  owner: string,
  delegate: string,
  packageId: string,
) {
  if (object.type !== `${packageId}::account::MemWalAccount`)
    throw Error("MemWal account package/type不一致");
  const data = object.json;
  if (
    !data ||
    data.owner !== owner ||
    data.active !== true ||
    data.admin_quarantined === true
  )
    throw Error("MemWal owner不一致・無効account");
  if (
    !Array.isArray(data.delegate_keys) ||
    !data.delegate_keys.some((d: any) => d.sui_address === delegate)
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
  const { object } = await client.core.getObject({
    objectId: accountId,
    include: { json: true },
  });
  const result = assertMemwalAccount(object, owner, delegate, packageId);
  await memoryResetClient().identity();
  return result;
}
