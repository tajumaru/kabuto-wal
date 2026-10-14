import { createHash } from "node:crypto";
import { z } from "zod";
import { dejavu } from "../../../packages/core/dejavu";
import type { Bar } from "../../../packages/core/index";
import { notice } from "../../../packages/core/assistant";
import type { Service } from "./service";
import {
  syncMemories,
  type MemoryProvider,
} from "../../../packages/integrations/index";

const namespace = (mode: string, code: string) =>
  `kabutowal:dejavu:v1:${mode}:${code}`;
export async function snapshot(service: Service, code: string, cutoff: string) {
  const revisions = await service.store.all<Bar>(`revisions/${code}`);
  const rows = revisions.length ? revisions : await service.history(code);
  const chosen = new Map<string, Bar>();
  for (const b of rows) {
    if (
      Date.parse(b.availableAt) > Date.parse(cutoff) ||
      !Number.isFinite(Date.parse(b.availableAt))
    )
      continue;
    const old = chosen.get(b.sessionDate);
    if (!old || Date.parse(old.availableAt) < Date.parse(b.availableAt))
      chosen.set(b.sessionDate, b);
  }
  return [...chosen.values()].sort((a, b) =>
    a.sessionDate.localeCompare(b.sessionDate),
  );
}
export async function searchDejavu(
  service: Service,
  code: string,
  date?: string,
  compareCode = code,
) {
  const history = await service.history(code);
  const asOf = date || history.at(-1)?.sessionDate;
  if (!asOf) throw Error("比較元の日足なし");
  const cutoff = date ? `${asOf}T14:59:59.999Z` : new Date().toISOString();
  const result = dejavu(
    await snapshot(service, compareCode, cutoff),
    await snapshot(service, code, cutoff),
    asOf,
    cutoff,
    await service.store.read("market/calendar.json"),
  );
  const recordId = createHash("sha256")
    .update(
      JSON.stringify([
        service.mode,
        code,
        compareCode,
        asOf,
        result.featureVersion,
        result.inputRevisionIds,
        result.examples.map((e) => e.revisionIds),
      ]),
    )
    .digest("hex");
  return {
    ...result,
    recordId,
    providerCode: code,
    compareCode,
    mode: service.mode,
    source: service.mode === "demo" ? "fixture" : "jquants-v2",
    namespace: namespace(service.mode, code),
  };
}
export async function notifyDejavu(
  service: Service,
  result: Awaited<ReturnType<typeof searchDejavu>>,
) {
  if (!result.examples.length) return;
  const first = result.examples[0];
  const n = notice({
    kind: "dejavu",
    pose: "discover",
    providerCode: result.providerCode,
    name: result.providerCode,
    dataAsOf: result.asOf,
    observedAt: result.cutoff,
    mode: result.mode,
    source: result.source,
    title: "カブまるのデジャヴ相場を見つけたよ",
    text: `${result.mode === "demo" ? "架空データのデモ。" : "取得した実データ。"}${first.start}〜${first.end}と類似度${first.score.toFixed(1)}点。過去のその後は将来の予測ではないよ。`,
    metrics: {
      score: first.score,
      candidateCount: result.candidateCount,
      compareCode: result.compareCode,
    },
    evidenceIds: [result.recordId],
    href: `/similar?code=${result.providerCode}`,
  });
  await service.store.lock(async () => {
    if (!(await service.store.read(`notifications/${n.recordId}.json`, null)))
      await service.store.write(`notifications/${n.recordId}.json`, n, true);
  }, 1000);
}
export async function saveDejavu(
  service: Service,
  result: Awaited<ReturnType<typeof searchDejavu>>,
) {
  const key = `memories/${result.recordId}.json`;
  await service.store.lock(async () => {
    if (await service.store.read(key, null)) return;
    await service.store.write(
      key,
      {
        schemaVersion: 1,
        recordId: result.recordId,
        kind: "dejavu_memory",
        active: true,
        createdAt: new Date().toISOString(),
        mode: result.mode,
        source: result.source,
        providerCode: result.providerCode,
        namespace: result.namespace,
        dataAsOf: result.asOf,
        text: JSON.stringify(result),
        payload: result,
      },
      true,
    );
    await service.store.write(`sync/${result.recordId}.json`, {
      status: "pending",
    });
    await service.store.rebuild();
  });
  let error: string | undefined;
  if (
    service.mode !== "demo" &&
    process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true"
  ) {
    try {
      await service.store.lock(async () =>
        syncMemories(service.store, await service.memoryProvider(), true),
      );
    } catch {
      error = "MemWal接続を確認できません。保存済みJSONから再同期できます。";
    }
  }
  return {
    recordId: result.recordId,
    mode: service.mode,
    error,
    sync: await service.store.read(`sync/${result.recordId}.json`),
    externalAllowed:
      service.mode !== "demo" &&
      process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true",
  };
}
const storedSchema = z.object({
  kind: z.literal("dejavu_memory"),
  active: z.literal(true),
  recordId: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.string(),
  providerCode: z.string(),
  namespace: z.string(),
  createdAt: z.string().datetime(),
  dataAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  text: z.string(),
  payload: z.object({
    recordId: z.string(),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    mode: z.string(),
    providerCode: z.string(),
    featureVersion: z.literal("ohlcv-20-v1"),
    examples: z.array(
      z.object({
        start: z.string(),
        end: z.string(),
        score: z.number().finite().min(0).max(100),
      }),
    ),
  }),
});
export async function recallDejavu(
  service: Service,
  code: string,
  asOf: string,
  provider?: MemoryProvider | null,
) {
  const ns = namespace(service.mode, code);
  const legacyNs = ns.replace(/^kabutowal:/, "stock-memory:");
  let search = service.mode === "demo" ? "local-demo" : "local-fallback",
    error: string | undefined;
  const entries: unknown[] = await service.store.all("memories");
  if (
    service.mode !== "demo" &&
    process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true"
  ) {
    try {
      provider =
        provider === undefined ? await service.memoryProvider() : provider;
      if (provider) {
        const batches = await Promise.all([ns, legacyNs].map((targetNamespace) => provider!.recall({
          query: `${code} カブまる デジャヴ相場 OHLCV 類似`,
          namespace: targetNamespace,
          limit: 20,
        })));
        for (const r of batches.flatMap((batch) => batch.results)) {
          if (r.text.length > 200000) continue;
          try {
            entries.push(JSON.parse(r.text));
          } catch {
            /* untrusted result */
          }
        }
        search = "memwal-semantic";
      }
    } catch {
      error = "MemWal検索に失敗。ローカル保存を表示しています。";
    }
  }
  const valid = new Map<string, z.infer<typeof storedSchema>>();
  for (const item of entries) {
    const parsed = storedSchema.safeParse(item);
    if (!parsed.success) continue;
    const m = parsed.data;
    if (
      (m.namespace !== ns && m.namespace !== legacyNs) ||
      m.mode !== service.mode ||
      m.providerCode !== code ||
      m.dataAsOf > asOf ||
      m.payload.mode !== m.mode ||
      m.payload.providerCode !== code ||
      m.payload.recordId !== m.recordId ||
      m.payload.asOf !== m.dataAsOf ||
      Date.parse(m.createdAt) > Date.parse(`${asOf}T14:59:59.999Z`)
    )
      continue;
    valid.set(m.recordId, m);
  }
  return {
    search,
    error,
    mode: service.mode,
    namespace: ns,
    memories: [...valid.values()].slice(0, 20),
    note: "MemWalは意味検索。数値候補の全件列挙や類似スコア計算には使いません。",
  };
}
