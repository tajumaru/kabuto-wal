import { createHash } from "node:crypto";

// KABUTO WAL runs on Mainnet. Read the environment at call time (after dotenv).
export function memwalEnvironment() {
  const network = process.env.MEMWAL_NETWORK || "mainnet";
  const server = new URL(process.env.MEMWAL_SERVER_URL || "https://relayer.memory.walrus.xyz");
  const endpoint = process.env.MEMWAL_SUI_ENDPOINT || "https://fullnode.mainnet.sui.io:443";
  if (network !== "mainnet" || /testnet|staging/i.test(server.hostname + endpoint))
    throw Error("KABUTO WALのMemWal接続はMainnetに統一してください。既存データの移行は実行しません。");
  if (server.protocol !== "https:" || server.username || server.password || server.pathname !== "/" || server.search || server.hash)
    throw Error("MEMWAL_SERVER_URLには認証情報やパスを含まないHTTPS URLを指定してください。");
  return { network: "mainnet" as const, serverUrl: server.origin, endpoint,
    accountId: process.env.MEMWAL_ACCOUNT_ID, owner: process.env.OWNER_ADDRESS,
    packageId: process.env.MEMWAL_PACKAGE_ID };
}

export function memwalBinding() {
  const { network, serverUrl, accountId, owner, packageId } = memwalEnvironment();
  return createHash("sha256").update(JSON.stringify([network, serverUrl, accountId, owner, packageId])).digest("hex");
}
