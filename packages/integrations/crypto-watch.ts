import { z } from "zod";
import type { Store } from "../storage/index";
export const cryptoAssets = [
  { id: "bitcoin", symbol: "BTC", name: "ビットコイン" },
  { id: "sui", symbol: "SUI", name: "スイ" },
  { id: "solana", symbol: "SOL", name: "ソラナ" },
  { id: "walrus-2", symbol: "WAL", name: "ウォルラス" },
];
const quote = z.object({ jpy: z.number().finite().positive(), jpy_24h_change: z.number().finite().nullable(), last_updated_at: z.number().int().positive() });
export function parseCryptoQuotes(raw: unknown) {
  const data = z.object({bitcoin: quote, sui: quote, solana: quote, "walrus-2": quote}).parse(raw);
  return cryptoAssets.map((asset) => {
    const q = data[asset.id as keyof typeof data];
    return {...asset, price: q.jpy, change24h: q.jpy_24h_change, observedAt: new Date(q.last_updated_at * 1000).toISOString()};
  });
}
export async function fetchCryptoWatch(store: Store, fetcher: typeof fetch = fetch) {
  const key = process.env.COINGECKO_API_KEY;
  if (!key) throw Error("COINGECKO_API_KEYが未設定です");
  const cached = await store.read("crypto/watch-v2.json", null);
  if (cached && cryptoAssets.every((asset) => cached.assets?.some((item: { id: string }) => item.id === asset.id)) && Date.now() - Date.parse(cached.fetchedAt) < 3600000) return cached;
  let response: Response;
  try {
    response = await fetcher(`https://api.coingecko.com/api/v3/simple/price?ids=${cryptoAssets.map((asset) => asset.id).join(",")}&vs_currencies=jpy&include_24hr_change=true&include_last_updated_at=true`, {headers:{"x-cg-demo-api-key":key},signal:AbortSignal.timeout(15000)});
  } catch { throw Error("CoinGeckoに接続できません。時間をおいて再試行してください。"); }
  if (!response.ok) throw Error(`CoinGecko取得失敗（HTTP ${response.status}）。キーや利用枠を確認してください。`);
  const assets = [];
  for (const asset of parseCryptoQuotes(await response.json())) {
    let prices: [number, number][] = [];
    let historyError: string | null = null;
    try {
      const history = await fetcher(`https://api.coingecko.com/api/v3/coins/${asset.id}/market_chart?vs_currency=jpy&days=7`, {headers:{"x-cg-demo-api-key":key},signal:AbortSignal.timeout(15000)});
      if (!history.ok) throw Error(`HTTP ${history.status}`);
      prices = z.object({prices:z.array(z.tuple([z.number().finite().positive(),z.number().finite().positive()])).min(2)}).parse(await history.json()).prices.sort((a,b)=>a[0]-b[0]);
    } catch { historyError = "価格履歴を取得できませんでした。時間をおいて再取得してください。"; }
    assets.push({...asset, prices, historyError});
  }
  const result = {fetchedAt:new Date().toISOString(), assets};
  await store.write("crypto/watch-v2.json", result);
  return result;
}
