import type { Store } from "../packages/storage/index";
import { calendar } from "./demo";
import { hash } from "../packages/integrations/adjusted-series";
export async function syntheticHunterMarket(store: Store, symbols = 2000) {
  if (!Number.isInteger(symbols) || symbols < 1 || symbols > 5000) throw Error("fixture銘柄数が不正です");
  const days = calendar().filter(d => d.open && d.date <= "2026-10-09").slice(-80);
  const codes = Array.from({ length: symbols }, (_,i) => String(10000+i*10));
  await store.write("market/calendar.json", calendar());
  for (const d of days) {
    const rows = codes.map(Code => ({ Code, Date: d.date, O: 100, H: 101, L: 99, C: 100, Vo: 1000000, Va: 200000000, AdjFactor: 1, ExRT: null }));
    const id = hash(rows), base = `market/ingestion/${d.date}/initial`;
    await store.write(`${base}/pages/${id}.json`, rows);
    await store.write(`${base}/checkpoint.json`, { date: d.date, revision: "initial", status: "completed", pages: [{ hash: id, observedAt: `${d.date}T08:30:00.000Z`, count: rows.length }], seen: [] });
  }
  const asOf = days.at(-1)!.date, rows = codes.map(Code => ({ Code, Date: asOf, CoName: `fixture-${Code}`, Mkt: "0111", MktNm: "プライム", ProdCat: "011" }));
  await store.write(`market/master-snapshots/${asOf}/${hash(rows)}.json`, { date: asOf, observedAt: `${asOf}T08:30:00.000Z`, rows });
  return { asOf, from: days[0].date, cutoff: `${asOf}T14:59:59.999Z`, codes };
}
