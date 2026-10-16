import type { Service } from "./service";
import type { Calendar } from "../../../packages/core/index";
import { BOTTOM_CONFIG } from "../../../packages/core/bottom-score";
import { HUNTER_CONFIG } from "../../../packages/core/hunter";
import { HUNTER_METHOD } from "../../../packages/core/hunter-schema";
import { hash, rawDailySchema, type RawDaily, type RawObservation } from "../../../packages/integrations/adjusted-series";
import type { Checkpoint } from "../../../packages/integrations/market-ingestion";

export const hunterShard = (code: string) => String(parseInt(hash(code).slice(0, 4), 16) % 64);
export type HunterIndex = { schemaVersion: 1; methodVersion: typeof HUNTER_METHOD; id: string; asOf: string; cutoff: string; dates: string[]; shards: string[]; inputIds: string[] };
// One date/page is materialized at a time. Disk shards avoid N symbols × all-market pages.
export async function buildHunterIndex(service: Service, asOf: string, cutoff: string, from: string, cancelled: () => Promise<boolean> = async () => false) {
  const calendar = await service.store.read<Calendar>("market/calendar.json", []);
  const dates = calendar.filter(d => d.open && d.date >= from && d.date <= asOf).map(d => d.date).sort();
  if (dates.length > 5500) throw Error("1ジョブの履歴は5500営業日までです");
  const inputs: { date: string; file: string; cp: Checkpoint }[] = [];
  for (const date of dates) {
    for (const file of (await service.store.files(`market/ingestion/${date}`)).filter(f => f.endsWith("/checkpoint.json"))) {
      const cp = await service.store.read<Checkpoint>(file);
      if (cp.status === "completed" && cp.pages.every(p => Number.isFinite(Date.parse(p.observedAt)) && p.observedAt <= cutoff)) inputs.push({ date, file, cp });
    }
  }
  const inputIds = inputs.map(i => hash([i.file, i.cp.pages, i.cp.masterHash]));
  const id = hash([service.mode, asOf, cutoff, dates, inputIds, BOTTOM_CONFIG, HUNTER_CONFIG]);
  const base = `market/hunter/indexes/${id}`;
  const old = await service.store.read<HunterIndex | null>(`${base}/manifest.json`, null);
  if (old) return old;
  const shards: string[] = [];
  for (const date of dates) {
    if (await cancelled()) throw Error("走査をキャンセルしました");
    const groups = new Map<string, RawObservation[]>();
    for (const input of inputs.filter(i => i.date === date)) {
      for (const page of input.cp.pages) {
        const rows = await service.store.read<RawDaily[]>(`${input.file.slice(0, -16)}/pages/${page.hash}.json`);
        if (hash(rows) !== page.hash) throw Error("取得ページが破損しています");
        if (rows.length > 20000) throw Error("1ページの安全上限を超えています");
        for (const raw of rows) {
          const row = rawDailySchema.parse(raw);
          if (row.Date !== date) throw Error("原本の日付が一致しません");
          const key = hunterShard(row.Code);
          const entries = groups.get(key) ?? [];
          entries.push({ row, observedAt: page.observedAt, revisionId: hash(row) });
          if (entries.length > 50000) throw Error("訂正履歴の安全上限を超えています");
          groups.set(key, entries);
        }
      }
    }
    for (const [shard, entries] of groups) {
      const key = `${base}/shards/${date}/${shard}.json`;
      await service.store.lock(async () => { if (!(await service.store.read(key, null))) await service.store.write(key, entries, true); });
      shards.push(`${date}/${shard}`);
    }
  }
  const manifest: HunterIndex = { schemaVersion: 1, methodVersion: HUNTER_METHOD, id, asOf, cutoff, dates, shards, inputIds };
  await service.store.lock(async () => { if (!(await service.store.read(`${base}/manifest.json`, null))) await service.store.write(`${base}/manifest.json`, manifest, true); });
  return manifest;
}
export async function readHunterObservations(service: Service, index: HunterIndex, code: string) {
  const rows: RawObservation[] = [];
  const shard = hunterShard(code), exists = new Set(index.shards);
  for (const date of index.dates) {
    if (!exists.has(`${date}/${shard}`)) continue;
    const entries = await service.store.read<RawObservation[]>(`market/hunter/indexes/${index.id}/shards/${date}/${shard}.json`);
    rows.push(...entries.filter(e => e.row.Code === code));
    if (rows.length > 100000) throw Error("1銘柄のrevision上限を超えています");
  }
  // Use the contiguous tail; listing dates are not fabricated for IPOs.
  const have = new Set(rows.map(r => r.row.Date));
  let start = index.dates.length;
  while (start > 0 && have.has(index.dates[start - 1])) start--;
  return { observations: rows.filter(r => r.row.Date >= (index.dates[start] ?? "9999")), continuousSessions: index.dates.length - start };
}
