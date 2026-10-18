import type { Service } from "./service";
import type { Bar, Calendar } from "../../../packages/core/index";
import {
  parseScoutIntent,
  type ScoutIntent,
} from "../../../packages/core/bottom-scout-intent";
import { scoutIndicators } from "../../../packages/core/bottom-scout-indicators";
import {
  scoreScout,
  SCOUT_METHOD,
} from "../../../packages/core/bottom-scout-score";
import { scoutDejavu } from "../../../packages/core/bottom-scout-dejavu";
import {
  scoutReplySchema,
  scoutReportSchema,
  scoutRowSchema,
  type ScoutReport,
  type ScoutReply,
} from "../../../packages/core/bottom-scout-schema";
import { hash } from "../../../packages/integrations/adjusted-series";
import { readDerivedSeries } from "../../../packages/integrations/market-ingestion";
import { dataWindow } from "../../../packages/integrations/jquants-plan";
import { snapshot } from "./dejavu";
import { analyzeBottom } from "./bottom";
import { bottomAnalysisSchema } from "../../../packages/core/bottom-schema";
import type { z } from "zod";
import { hunterJobFor } from "./hunter";
import {
  hunterJobSchema,
  hunterUniverseSchema,
} from "../../../packages/core/hunter-schema";
import { readHunterDetail } from "./hunter-consistency";
import { readHunterSeries } from "./hunter-research";
export const SCOUT_BASE = "research/scout";
export const scoutReportKey = (id: string) =>
  `${SCOUT_BASE}/reports/${id}/original.json`;
export async function readScoutReport(s: Service, id: string) {
  const r = scoutReportSchema.parse(await s.store.read(scoutReportKey(id))),
    { reportId, ...body } = r;
  if (
    reportId !== id ||
    hash(body) !== id ||
    r.mode !== (s.mode === "demo" ? "demo" : "research")
  )
    throw Error("探索原本のhashまたはデータ区分が一致しません");
  return r;
}
const todayOf = (now: Date) =>
  now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const previousDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
