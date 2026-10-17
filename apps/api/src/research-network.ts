import { lookup } from "node:dns/promises";
import { isIP,BlockList } from "node:net";
import { request, type RequestOptions } from "node:https";

export type Destination = { address: string; family: number };
export type Resolver = (host: string) => Promise<Destination[]>;
export const resolveResearchHost: Resolver = host => lookup(host, { all: true, verbatim: true });
// IANA special-purpose registries, checked 2026-10-17 (registry update 2025-10-09).
// Even globally reachable protocol/anycast exceptions are not LLM destinations.
const special4=new BlockList(),special6=new BlockList(),global6=new BlockList();
export const researchSpecial4:[string,number][]=[["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.31.196.0",24],["192.52.193.0",24],["192.88.99.0",24],["192.168.0.0",16],["192.175.48.0",24],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]];
export const researchSpecial6:[string,number][]=[["::",128],["::1",128],["::ffff:0:0",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["100:0:0:1::",64],["2001::",23],["2001:db8::",32],["2002::",16],["2620:4f:8000::",48],["3fff::",20],["5f00::",16],["fc00::",7],["fe80::",10],["ff00::",8]];
for(const [network,prefix] of researchSpecial4)special4.addSubnet(network,prefix,"ipv4");
for(const [network,prefix] of researchSpecial6)special6.addSubnet(network,prefix,"ipv6");
global6.addSubnet("2000::",3,"ipv6");
export function publicResearchAddress(address: string) {
  if(address.includes("%"))return false;
  if(isIP(address)===4)return !special4.check(address,"ipv4");
  return isIP(address)===6&&global6.check(address,"ipv6")&&!special6.check(address,"ipv6");
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
