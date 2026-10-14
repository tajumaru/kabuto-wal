import { z } from "zod";
export const barSchema = z.object({
  providerCode: z.string().regex(/^[A-Z0-9]{4,5}$/),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  close: z.number().positive().nullable(),
  adjClose: z.number().positive().nullable(),
  volume: z.number().nonnegative().nullable(),
  factor: z.number().positive(),
  revisionId: z.string(),
  availableAt: z.string(),
  seriesId: z.string().optional(),
  open: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
  low: z.number().nullable().optional(),
  rawVolume: z.number().nullable().optional(),
  adjOpen: z.number().nullable().optional(),
  adjHigh: z.number().nullable().optional(),
  adjLow: z.number().nullable().optional(),
});
export type Bar = z.infer<typeof barSchema>;
export type Calendar = { date: string; open: boolean }[];
export const direction = (r: number) =>
  r > 0.005 ? "up" : r < -0.005 ? "down" : "flat";
export function targetDate(calendar: Calendar, date: string, n: number) {
  const dates = calendar.filter((d) => d.open && d.date > date);
  if (dates.length < n) throw Error("取引カレンダー不足");
  return dates[n - 1].date;
}
export const quantile = (xs: number[], p: number) => {
  const a = [...xs].sort((a, b) => a - b);
  if (!a.length) throw Error("候補不足");
  const i = (a.length - 1) * p;
  return a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i % 1);
};
export function features(bars: Bar[], end: number) {
  const w = bars.slice(end - 20, end + 1);
  if (
    w.length !== 21 ||
    w.some((b) => b.adjClose === null || b.volume === null)
  )
    throw Error("日足欠損");
  const prices = w.map((b) => b.adjClose!);
  const returns = prices.slice(1).map((v, i) => v / prices[i] - 1);
  const mean = returns.reduce((a, b) => a + b, 0) / 20;
  const avg = prices.slice(1).reduce((a, b) => a + b, 0) / 20;
  const vol = w.slice(1).reduce((a, b) => a + b.volume!, 0) / 20;
  return {
    returns,
    shape: prices.map((v) => (v / prices[0]) * 100),
    vector: [
      prices[20] / prices[15] - 1,
      prices[20] / prices[0] - 1,
      Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / 20),
      vol ? w[20].volume! / vol : 0,
      prices[20] / avg - 1,
    ],
  };
}
export function similar(
  bars: Bar[],
  asOf: string,
  horizon = 20,
  queryBars: Bar[] = bars,
) {
  const end = bars.findIndex((b) => b.sessionDate === asOf);
  if (end < 20) throw Error("20営業日以上の日足が必要です");
  const queryEnd = queryBars.findIndex((b) => b.sessionDate === asOf);
  if (queryEnd < 20) throw Error("比較元の20営業日日足が不足");
  const query = features(queryBars, queryEnd);
  const candidates: { i: number; f: ReturnType<typeof features> }[] = [];
  for (let i = 20; i + horizon < end - 20; i++) {
    try {
      const f = features(bars, i);
      if (bars[i + horizon].availableAt > queryBars[queryEnd].availableAt)
        continue;
      candidates.push({ i, f });
    } catch {
      /* missing windows excluded */
    }
  }
  const scales = query.vector.map((_, j) => {
    const values = candidates.map((c) => c.f.vector[j]);
    const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    return (
      Math.sqrt(
        values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length || 1),
      ) || 1
    );
  });
  const ranked = candidates
    .map(({ i, f }) => ({
      index: i,
      id: bars[i].revisionId,
      start: bars[i - 20].sessionDate,
      end: bars[i].sessionDate,
      distance:
        Math.sqrt(
          f.vector.reduce(
            (a, v, j) => a + ((v - query.vector[j]) / scales[j]) ** 2,
            0,
          ) / 5,
        ) +
        Math.sqrt(
          f.shape.reduce((a, v, j) => a + (v - query.shape[j]) ** 2, 0) / 21,
        ) /
          10,
      shape: f.shape,
      future: Object.fromEntries(
        [1, 5, 20].map((n) => [
          n,
          i + n <= end && bars[i + n].adjClose
            ? bars[i + n].adjClose! / bars[i].adjClose! - 1
            : null,
        ]),
      ),
    }))
    .sort((a, b) => a.distance - b.distance);
  const selected: typeof ranked = [];
  for (const c of ranked) {
    if (selected.every((s) => Math.abs(s.index - c.index) > 20))
      selected.push(c);
  }
  return {
    query,
    examples: selected.slice(0, 5),
    candidates: selected,
    candidateCount: candidates.length,
    sampleCount: selected.length,
    range: bars[0]?.sessionDate,
    featureVersion: "v1",
    methodVersion: "neighbors-v1",
  };
}
export const predictionSchema = z.object({
  schemaVersion: z.literal(1),
  recordId: z.string(),
  kind: z.literal("prediction"),
  createdAt: z.string(),
  source: z.string(),
  predictionId: z.string(),
  providerCode: z.string(),
  mode: z.enum(["demo", "research", "backtest", "live"]),
  generatedAt: z.string(),
  dataAsOf: z.string(),
  horizonSessions: z.union([z.literal(1), z.literal(5), z.literal(20)]),
  targetSessionDate: z.string(),
  referencePrice: z.number().positive(),
  referenceBasis: z.string(),
  predictedReturn: z.number(),
  expectedPrice: z.number(),
  returnQuantiles: z.tuple([z.number(), z.number()]),
  pUp: z.number().min(0).max(1),
  sampleCount: z.number().min(20),
  inputRevisionIds: z.array(z.string()),
  candidateIds: z.array(z.string()),
  featureVersion: z.string(),
  methodVersion: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  reason: z.string(),
  falsification: z.string(),
});
export type Prediction = z.infer<typeof predictionSchema>;
export function evaluate(p: Prediction, bars: Bar[]) {
  const base = bars.find((b) => b.sessionDate === p.dataAsOf),
    target = bars.find((b) => b.sessionDate === p.targetSessionDate);
  if (!base?.adjClose || !target?.adjClose) return null;
  if (base.seriesId !== target.seriesId) return null;
  const actualReturn = target.adjClose / base.adjClose - 1;
  return {
    actualReturn,
    actualPrice: p.referencePrice * (1 + actualReturn),
    priceError: p.expectedPrice - p.referencePrice * (1 + actualReturn),
    returnError: p.predictedReturn - actualReturn,
    directionMatch: direction(p.predictedReturn) === direction(actualReturn),
    inRange:
      actualReturn >= p.returnQuantiles[0] &&
      actualReturn <= p.returnQuantiles[1],
    brier: (p.pUp - Number(actualReturn > 0)) ** 2,
    baselineError: -actualReturn,
    baselineDirectionMatch: direction(actualReturn) === "flat",
    revisionIds: [base.revisionId, target.revisionId],
    basis: "同一取得系列の調整済み終値（配当を含まない）",
  };
}
