import { createHash, randomUUID } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { z } from "zod";
import { memwalEnvironment } from "./memwal-config";

export type ResetNamespace = { name: string; memory_count: number };
export interface MemoryResetClient {
  identity(): Promise<void>;
  namespaces(): Promise<ResetNamespace[]>;
  forget(namespace: string): Promise<number>;
}

// /api/forget uses delegate-signed HTTP auth, not Security Delete bearer auth.
export class MemwalResetClient implements MemoryResetClient {
  private signer: Ed25519Keypair;
  constructor(private config: { key: string; accountId: string; owner: string; serverUrl: string }, private fetcher: typeof fetch = fetch) {
    const secret = config.key.startsWith("suiprivkey") ? decodeSuiPrivateKey(config.key).secretKey : Buffer.from(config.key.replace(/^0x/, ""), "hex");
    this.signer = Ed25519Keypair.fromSecretKey(secret);
  }
  private async request(method: "GET" | "POST", path: string, body?: unknown) {
    const wire = method === "GET" ? "" : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString(), nonce = randomUUID();
    const hash = createHash("sha256").update(wire).digest("hex");
    const canonical = `${timestamp}.${method}.${path}.${hash}.${nonce}.${this.config.accountId}`;
    const signature = await this.signer.sign(new TextEncoder().encode(canonical));
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.serverUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "Content-Type": "application/json", "x-account-id": this.config.accountId, "x-public-key": Buffer.from(this.signer.getPublicKey().toRawBytes()).toString("hex"), "x-signature": Buffer.from(signature).toString("hex"), "x-timestamp": timestamp, "x-nonce": nonce },
        ...(method === "POST" ? { body: wire } : {}),
        signal: AbortSignal.timeout(30000),
      });
    } catch { throw Error("MemWalとの通信結果を確認できません。検索リセットは未完了です。"); }
    if (!response.ok) throw Error(`MemWal検索リセットAPI HTTP ${response.status}。${response.status === 401 ? "delegateの登録と認証設定を確認してください。" : response.status === 404 ? "このサーバーは必要なAPIに対応していません。" : "時間をおいて対象を再確認してください。"}`);
    return response.json();
  }
  private assertOwner(owner: string) {
    if (normalizeSuiAddress(owner) !== normalizeSuiAddress(this.config.owner)) throw Error("MemWalの所有者がこのアプリの所有者と一致しません。");
  }
  async identity() {
    const data = z.object({ owner: z.string(), account_id: z.string() }).parse(await this.request("GET", "/api/whoami"));
    this.assertOwner(data.owner);
    if (normalizeSuiAddress(data.account_id) !== normalizeSuiAddress(this.config.accountId)) throw Error("MemWalのアカウントが一致しません。");
  }
  async namespaces() {
    const result = new Map<string, ResetNamespace>(), seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: "500" });
      if (cursor) query.set("updated_after", cursor);
      const page = z.object({ namespaces: z.array(z.object({ name: z.string().min(1).refine((s) => Buffer.byteLength(s) <= 255), memory_count: z.number().int().nonnegative() })), has_more: z.boolean(), next_cursor: z.string().nullable() }).parse(await this.request("GET", `/v1/owners/${normalizeSuiAddress(this.config.owner)}/namespaces?${query}`));
      for (const ns of page.namespaces) if (ns.memory_count > 0) result.set(ns.name, ns);
      if (!page.has_more) return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
      if (!page.next_cursor || seen.has(page.next_cursor)) throw Error("MemWalの保存区分一覧を最後まで確認できません。");
      cursor = page.next_cursor; seen.add(cursor);
    }
  }
  async forget(namespace: string) {
    const data = z.object({ deleted: z.number().int().nonnegative(), namespace: z.string(), owner: z.string() }).parse(await this.request("POST", "/api/forget", { namespace }));
    this.assertOwner(data.owner);
    if (data.namespace !== namespace) throw Error("MemWalのリセット対象が一致しません。");
    const stats = z.object({ memory_count: z.number().int().nonnegative(), owner: z.string(), namespace: z.string() }).parse(await this.request("POST", "/api/stats", { namespace }));
    this.assertOwner(stats.owner);
    if (stats.namespace !== namespace || stats.memory_count !== 0) throw Error("検索用データが0件になったことを確認できません。他の端末からの保存も確認してください。");
    return data.deleted;
  }
}

export function memoryResetClient(): MemoryResetClient {
  const { MEMWAL_DELEGATE_KEY: key, MEMWAL_ACCOUNT_ID: accountId, OWNER_ADDRESS: owner } = process.env;
  if (!key || !accountId || !owner) throw Error("MemWalのowner・account・delegate設定が必要です。");
  return new MemwalResetClient({ key, accountId, owner, serverUrl: memwalEnvironment().serverUrl });
}
