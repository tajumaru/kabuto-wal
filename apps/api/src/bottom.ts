import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { snapshot } from "./dejavu";
import { bottomFeatures, sma } from "../../../packages/core/bottom-features";
import {
  BOTTOM_CONFIG,
  scoreBottom,
} from "../../../packages/core/bottom-score";
import {
  bottomAnalysisSchema,
  bottomQuerySchema,
} from "../../../packages/core/bottom-schema";
import type { Calendar } from "../../../packages/core/index";
import { readDerivedSeries } from "../../../packages/integrations/market-ingestion";

export async function analyzeBottom(
  service: Service,
  code: string,
  date?: string,
  now = new Date(),
) {
  const cutoff = date ? `${date}T14:59:59.999Z` : now.toISOString();
  const latest = await service.history(code);
  const derived = await readDerivedSeries(service.store, code, date, cutoff);
  const asOf =
    date ??
    [latest.at(-1)?.sessionDate, derived?.bars.at(-1)?.sessionDate]
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ??
    null;
  const selectedDerived =
    derived?.bars.at(-1)?.sessionDate === asOf ? derived : null;
  const rows = asOf
    ? (selectedDerived?.bars ?? (await snapshot(service, code, cutoff))).filter(
        (b) => b.sessionDate <= asOf,
      )
    : [];
  const window = rows.slice(-80);
  const cal = await service.store.read<Calendar>("market/calendar.json", []);
  const reasons: string[] = [],
    risks = ["topix_unknown", "news_earnings_unchecked"];
  const turnover = selectedDerived?.turnover.slice(-20);
  const averageTurnover20 =
    turnover?.length === 20 && turnover.every((t) => t.value !== null)
      ? turnover.reduce((sum, t) => sum + t.value!, 0) / 20
      : null;
  const liquidity =
    averageTurnover20 === null
      ? "unknown"
      : averageTurnover20 >= BOTTOM_CONFIG.minAverageTurnover
        ? "sufficient"
        : "low";
  if (liquidity !== "sufficient")
    risks.push(liquidity === "unknown" ? "liquidity_unknown" : "low_liquidity");
  if (!asOf || (!latest.length && !selectedDerived)) reasons.push("no_prices");
  else if (!rows.some((b) => b.sessionDate === asOf))
    reasons.push("asof_not_observed");
  if (window.length < 80) reasons.push("insufficient_history");
  const sessions = cal
    .filter((d) => d.open && (!asOf || d.date <= asOf))
    .map((d) => d.date)
    .sort()
    .slice(-80);
  if (
    asOf &&
    (sessions.length < 80 ||
      window.length !== 80 ||
      sessions.some((d, i) => d !== window[i]?.sessionDate))
  )
    reasons.push("missing_sessions");
  if (
    window.length &&
    (!window[0].seriesId ||
      window.some(
        (b) => b.seriesId !== window[0].seriesId || b.providerCode !== code,
      ))
  )
    reasons.push("inconsistent_adjustment_series");
  if (
    window.some(
      (b) =>
        [b.adjOpen, b.adjHigh, b.adjLow, b.adjClose].some(
          (v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0,
        ) ||
        typeof b.volume !== "number" ||
        !Number.isFinite(b.volume) ||
        b.volume < 0 ||
        !Number.isFinite(b.factor) ||
        b.factor <= 0 ||
        b.adjHigh! < Math.max(b.adjOpen!, b.adjClose!) ||
        b.adjLow! > Math.min(b.adjOpen!, b.adjClose!) ||
        b.adjHigh! < b.adjLow!,
    )
  )
    reasons.push("invalid_ohlcv");
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const expected = cal
    .filter(
      (d) =>
        d.open &&
        (d.date < today ||
          (d.date === today && now.toISOString() >= `${today}T08:30:00.000Z`)),
    )
    .map((d) => d.date)
    .sort()
    .at(-1);
  if (!date && asOf !== expected) risks.push("stale_data");
  if (service.mode !== "demo" && process.env.JQUANTS_PLAN === "Free")
    risks.push("delayed_data");
  if (
    window.length === 80 &&
    window.slice(-21, -1).every((b) => b.volume === 0)
  )
    reasons.push("volume_history_empty");
  const f = reasons.length ? null : bottomFeatures(window);
  const scored = f && scoreBottom(f);
  if (f) {
    if (f.close < f.sma60 && f.sma60 < f.sma60Previous)
      risks.push("long_trend_down");
    if (f.low < f.priorLow5) risks.push("new_low");
    if (f.atrRatio > BOTTOM_CONFIG.highAtr) risks.push("high_volatility");
    if (f.supportDistance > BOTTOM_CONFIG.farSupport)
      risks.push("far_from_support");
    if (!f.volume) risks.push("no_trading_volume");
    if (f.volumeRatio === null) risks.push("volume_ratio_unknown");
  }
  const closes = f ? window.map((b) => b.adjClose!) : [],
    s5 = sma(closes, 5),
    s20 = sma(closes, 20);
  return bottomAnalysisSchema.parse({
    schemaVersion: 1,
    kind: "bottom_analysis",
    providerCode: code,
    mode: service.mode === "demo" ? "demo" : "research",
    source: service.mode === "demo" ? "fixture" : "jquants-v2",
    dataAsOf: asOf,
    requestedAsOf: date ?? null,
    cutoff,
    observedAt:
      window
        .map((b) => b.availableAt)
        .sort()
        .at(-1) ?? null,
    status: f ? "ready" : "unavailable",
    reasonCodes: [...new Set(reasons)],
    riskCodes: risks,
    score: scored ? scored.score : null,
    stage: scored ? scored.stage : "判定不能",
    featureVersion: BOTTOM_CONFIG.featureVersion,
    methodVersion: BOTTOM_CONFIG.methodVersion,
    configHash: createHash("sha256")
      .update(JSON.stringify(BOTTOM_CONFIG))
      .digest("hex"),
    inputRevisionIds: window.map((b) => b.revisionId),
    calibratedProbability: null,
    candidatePrerequisite: scored ? scored.candidatePrerequisite : false,
    liquidity,
    averageTurnover20,
    adjustmentVersion: selectedDerived?.adjustmentVersion ?? null,
    conditions: scored ? scored.conditions : [],
    indicators: f,
    chart: window
      .filter(() => !!f)
      .map((b, i) => ({
        sessionDate: b.sessionDate,
        close: b.adjClose!,
        sma5: s5[i],
        sma20: s20[i],
      })),
  });
}
export function registerBottom(app: FastifyInstance, service: Service) {
  app.get("/api/bottom/analysis", async (req, reply) => {
    const query = bottomQuerySchema.safeParse(req.query);
    if (!query.success)
      return reply
        .code(422)
        .send({ error: "銘柄コード・基準日を確認してください" });
    const master = await service.store.read<{ providerCode: string }[]>(
      "market/master.json",
      [],
    );
    if (!master.some((m) => m.providerCode === query.data.code))
      return reply.code(404).send({ error: "銘柄が見つかりません" });
    return analyzeBottom(service, query.data.code, query.data.asOf);
  });
}