function reply(
  s: Service,
  intent: ScoutIntent,
  now: Date,
  values: Partial<ScoutReply>,
) {
  return scoutReplySchema.parse({
    methodVersion: SCOUT_METHOD,
    status: "insufficient-data",
    intent: intent.kind,
    requestedCount: intent.count,
    requestedAsOf: intent.date,
    asOf: null,
    answeredAt: now.toISOString(),
    reportId: null,
    mode: s.mode === "demo" ? "demo" : "research",
    source: s.mode === "demo" ? "fixture" : "jquants-v2",
    scope: null,
    rows: [],
    review: null,
    memoryReferences: [],
    notes: [],
    ...values,
  });
}
// Caller holds Store lock (the existing /api/chat boundary). No external connections.
export async function scoutResearch(
  s: Service,
  question: string,
  selectedCode?: string,
  now = new Date(),
): Promise<ScoutReply> {
  const intent = parseScoutIntent(question, selectedCode);
  if (!intent) throw Error("底打ち探索の質問ではありません");
  const master = await s.store.read<{ providerCode: string; name: string }[]>(
    "market/master.json",
    [],
  );
  if (!intent.code) {
    const named = master.filter(
      (m) => m.name.length >= 2 && question.includes(m.name),
    );
    if (named.length === 1) {
      intent.code = named[0].providerCode;
      intent.kind = "detail";
      intent.needsCode = false;
    } else if (named.length > 1)
      return reply(s, intent, now, {
        status: "clarification",
        notes: [
          "銘柄名が複数見つかりました。証券コードを1つ指定してください。",
        ],
      });
  }
  if (intent.needsCode)
    return reply(s, intent, now, {
      status: "clarification",
      notes: [
        "調べる銘柄の証券コードを入力するか、銘柄選択欄で選んでから聞いてね。",
      ],
    });
  const today = todayOf(now),
    date =
      intent.date ??
      (intent.relative === "yesterday" ? previousDate(today) : null);
  if (date && date > today)
    return reply(s, intent, now, {
      status: "clarification",
      requestedAsOf: date,
      notes: ["未来の日付では分析できません。"],
    });
  if (intent.kind === "review")
    return (await import("./bottom-scout-journal")).reviewScoutQuestion(
      s,
      intent,
      date ?? previousDate(today),
      now,
    );
  const calendar = await s.store.read<Calendar>("market/calendar.json", []),
    plan = process.env.JQUANTS_PLAN || "Free",
    window = s.mode === "demo" ? null : dataWindow(plan, today),
    maxSymbols = Math.max(
      1,
      Math.min(200, Math.floor(Number(process.env.SCOUT_MAX_SYMBOLS) || 50)),
    );
  let universe = master,
    jobId = await hunterJobFor(s, date ? { asOf: date } : {}),
    job = jobId
      ? hunterJobSchema.parse(
          await s.store.read(`market/hunter/jobs/${jobId}.json`),
        )
      : null;
  if (
    job &&
    (job.mode !== (s.mode === "demo" ? "demo" : "research") ||
      job.status !== "completed" ||
      job.cutoff > now.toISOString() ||
      (date && (job.input.asOf !== date || job.cutoff > `${date}T14:59:59.999Z`)))
  ) {
    job = null;
    jobId = null;
  }
  if (job?.universeId) {
    const u = hunterUniverseSchema.parse(
      await s.store.read(`market/hunter/universe/${job.universeId}.json`),
    );
    if (
      u.asOf !== job.input.asOf ||
      u.cutoff !== job.cutoff ||
      u.mode !== job.mode
    )
      throw Error("取得済み母集団とジョブの条件が不一致です");
    universe = u.entries
      .filter((e) => e.included)
      .map((e) => ({ providerCode: e.code, name: e.name }));
  }
  const sorted = [...new Map(universe.map(m=>[m.providerCode,m])).values()].sort((a, b) =>
      a.providerCode.localeCompare(b.providerCode),
    ),
    selected = intent.code
      ? sorted.filter((m) => m.providerCode === intent.code)
      : sorted.slice(0, maxSymbols),
    cutoff = date ? `${date}T14:59:59.999Z` : now.toISOString(),
    loaded: {
      code: string;
      name: string;
      bars: Bar[];
      derived: Awaited<ReturnType<typeof readDerivedSeries>> | null;
    }[] = [];
  if (intent.code && !selected.length)
    return reply(s, intent, now, {
      status: "clarification",
      notes: [
        "取得済みの銘柄一覧に見つかりません。日足取得画面で銘柄を確認してください。",
      ],
    });
  const excluded: Record<string, number> = {},
    noteErrors: string[] = [];
  for (const m of selected) {
    try {
      const derived = job
          ? null
          : await readDerivedSeries(
              s.store,
              m.providerCode,
              date ?? undefined,
              cutoff,
            ),
        bars = job
          ? (await readHunterSeries(s, job.id, m.providerCode)).bars
          : (derived?.bars ?? (await snapshot(s, m.providerCode, cutoff)));
      loaded.push({
        code: m.providerCode,
        name: m.name,
        bars: bars.filter(
          (b) =>
            b.sessionDate <= (date ?? window?.to ?? today) &&
            b.availableAt <= cutoff,
        ),
        derived,
      });
    } catch {
      excluded["取得系列を検証できない"] =
        (excluded["取得系列を検証できない"] ?? 0) + 1;
    }
  }
  const asOf =
    date ??
    job?.input.asOf ??
    loaded
      .flatMap((m) => m.bars.at(-1)?.sessionDate ?? [])
      .sort()
      .at(-1);
  if (!asOf)
    return reply(s, intent, now, {
      requestedAsOf: date,
      notes: [
        "分析できる取得済み日足がありません。日足取得または底打ちハンターから契約範囲内のデータを取得してください。質問からの外部取得は行っていません。",
      ],
    });
  const inputHash = hash([
      SCOUT_METHOD,
      s.mode,
    plan,
      asOf,
      job?.analysisId ?? null,
      selected,
      loaded.map((m) => [
        m.code,
        hash(m.bars),
      ]),
      calendar.filter((d) => d.date <= asOf),
      maxSymbols,
    ]),
    cacheKey = `${SCOUT_BASE}/cache/${inputHash}.json`,
    cached = await s.store.read<{ reportId: string } | null>(cacheKey, null);
  let report: ScoutReport;
  if (cached) {
    report = await readScoutReport(s, cached.reportId);
    if (report.inputHash !== inputHash)
      throw Error("探索キャッシュの入力不一致");
  } else {
    const rows: ScoutReport["rows"] = [];
    for (const m of loaded) {
      try {
        const analysis: z.infer<typeof bottomAnalysisSchema> = job
          ? (await readHunterDetail(s, job, m.code)).analysis
          : await analyzeBottom(s, m.code, asOf, now, {
              cutoff,
              series: m.derived,
              calendar,
            });
        if (analysis.status !== "ready" || analysis.dataAsOf !== asOf) {
          for (const reason of analysis.reasonCodes.length
            ? analysis.reasonCodes
            : ["基準日のデータ不足"])
            excluded[reason] = (excluded[reason] ?? 0) + 1;
          continue;
        }
        const f = scoutIndicators(
            analysis.chart.map((b) => ({
              date: b.sessionDate,
              open: b.open ?? NaN,
              high: b.high ?? NaN,
              low: b.low ?? NaN,
              close: b.close,
              volume: b.volume ?? NaN,
            })),
          ),
          pre = scoreScout(f);
        let similar = null;
        if (pre.score >= 55 || intent.kind === "detail")
          try {
            similar = scoutDejavu(m.bars, asOf, analysis.cutoff, calendar);
          } catch {
            noteErrors.push(
              `${m.code}：類似相場に使える履歴が不足しています。`,
            );
          }
        const scored = scoreScout(
          f,
          similar?.bestSimilarity === null || !similar
            ? null
            : {
                score: similar.bestSimilarity,
                sampleCount: similar.sampleCount,
              },
        );
        rows.push(
          scoutRowSchema.parse({
            hunterJobId: job?.id ?? null,
            code: m.code,
            name: m.name,
            asOf,
            observedAt: analysis.observedAt,
            score: scored.score,
            candidate: scored.candidate,
            contributions: scored.contributions,
            indicators: {
              rsi14: f.rsi14,
              macd: f.macd,
              signal: f.signal,
              sma5: f.sma5,
              sma25: f.sma25,
              sma75: f.sma75,
              bollingerLower: f.bollinger.lower,
              bollingerUpper: f.bollinger.upper,
              volumeRatio: f.volumeRatio,
              drawdown75: f.drawdown75,
            },
            risks: [
              ...scored.risks,
              ...analysis.riskCodes.map(
                (r) =>
                  ({
                    low_liquidity: "売買代金が少ない銘柄です",
                    liquidity_unknown: "売買代金を確認できていません",
                    topix_unknown: "市場全体の地合いは未確認です",
                    news_earnings_unchecked: "決算・ニュースは未確認です",
                    delayed_data: "契約プランによる遅延データです",
                  } as Record<string,string>)[r] ?? r,
              ),
            ],
            inputRevisionIds: analysis.inputRevisionIds,
            seriesId:
              m.bars.find((b) => b.sessionDate === asOf)?.seriesId ?? null,
            similar,
            chart: analysis.chart
              .slice(-20)
              .map((b) => ({ date: b.sessionDate, close: b.close })),
          }),
        );
      } catch {
        excluded["指標・原本の整合性を確認できない"] =
          (excluded["指標・原本の整合性を確認できない"] ?? 0) + 1;
      }
    }
    const scope = {
        total: universe.length,
        examined: selected.length,
        analyzable: rows.length,
        maxSymbols,
        source: job ? ("hunter-snapshot" as const) : ("saved-master" as const),
        excluded,
        partial:
          selected.length < universe.length || rows.length < selected.length,
      },
      body = {
        schemaVersion: 1 as const,
        methodVersion: SCOUT_METHOD,
        reportId: "0".repeat(64),
        inputHash,
        createdAt: now.toISOString(),
        asOf,
        cutoff: job?.cutoff ?? cutoff,
        mode: s.mode === "demo" ? ("demo" as const) : ("research" as const),
        recordingMode:
          asOf === today ? ("live" as const) : ("research" as const),
        scope,
        rows: rows.sort(
          (a, b) => b.score - a.score || a.code.localeCompare(b.code),
        ),
        notes: [
          "取得済みの対象内での探索です。日本株全市場を網羅するランキングではありません。",
          "スコアは条件の一致度で、上昇確率・投資推奨ではありません。",
          `J-Quantsプラン：${s.mode === "demo" ? "DEMO（架空データ）" : plan}。追加の外部取得は0回。`,
          ...(asOf !== today
            ? [
                `今日の株価ではありません。保存済みデータの基準日は${asOf}です。`,
              ]
            : []),
          ...(window && window.to < today
            ? [`契約上の取得可能最終日は${window.to}です。`]
            : []),
          ...noteErrors.slice(0, 10),
        ],
      };
    const { reportId: unused, ...identity } = body;
    void unused;
    report = scoutReportSchema.parse({ ...body, reportId: hash(identity) });
    await s.store.write(scoutReportKey(report.reportId), report, true);
    await s.store.write(cacheKey, { reportId: report.reportId });
  }
  const rows =
      intent.kind === "detail"
        ? report.rows.filter((r) => r.code === intent.code)
        : report.rows.filter((r) => r.candidate).slice(0, intent.count),
    status = rows.length
      ? "ready"
      : report.rows.length
        ? "no-candidates"
        : "insufficient-data";
  return reply(s, intent, now, {
    status,
    requestedAsOf: date,
    asOf: report.asOf,
    reportId: report.reportId,
    scope: report.scope,
    rows,
    notes: report.notes,
  });
}
