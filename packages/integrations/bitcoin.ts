import { z } from "zod";
import type { Store } from "../storage/index";
const point = z.tuple([z.number().finite().positive(), z.number().finite().positive()]);
const schema = z.object({ prices: z.array(point).min(2) });
export async function bitcoin(store: Store) {
  const key = process.env.COINGECKO_API_KEY;
  if (!key) throw Error("COINGECKO_API_KEYが未設定です");
  const cache = await store.read("crypto/bitcoin.json", null);
  if (cache && Date.now() - Date.parse(cache.fetchedAt) < 3600000) return cache;
  let response: Response;
  try {
    response = await fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=jpy&days=90", {
      headers: { "x-cg-demo-api-key": key }, signal: AbortSignal.timeout(15000),
    });
  } catch { throw Error("CoinGeckoに接続できません。時間をおいて再試行してください。"); }
  if (!response.ok) throw Error(`CoinGecko取得失敗（HTTP ${response.status}）。${response.status === 429 ? "無料枠の制限の可能性があります。時間をおいて再試行してください。" : "Demo APIキーの設定を確認してください。"}`);
  const { prices } = schema.parse(await response.json());
  prices.sort((a,b) => a[0] - b[0]);
  const data = { source: "CoinGecko", currency: "JPY", fetchedAt: new Date().toISOString(), prices };
  await store.write("crypto/bitcoin.json", data);
  return data;
}
// Pick observations at or before the Tokyo stock close; never use future samples.
export function bitcoinAt(prices: [number, number][], sessionDate: string) {
  const close = Date.parse(`${sessionDate}T15:30:00+09:00`);
  const p = prices.filter(([t]) => t <= close).at(-1);
  return p && close - p[0] <= 7200000 ? p : null;
}
