import type { Service } from "../apps/api/src/service";
import { demoBars, calendar } from "../fixtures/demo";
import { hash, type RawDaily } from "../packages/integrations/adjusted-series";

// Local raw fixtures only; no J-Quants provider is created.
export async function seedHunterRaw(service: Service, count = 140, candidateAt = count - 21) {
  const bars = demoBars("72030").slice(-count);
  await service.store.write("market/calendar.json", calendar());
  for (const [i, bar] of bars.entries()) {
    const t = i - (candidateAt - 79);
    const close = t >= 0 && t <= 79 ? (t < 74 ? 180 - 1.5*t : 70.5 + (t-73)*0.3) : 150 + 4*Math.sin(i/7);
    const row: RawDaily = { Code: "72030", Date: bar.sessionDate, O: close-0.2, H: close+0.5, L: close-0.6, C: close,
      Vo: i === candidateAt ? 2000000 : 1000000, Va: 200000000, AdjFactor: 1, ExRT: null };
    const master = [{ Code: "72030", Date: bar.sessionDate, CoName: "原本fixture", Mkt: "0111", MktNm: "プライム", ProdCat: "011" }];
    const id = hash([row]), masterHash = hash(master), base = `market/ingestion/${bar.sessionDate}/initial`;
    await service.store.write(`${base}/pages/${id}.json`, [row]);
    await service.store.write(`${base}/checkpoint.json`, { date: bar.sessionDate, revision: "initial", status: "completed", pages: [{ hash: id, observedAt: bar.availableAt, count: 1 }], seen: [], masterHash });
    await service.store.write(`market/master-snapshots/${bar.sessionDate}/${masterHash}.json`, { date: bar.sessionDate, observedAt: bar.availableAt, rows: master });
  }
  return { bars, asOf: bars[candidateAt].sessionDate, from: bars[0].sessionDate, cutoff: `${bars[candidateAt].sessionDate}T14:59:59.999Z` };
}
