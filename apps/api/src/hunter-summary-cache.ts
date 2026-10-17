import { promises as fs } from "node:fs";
import type { Service } from "./service";
import { hash } from "../../../packages/integrations/adjusted-series";

type Entry = { key: string; at: number; until: number; result: unknown };
const cache = new WeakMap<Service, Entry>();
// Filenames carry immutable revision identities; timestamps also detect repaired/replaced JSON.
export async function hunterSummaryInputs(service: Service) {
  const files = (await Promise.all(["prices", "revisions", "market/ingestion"].map(p => service.store.files(p)))).flat().sort();
  const descriptors: unknown[] = [];
  for (let i=0;i<files.length;i+=32) descriptors.push(...await Promise.all(files.slice(i,i+32).map(async key => {
    const stat = await fs.stat(service.store.path(key), { bigint: true });
    return [key, stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
  })));
  const calendar = await service.store.read("market/calendar.json", []);
  return { stamp: hash([descriptors, calendar]), files: files.filter(k => !k.includes("/pages/")) };
}
export function readHunterSummary<T>(service: Service, key: string, now: Date): T | null {
  const saved = cache.get(service), at = now.getTime();
  return saved?.key === key && at >= saved.at && at < saved.until ? structuredClone(saved.result) as T : null;
}
export async function saveHunterSummary<T>(service: Service, key: string, now: Date, files: string[], result: T, additionalValues:unknown[] = []) {
  // Expire exactly when an already-stored future observation becomes known, not just after a TTL.
  let until = Date.parse(`${now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })}T15:00:00.000Z`);
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key,v] of Object.entries(value)) {
      if (["availableAt","observedAt","createdAt","generatedAt","recordedAt","cutoff","evaluatedCutoff"].includes(key) && typeof v === "string") {
        const time = Date.parse(v); if (time > now.getTime()) until = Math.min(until, time);
      } else if (typeof v === "object") visit(v);
    }
  };
  visit(additionalValues);
  for (let i=0;i<files.length;i+=32) for (const value of await Promise.all(files.slice(i,i+32).map(f => service.store.read<unknown>(f)))) visit(value);
  // One bounded result per Service. Nothing survives a restart or leaks across data roots.
  if (Buffer.byteLength(JSON.stringify(result)) <= 4*1024*1024) cache.set(service, { key, at: now.getTime(), until, result: structuredClone(result) });
}
