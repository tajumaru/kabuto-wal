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
import { cohortPricePath,cohortPathOutcome } from "./hunter-cohort-evaluation";
import { forecastKey,readScoutForecast } from "./bottom-scout-forecast";
export async function currentScoutSeries(s: Service, code: string, now: Date) {
  return (
    (await readDerivedSeries(s.store, code, undefined, now.toISOString()))
      ?.bars ?? (await snapshot(s, code, now.toISOString(),true))
  );
}
export function scoutOutcome(
  bars: Bar[],
  asOf: string,
  horizon: number,
  calendar: Calendar,
  now: Date,
  requireIntradayLow = true,
) {
  const empty = {
    status: "unavailable" as const,
    reason: "期限と同じ調整系列の連続した日足が不足しています",
    actualReturn: null,
    maxDecline: null,
    revisionIds: [] as string[],
    target:null as string|null,up:null as boolean|null,maxRise:null as number|null,maxDrawdown:null as number|null,relapse:null as boolean|null,basePrice:null as number|null,targetPrice:null as number|null,dataAvailableAt:null as string|null,
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
      target,
      reason: "評価期限がまだ確定していません",
    };
  const valid=cohortPricePath(bars,asOf,target,calendar,now.toISOString()),metrics=cohortPathOutcome(bars,asOf,target,calendar,now.toISOString());
  if(!valid||!metrics||valid.length!==horizon+1||(requireIntradayLow&&valid.some(b=>!Number.isFinite(b.adjLow)||b.adjLow!<=0||b.adjLow!>b.adjClose!)))return {...empty,target};
  const
    base = valid[0].adjClose!;
  return {
    status: "evaluated" as const,
    reason: "期限後の同一調整系列で評価（元の判定は不変）",
    actualReturn: valid.at(-1)!.adjClose! / base - 1,
    maxDecline: valid.every(b=>Number.isFinite(b.adjLow)&&b.adjLow!>0&&b.adjLow!<=b.adjClose!)?Math.min(0, ...valid.slice(1).map((b) => b.adjLow! / base - 1)):null,
    revisionIds: valid.map((b) => b.revisionId),
    target,up:metrics.up,maxRise:metrics.maxRise,maxDrawdown:metrics.maxDrawdown,relapse:metrics.relapse,basePrice:metrics.basePrice,targetPrice:metrics.targetPrice,dataAvailableAt:metrics.dataAvailableAt,
  };
}
export async function evaluateScout(
  s: Service,
  report: ScoutReport,
  now = new Date(),
  options: {calendar?:Calendar;calendarIssue?:string;requiredTargets?:Record<string,string|null>;benchmarkCode?:string|null;forecastId?:string;loadSeries?:(code:string)=>Promise<Bar[]>} = {},
) {
  if(!options.forecastId&&await s.store.read(forecastKey(report),null)){
    const {forecast:p,report:original}=await readScoutForecast(s,forecastKey(report));
    if(hash(original)!==hash(report))throw Error("評価対象が予測原本と一致しません");
    const current=await s.store.read<Calendar>("market/calendar.json",[]),end=p.calendar.at(-1)?.date??p.asOf;
    const known=current.filter(d=>d.date>=p.asOf&&d.date<=end).sort((a,b)=>a.date.localeCompare(b.date));
    options={...options,forecastId:p.forecastId,calendar:p.calendar,requiredTargets:p.targets,benchmarkCode:p.benchmarkCode,calendarIssue:hash(known)!==p.calendarHash?"予測時点の営業日カレンダーから変更されています":undefined};
  }
  const calendar = options.calendar??await s.store.read<Calendar>("market/calendar.json", []),
    configured = process.env.SCOUT_BENCHMARK_CODE,
    benchmarkCode =
      options.benchmarkCode!==undefined?options.benchmarkCode:configured && /^[0-9A-Z]{5}$/.test(configured) ? configured : null,
    load=options.loadSeries??((code:string)=>currentScoutSeries(s,code,now)),
    benchmark = benchmarkCode
      ? await load(benchmarkCode).catch(() => [])
      : [],
    rows = [];
  for (const r of report.rows) {
    const bars = await load(r.code).catch(() => []);
    for (const horizon of [5, 10, 20]) {
      const raw = scoutOutcome(bars, report.asOf, horizon, calendar, now),
        issue=options.calendarIssue??(options.requiredTargets&&!options.requiredTargets[String(horizon)]?"予測時点の営業日期限が固定できていません":null),
        outcome=issue?{...scoutOutcome([],report.asOf,horizon,calendar,now),status:"unavailable" as const,reason:issue}:raw,
        baseline = benchmarkCode && !issue
          ? scoutOutcome(benchmark, report.asOf, horizon, calendar, now,false)
          : null;
      rows.push({
        code: r.code,
        horizon,
        ...outcome,
        benchmarkReturn:
          baseline?.status === "evaluated" ? baseline.actualReturn : null,
        benchmarkRevisionIds:baseline?.status==="evaluated"?baseline.revisionIds:[],
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
    methodVersion:"scout-outcome-v2",
    ...(options.forecastId?{forecastId:options.forecastId}:{}),
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
  const identity=(r:typeof review)=>{const {evaluatedAt,evaluationId,...body}=r;void evaluatedAt;void evaluationId;return hash(body);};
  review.evaluationId=identity(review);
  const evaluationKey = `${SCOUT_BASE}/evaluations/${report.reportId}/${review.evaluationId}/original.json`;
  const existing=await s.store.read(evaluationKey,null);
  if(existing){const parsed=scoutReviewSchema.parse(existing);if(parsed.evaluationId!==review.evaluationId||identity(parsed)!==review.evaluationId)throw Error("評価原本hashが一致しません");return parsed;}
  try {
    await s.store.write(evaluationKey, review, true);
  } catch (error) {
    // Identical repeated evaluations reuse their immutable original.
    const existing = await s.store.read(evaluationKey, null);
    if (!existing || existing.evaluationId!==review.evaluationId || identity(scoutReviewSchema.parse(existing)) !== review.evaluationId) throw error;
    return scoutReviewSchema.parse(existing);
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
    recordingMode: report?.recordingMode,
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
