import type { Service } from "./service";
import {
  targetDate,
  quantile,
  type Bar,
  type Calendar,
} from "../../../packages/core/index";
import type { ScoutIntent } from "../../../packages/core/bottom-scout-intent";
import {
  scoutReplySchema,
  scoutReviewSchema,
  type ScoutReport,
} from "../../../packages/core/bottom-scout-schema";
import { readDerivedSeries } from "../../../packages/integrations/market-ingestion";
import { hash } from "../../../packages/integrations/adjusted-series";
import { snapshot } from "./dejavu";
import { SCOUT_BASE, readScoutReport } from "./bottom-scout";
import { SCOUT_METHOD } from "../../../packages/core/bottom-scout-score";
import { z } from "zod";
async function currentSeries(s: Service, code: string, now: Date) {
  return (
    (await readDerivedSeries(s.store, code, undefined, now.toISOString()))
      ?.bars ?? (await snapshot(s, code, now.toISOString()))
  );
}
export function scoutOutcome(
  bars: Bar[],
  asOf: string,
  horizon: number,
  calendar: Calendar,
  now: Date,
) {
  const empty = {
    status: "unavailable" as const,
    reason: "期限と同じ調整系列の連続した日足が不足しています",
    actualReturn: null,
    maxDecline: null,
    revisionIds: [] as string[],
  };
  let target: string;
  try {
    target = targetDate(calendar, asOf, horizon);
  } catch {
    return {
      ...empty,
      status: "pending" as const,
      reason: "評価先の営業日カレンダーがまだありません",
    };
  }
  if (now.toISOString() < `${target}T08:30:00.000Z`)
    return {
      ...empty,
      status: "pending" as const,
      reason: "評価期限がまだ確定していません",
    };
  const expected = [
      asOf,
      ...calendar
        .filter((d) => d.open && d.date > asOf && d.date <= target)
        .map((d) => d.date)
        .sort(),
    ],
    path = expected.map((date) => bars.find((b) => b.sessionDate === date));
  if (
    path.length !== horizon + 1 ||
    path.some(
      (b) =>
        !b?.adjClose ||
        !b.adjLow ||
        b.availableAt > now.toISOString() ||
        b.seriesId !== path[0]?.seriesId,
    ) ||
    !path[0]?.seriesId
  )
    return empty;
  const valid = path as Bar[],
    base = valid[0].adjClose!;
  return {
    status: "evaluated" as const,
    reason: "期限後の同一調整系列で評価（元の判定は不変）",
    actualReturn: valid.at(-1)!.adjClose! / base - 1,
    maxDecline: Math.min(0, ...valid.slice(1).map((b) => b.adjLow! / base - 1)),
    revisionIds: valid.map((b) => b.revisionId),
  };
}
export async function evaluateScout(
  s: Service,
  report: ScoutReport,
  now = new Date(),
) {
  const calendar = await s.store.read<Calendar>("market/calendar.json", []),
    configured = process.env.SCOUT_BENCHMARK_CODE,
    benchmarkCode =
      configured && /^[0-9A-Z]{5}$/.test(configured) ? configured : null,
    benchmark = benchmarkCode
      ? await currentSeries(s, benchmarkCode, now).catch(() => [])
      : [],
    rows = [];
  for (const r of report.rows) {
    const bars = await currentSeries(s, r.code, now).catch(() => []);
    for (const horizon of [5, 10, 20]) {
      const outcome = scoutOutcome(bars, report.asOf, horizon, calendar, now),
        baseline = benchmarkCode
          ? scoutOutcome(benchmark, report.asOf, horizon, calendar, now)
          : null;
      rows.push({
        code: r.code,
        horizon,
        ...outcome,
        benchmarkReturn:
          baseline?.status === "evaluated" ? baseline.actualReturn : null,
      });
    }
  }
  const groups = [];
  for (const horizon of [5, 10, 20])
    for (const band of ["0–39", "40–59", "60–79", "80–100"])
      for (const candidate of [true, false]) {
        const members = report.rows.filter(
            (r) =>
              r.candidate === candidate &&
              (r.score < 40
                ? "0–39"
                : r.score < 60
                  ? "40–59"
                  : r.score < 80
                    ? "60–79"
                    : "80–100") === band,
          ),
          results = rows.filter(
            (r) =>
              r.horizon === horizon && members.some((m) => m.code === r.code),
          ),
          evaluated = results.filter((r) => r.status === "evaluated"),
          values = evaluated.map((r) => r.actualReturn!),
          diff = evaluated.flatMap((r) =>
            r.benchmarkReturn === null
              ? []
              : [r.actualReturn! - r.benchmarkReturn],
          );
        groups.push({
          horizon,
          band,
          candidate,
          eligible: results.filter((r) => r.status !== "pending").length,
          evaluated: evaluated.length,
          meanReturn: values.length
            ? values.reduce((a, b) => a + b, 0) / values.length
            : null,
          medianReturn: values.length ? quantile(values, 0.5) : null,
          upRatio: values.length
            ? values.filter((v) => v > 0).length / values.length
            : null,
          worstDecline: values.length
            ? Math.min(...evaluated.map((r) => r.maxDecline!))
            : null,
          meanBenchmarkDifference: diff.length
            ? diff.reduce((a, b) => a + b, 0) / diff.length
            : null,
          lowSample: values.length < 20,
        });
      }
  const review = scoutReviewSchema.parse({
    reportId: report.reportId,
    asOf: report.asOf,
    evaluatedAt: now.toISOString(),
    benchmarkCode,
    groups,
    rows,
    notes: [
      `記録区分：${report.recordingMode}。過去研究と実運用予測は混ぜません。`,
      "期限未確定の結果は成績から除外。候補以外も同じ取得範囲で集計します。",
      "上昇した割合は将来の成功確率ではありません。銘柄間の相関と選択バイアスは残ります。",
      "取引コスト・売買成立・配当を含まない調整価格の比較です。閾値や重みの自動変更はしません。",
      ...(benchmarkCode
        ? ["比較対象は設定した銘柄です。TOPIXと同一とは限りません。"]
        : ["比較対象の価格が未指定・未取得のためベンチマーク差は未評価です。"]),
    ],
  });
  const evaluationKey = `${SCOUT_BASE}/evaluations/${report.reportId}/${hash(review)}/original.json`;
  try {
    await s.store.write(evaluationKey, review, true);
  } catch (error) {
    // Identical repeated evaluations reuse their immutable original.
    const existing = await s.store.read(evaluationKey, null);
    if (!existing || hash(existing) !== hash(review)) throw error;
  }
  return review;
}
export async function reviewScoutQuestion(
  s: Service,
  intent: ScoutIntent,
  date: string,
  now: Date,
) {
  const files = (await s.store.files(`${SCOUT_BASE}/requests/${date}`)).filter((f) =>
    f.endsWith("/original.json"),
  );
  if (files.length > 1000)
    throw Error("振り返りの読込上限です。期間別の記録を整理してください。");
  const reports = [];
  for (const file of files) {
    const ref=z.object({reportId:z.string().regex(/^[a-f0-9]{64}$/),askedAt:z.string().datetime()}).parse(await s.store.read(file));
    if(ref.askedAt>now.toISOString()||new Date(ref.askedAt).toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"})!==date)continue;
    const r=await readScoutReport(s,ref.reportId);if(r.createdAt<=ref.askedAt)reports.push(r);
  }
  reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const report = reports[0] ?? null,
    review = report ? await evaluateScout(s, report, now) : null;
  return scoutReplySchema.parse({
    methodVersion: SCOUT_METHOD,
    status: report ? "review" : "insufficient-data",
    intent: "review",
    requestedCount: intent.count,
    requestedAsOf: date,
    asOf: report?.asOf ?? null,
    answeredAt: now.toISOString(),
    reportId: report?.reportId ?? null,
    mode: s.mode === "demo" ? "demo" : "research",
    source: s.mode === "demo" ? "fixture" : "jquants-v2",
    scope: report?.scope ?? null,
    rows: report?.rows.filter((r) => r.candidate).slice(0, intent.count) ?? [],
    review,
    memoryReferences: [],
    notes: report
      ? [
          `${date}に質問した記録から、当時返した候補を振り返っています。分析原本の株価基準日は${report.asOf}、記録区分は${report.recordingMode}です。翌日だけでは5・10・20営業日後の結果は未確定です。`,
        ]
      : [
          `${date}に質問して保存した探索記録がありません。後から計算した候補を、当時返した候補として表示しません。`,
        ],
  });
}
