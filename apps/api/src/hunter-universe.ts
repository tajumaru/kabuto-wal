import { z } from "zod";
import type { Service } from "./service";
import { hash } from "../../../packages/integrations/adjusted-series";
import { HUNTER_METHOD, hunterUniverseSchema, universeEntrySchema } from "../../../packages/core/hunter-schema";

export function classifyMaster(raw: unknown, asOf: string) {
  const r = z.object({ Code: z.string().regex(/^[A-Z0-9]{5}$/), CoName: z.string(), Date: z.string().date(),
    Mkt: z.string(), MktNm: z.string().optional(), ProdCat: z.string().optional() }).parse(raw);
  const reasons: string[] = [];
  if (r.Date !== asOf) reasons.push("master_date_mismatch");
  if (r.ProdCat !== "011") reasons.push(r.ProdCat ? `excluded_product_${r.ProdCat}` : "unknown_product");
  if (!r.Code.endsWith("0")) reasons.push("non_common_share");
  if (!["0101", "0102", "0104", "0105", "0106", "0107", "0111", "0112", "0113"].includes(r.Mkt)) reasons.push("unknown_or_other_market");
  return universeEntrySchema.parse({ code: r.Code, name: r.CoName, market: r.Mkt, marketName: r.MktNm ?? r.Mkt,
    productCategory: r.ProdCat ?? null, listingStatus: "present_at_asof", included: reasons.length === 0, reasons });
}
export async function buildHunterUniverse(service: Service, asOf: string, cutoff: string) {
  let rows: unknown[] = [], masterObservedAt: string | null = null, inputId = "no-known-master";
  if (service.mode === "demo") {
    const master = await service.store.read<{ providerCode: string; name: string }[]>("market/master.json", []);
    rows = master.map(m => ({ Code: m.providerCode, CoName: m.name, Date: asOf, Mkt: "0111", MktNm: "架空市場", ProdCat: "011" }));
    inputId = hash(["demo", rows]);
  } else {
    const snapshots = [];
    for (const file of await service.store.files(`market/master-snapshots/${asOf}`)) {
      const m = await service.store.read<{ date: string; rows: unknown[]; observedAt: string }>(file);
      if (m.date === asOf && Number.isFinite(Date.parse(m.observedAt)) && m.observedAt <= cutoff) snapshots.push(m);
    }
    snapshots.sort((a,b) => b.observedAt.localeCompare(a.observedAt) || hash(a.rows).localeCompare(hash(b.rows)));
    const m = snapshots[0];
    if (m) { rows = m.rows; masterObservedAt = m.observedAt; inputId = hash(m); }
  }
  const entries = rows.map(r => classifyMaster(r, asOf)).sort((a,b) => a.code.localeCompare(b.code));
  if (new Set(entries.map(e => e.code)).size !== entries.length) throw Error("ユニバースの銘柄が重複しています");
  const excludedReasons: Record<string, number> = {};
  for (const e of entries) for (const reason of e.reasons) excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
  const id = hash([service.mode, asOf, cutoff, inputId, HUNTER_METHOD]);
  const result = hunterUniverseSchema.parse({ schemaVersion: 1, methodVersion: HUNTER_METHOD, id,
    mode: service.mode === "demo" ? "demo" : "research", asOf, cutoff, masterObservedAt, inputId, entries, excludedReasons });
  await service.store.lock(async () => {
    const key = `market/hunter/universe/${id}.json`;
    if (!(await service.store.read(key, null))) await service.store.write(key, result, true);
  });
  return result;
}
