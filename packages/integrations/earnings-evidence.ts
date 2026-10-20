import { z } from "zod";
import { Store } from "../storage/index";
import { hash } from "./adjusted-series";
import { earningsCode, earningsSummarySchema, earningsDateSchema } from "../core/earnings-schema";

export const earningsEndpoint = z.enum(["summary", "earnings-date"]);
export type EarningsEndpoint = z.infer<typeof earningsEndpoint>;
const evidenceSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal("jquants-v2"), plan: z.literal("Light"),
  endpoint: earningsEndpoint, code: earningsCode, fetchedAt: z.string().datetime(),
  rawHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^[a-f0-9]{64}$/),
  raw: z.array(z.unknown()),
});
export type EarningsEvidence = z.infer<typeof evidenceSchema>;
const attemptSchema = z.object({
  endpoint: earningsEndpoint, code: earningsCode, fetchedAt: z.string().datetime(),
  status: z.enum(["success", "failed"]), reason: z.string(), revision: z.string().nullable(),
});
export type EarningsAttempt = z.infer<typeof attemptSchema>;
const base = (code: string, endpoint: EarningsEndpoint) => `market/earnings/${earningsCode.parse(code)}/${earningsEndpoint.parse(endpoint)}`;
export function validateEarningsRows(endpoint: EarningsEndpoint, code: string, rows: unknown[]) {
  const schema = endpoint === "summary" ? earningsSummarySchema : earningsDateSchema;
  const parsed = rows.map(r => schema.parse(r));
  if (parsed.some(r => r.Code !== code)) throw Error("決算原本に対象外銘柄");
  const seen = new Map<string,string>();
  for (const r of parsed) {
    const identity = endpoint === "summary" ? r.DiscNo : `${r.FQName}/${r.PubDate}`;
    const digest = hash(r);
    if (seen.has(identity) && seen.get(identity) !== digest) throw Error("同順位の決算データが矛盾しています");
    seen.set(identity,digest);
  }
  return parsed;
}
// Caller holds the existing Store writer lock. Each complete acquisition is immutable.
export async function preserveEarnings(store: Store, endpoint: EarningsEndpoint, code: string, raw: unknown[], fetchedAt: string) {
  validateEarningsRows(endpoint, code, raw);
  const body = { schemaVersion: 1 as const, source: "jquants-v2" as const, plan: "Light" as const,
    endpoint, code, fetchedAt, rawHash: hash(raw), raw };
  const evidence = evidenceSchema.parse({ ...body, revision: hash(body) });
  const key = `${base(code, endpoint)}/evidence/${evidence.revision}/original.json`;
  const existing = await store.read(key, null);
  if (existing && hash(existing) !== hash(evidence)) throw Error("保存済み決算原本の競合・改変");
  if (!existing) await store.write(key, evidence, true);
  if (hash(await store.read(key)) !== hash(evidence)) throw Error("決算原本保存後の照合に失敗");
  await recordEarningsAttempt(store, { endpoint, code, fetchedAt, status: "success", reason: raw.length ? "取得完了" : "APIの対象データなし（未収録・XBRL未提出・契約期間外等の可能性）", revision: evidence.revision });
  return evidence;
}
export async function recordEarningsAttempt(store: Store, value: EarningsAttempt) {
  const attempt = attemptSchema.parse(value), key = `${base(attempt.code, attempt.endpoint)}/attempts/${hash(attempt)}/original.json`;
  if (!await store.read(key, null)) await store.write(key, attempt, true);
}
export async function readEarningsAt(store: Store, code: string, endpoint: EarningsEndpoint, cutoff: string) {
  z.string().datetime().parse(cutoff);
  const evidence: EarningsEvidence[] = [];
  for (const key of await store.files(`${base(code, endpoint)}/evidence`)) {
    const e = evidenceSchema.parse(await store.read(key)), { revision, ...body } = e;
    if (e.code !== code || e.endpoint !== endpoint || hash(body) !== revision || hash(e.raw) !== e.rawHash || !key.endsWith(`/${revision}/original.json`)) throw Error("決算原本の整合性エラー");
    validateEarningsRows(endpoint, code, e.raw);
    if (e.fetchedAt <= cutoff) evidence.push(e);
  }
  const attempts: EarningsAttempt[] = [];
  for (const key of await store.files(`${base(code, endpoint)}/attempts`)) {
    const a = attemptSchema.parse(await store.read(key));
    if (a.code !== code || a.endpoint !== endpoint || !key.endsWith(`/${hash(a)}/original.json`)) throw Error("決算取得記録の整合性エラー");
    if (a.fetchedAt <= cutoff) attempts.push(a);
  }
  for (const a of attempts) {
    if (a.status === "success" && !evidence.some(e=>e.revision===a.revision && e.fetchedAt===a.fetchedAt)) throw Error("決算取得記録の参照原本がありません");
  }
  return { evidence: evidence.sort((a,b) => Date.parse(a.fetchedAt)-Date.parse(b.fetchedAt) || a.revision.localeCompare(b.revision)),
    // A failure at the same timestamp must not be hidden by directory iteration order.
    attempt: attempts.sort((a,b) => Date.parse(a.fetchedAt)-Date.parse(b.fetchedAt) || Number(a.status === "failed")-Number(b.status === "failed") || hash(a).localeCompare(hash(b))).at(-1) ?? null };
}
