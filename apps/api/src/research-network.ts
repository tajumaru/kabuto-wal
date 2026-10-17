import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request, type RequestOptions } from "node:https";

export type Destination = { address: string; family: number };
export type Resolver = (host: string) => Promise<Destination[]>;
export const resolveResearchHost: Resolver = host => lookup(host, { all: true, verbatim: true });
// Reject special-purpose space, including IPv4-mapped IPv6 and transition ranges.
export function publicResearchAddress(address: string) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  // Conservative global unicast only; exclude IETF, documentation, 6to4, Teredo.
  const first = parseInt(address.split(":")[0],16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2001 && first !== 0x2002 && first !== 0x3fff;
}
export function researchTarget(raw: string, allowed: string[]) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) throw Error("LLM接続先は認証情報を含まないHTTPS URLで指定してください");
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g,"")) || !/^[a-z0-9.-]+$/.test(host) || host.endsWith(".") || host === "localhost" || host.endsWith(".localhost") || !allowed.includes(host)) throw Error("LLM接続先が許可されていません");
  return url;
}
let active = 0;
export type ResearchTransport = (url: URL, options: RequestOptions & { autoSelectFamily?: false; proxyEnv?: Record<string,string> }, body: string) => Promise<string>;
export const pinnedResearchTransport: ResearchTransport = (url, options, body) => new Promise((resolve,reject) => {
  const req = request(url, options, res => {
    if (res.statusCode !== 200) { res.destroy(); reject(Error("LLM応答エラー")); return; }
    let size = 0; const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 200000) { res.destroy(Error("LLM応答上限")); return; }
      chunks.push(chunk);
    });
    res.on("error", reject);
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  req.on("error", reject); req.end(body);
});
export async function researchPost(url: URL, key: string, body: string, resolver = resolveResearchHost, transport = pinnedResearchTransport, timeout = 2000) {
  if (active >= 2) throw Error("LLM同時実行上限");
  active++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const addresses = await resolver(url.hostname);
        if (controller.signal.aborted) throw Error("LLM時間上限");
        if (!addresses.length || addresses.some(a => !publicResearchAddress(a.address) || isIP(a.address) !== a.family)) throw Error("LLM接続先が許可されていません");
        const selected = addresses[0];
        // No pooling, proxy, redirect or second DNS resolution. TLS checks the original hostname.
        return transport(url, { method: "POST", agent: false, autoSelectFamily: false, family:selected.family, proxyEnv:{}, servername: url.hostname, signal: controller.signal,
          lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
          headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } }, body);
      })(),
      new Promise<never>((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("LLM時間上限")); }, timeout); }),
    ]);
  } finally { if (timer) clearTimeout(timer); active--; }
}
