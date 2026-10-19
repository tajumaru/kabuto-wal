import { createHash } from "node:crypto";
import { dejavuMemorySchema as storedSchema } from "../../../packages/core/dejavu-api-schema";
import type { z } from "zod";
import { dejavu } from "../../../packages/core/dejavu";
import { consensus, consensusComparison, dna } from "../../../packages/core/dejavu-consensus";
import type { Bar } from "../../../packages/core/index";
import { notice } from "../../../packages/core/assistant";
import type { Service } from "./service";
import {
  syncMemories,
  syncWarning,
  type MemoryProvider,
} from "../../../packages/integrations/index";

const namespace = (mode: string, code: string) =>
  `kabutowal:dejavu:v1:${mode}:${code}`;
export async function snapshot(service: Service, code: string, cutoff: string, strictRevisionSelection = false) {
  const records = await service.store.all<Bar | {
    kind: string; contentId?: string; availableAt?: string; seriesId?: string; bars?: Bar[];
    entries?: { sessionDate: string; availableAt: string; seriesId?: string }[];
  }>(`revisions/${code}`);
  const bodies = new Map(records.filter((r) => "kind" in r && r.kind === "price_content")
    .map((r) => {
      const bars = (r as { bars: Bar[] }).bars;
      return [createHash("sha256").update(JSON.stringify(bars)).digest("hex"), bars] as const;
    }));
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs)) throw Error("取得時点が不正です");
  const chosen = new Map<string, Bar>();
  const timestamps = new Map<string, number>();
  const ambiguous = new Set<string>();
  const identity=(bar:Bar)=>JSON.stringify(Object.fromEntries(Object.entries({...bar,availableAt:new Date(bar.availableAt).toISOString()}).sort(([a],[b])=>a.localeCompare(b))));
  let revisionCount = 0;
  const choose = (bar: Bar, availableAt = bar.availableAt, seriesId = bar.seriesId) => {
    revisionCount++;
    const timestamp = Date.parse(availableAt);
    if (!Number.isFinite(timestamp) || timestamp > cutoffMs) return;
    const previous = timestamps.get(bar.sessionDate);
    if (previous === undefined || previous < timestamp) {
      timestamps.set(bar.sessionDate, timestamp);
      chosen.set(bar.sessionDate, { ...bar, availableAt, seriesId });
      ambiguous.delete(bar.sessionDate);
    } else if(strictRevisionSelection&&previous===timestamp&&identity(chosen.get(bar.sessionDate)!)!==identity({...bar,availableAt,seriesId})) {
      ambiguous.add(bar.sessionDate);
    }
  };
  for (const record of records) {
    if (!("kind" in record) || record.kind === "price_revision") {
      choose(record as Bar);
    } else if (record.kind === "price_observation") {
      const body = bodies.get(record.contentId!);
      if (!body) throw Error("価格取得記録の参照先がありません");
      const entries = new Map(record.entries?.map((entry) => [entry.sessionDate, entry]));
      for (const bar of body) {
        const entry = entries.get(bar.sessionDate);
        choose(bar, entry?.availableAt ?? record.availableAt!, entry ? entry.seriesId : record.seriesId);
      }
    }
  }
  if (!revisionCount) for (const bar of await service.history(code)) choose(bar);
  if(strictRevisionSelection&&ambiguous.size)throw Error("同順位revisionの内容が矛盾しています");
  return [...chosen.values()].sort((a, b) =>
    a.sessionDate.localeCompare(b.sessionDate),
  );
}
export async function searchDejavu(
  service: Service,
  code: string,
  date?: string,
  compareCode = code,
  input?: { cutoff: string; series: Bar[]; compareSeries?: Bar[] },
) {
  const history = input?.series ?? await service.history(code);
  const asOf = date || history.at(-1)?.sessionDate;
  if (!asOf) throw Error("比較元の日足なし");
  const cutoff = input?.cutoff ?? (date ? `${asOf}T14:59:59.999Z` : new Date().toISOString());
  const querySnapshot = input?.series ?? await snapshot(service, code, cutoff);
  if (input && compareCode !== code && !input.compareSeries) throw Error("同じ取得経路の比較系列が必要です");
  const { statisticalExamples, ...result } = dejavu(
    compareCode === code
      ? querySnapshot
      : input?.compareSeries ?? await snapshot(service, compareCode, cutoff),
    querySnapshot,
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
    consensus: consensus(result.examples),
    statistics: consensusComparison(statisticalExamples),
    statisticsInputRevisionIds: input ? statisticalExamples.flatMap(e => e.revisionIds) : undefined,
    dna: result.examples.map(dna),
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
      error = syncWarning(await service.store.lock(async () =>
        syncMemories(service.store, await service.memoryProvider(), true),
      ));
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
  const local = new Map((entries as { recordId: string; active?: boolean; remoteDeletedAt?: string }[]).map(m => [m.recordId, m]));
  if (
    service.mode !== "demo" &&
    process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true"
  ) {
    try {
      provider =
        provider === undefined ? await service.memoryProvider() : provider;
      if (provider) {
        const batches = await Promise.all(
          [ns, legacyNs].map((targetNamespace) =>
            provider!.recall({
              query: `${code} カブまる デジャヴ相場 OHLCV 類似`,
              namespace: targetNamespace,
              limit: 20,
            }),
          ),
        );
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
      local.get(m.recordId)?.active === false || local.get(m.recordId)?.remoteDeletedAt ||
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
