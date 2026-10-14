import type { Bar, Calendar } from "./index";

export const DEJAVU_VERSION = "ohlcv-20-v1";
export const WEIGHTS = {
  shape: 0.35,
  returns: 0.25,
  candles: 0.2,
  volume: 0.15,
  volatility: 0.05,
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rms = (a: number[], b: number[], scale: number) =>
  Math.sqrt(mean(a.map((v, i) => ((v - b[i]) / scale) ** 2)));
export function ohlcvFeatures(bars: Bar[]) {
  if (bars.length !== 20) throw Error("20営業日のOHLCVが必要です");
  const code = bars[0].providerCode,
    series = bars[0].seriesId;
  for (const [i, b] of bars.entries()) {
    const values = [b.adjOpen, b.adjHigh, b.adjLow, b.adjClose, b.volume];
    if (
      values.some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
      [b.adjOpen, b.adjHigh, b.adjLow, b.adjClose].some((v) => v! <= 0) ||
      b.volume! < 0 ||
      b.adjHigh! < Math.max(b.adjOpen!, b.adjClose!) ||
      b.adjLow! > Math.min(b.adjOpen!, b.adjClose!) ||
      b.providerCode !== code ||
      b.seriesId !== series ||
      (i > 0 && bars[i - 1].sessionDate >= b.sessionDate)
    )
      throw Error("欠損・不正・異なる調整系列のOHLCV窓");
  }
  const prices = bars.map((b) => b.adjClose!);
  const returns = prices.slice(1).map((p, i) => p / prices[i] - 1);
  const volumeMean = mean(bars.map((b) => b.volume!));
  return {
    shape: prices.map((p) => (p / prices[0]) * 100),
    returns,
    candles: bars.flatMap((b) => [
      (b.adjClose! - b.adjOpen!) / b.adjOpen!,
      (b.adjHigh! - Math.max(b.adjOpen!, b.adjClose!)) / b.adjOpen!,
      (Math.min(b.adjOpen!, b.adjClose!) - b.adjLow!) / b.adjOpen!,
    ]),
    volume: bars.map((b) => (volumeMean ? b.volume! / volumeMean : 0)),
    volatility: [Math.sqrt(mean(returns.map((r) => (r - mean(returns)) ** 2)))],
  };
}
export function weightedScore(
  a: ReturnType<typeof ohlcvFeatures>,
  b: ReturnType<typeof ohlcvFeatures>,
) {
  const distances = {
    shape: rms(a.shape, b.shape, 5),
    returns: rms(a.returns, b.returns, 0.02),
    candles: rms(a.candles, b.candles, 0.02),
    volume: rms(a.volume, b.volume, 1),
    volatility: rms(a.volatility, b.volatility, 0.02),
  };
  const distance = Object.entries(WEIGHTS).reduce(
    (s, [k, w]) => s + w * distances[k as keyof typeof WEIGHTS],
    0,
  );
  return { distance, score: 100 * Math.exp(-distance), components: distances };
}
export function dejavu(
  bars: Bar[],
  queryBars: Bar[],
  asOf: string,
  cutoff: string,
  calendar: Calendar,
) {
  if (!Number.isFinite(Date.parse(cutoff))) throw Error("取得時点が不正です");
  const sessions = calendar
    .filter((d) => d.open)
    .map((d) => d.date)
    .sort();
  const cutoffMs = Date.parse(cutoff);
  const known = (b: Bar) =>
    Number.isFinite(Date.parse(b.availableAt)) &&
    Date.parse(b.availableAt) <= cutoffMs;
  const contiguous = (w: Bar[]) => {
    const start = sessions.indexOf(w[0].sessionDate);
    return (
      start >= 0 && w.every((b, i) => b.sessionDate === sessions[start + i])
    );
  };
  const end = queryBars.findIndex((b) => b.sessionDate === asOf);
  const window = queryBars.slice(end - 19, end + 1);
  if (end < 19 || !window.every(known) || !contiguous(window))
    throw Error("基準日時点の連続20営業日日足が不足");
  const query = ohlcvFeatures(window);
  const candidates = [];
  for (let i = 19; i + 20 < bars.length; i++) {
    const block = bars.slice(i - 19, i + 21);
    // Both the matching window and its full outcome must precede the query window.
    if (
      block.at(-1)!.sessionDate >= window[0].sessionDate ||
      !block.every(known) ||
      !contiguous(block) ||
      block.some(
        (b) =>
          b.seriesId !== block[0].seriesId ||
          b.providerCode !== block[0].providerCode,
      )
    )
      continue;
    try {
      const f = ohlcvFeatures(block.slice(0, 20));
      const outcomes = block.slice(20);
      if (outcomes.some((b) => !b.adjClose || !Number.isFinite(b.adjClose)))
        continue;
      candidates.push({
        index: i,
        id: `${bars[i].providerCode}:${bars[i].sessionDate}:${bars[i].revisionId}`,
        start: bars[i - 19].sessionDate,
        end: bars[i].sessionDate,
        providerCode: bars[i].providerCode,
        ...weightedScore(query, f),
        shape: f.shape,
        futureShape: outcomes.map(
          (b) => (b.adjClose! / bars[i].adjClose!) * f.shape[19],
        ),
        future: Object.fromEntries(
          [1, 5, 20].map((h) => [
            h,
            bars[i + h].adjClose! / bars[i].adjClose! - 1,
          ]),
        ),
        revisionIds: block.map((b) => b.revisionId),
        outcomeEnd: block.at(-1)!.sessionDate,
      });
    } catch {
      /* Invalid OHLCV windows are never imputed. */
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.end.localeCompare(b.end));
  const selected: typeof candidates = [];
  for (const c of candidates)
    if (selected.every((s) => Math.abs(s.index - c.index) >= 40))
      selected.push(c);
  return {
    query,
    examples: selected.slice(0, 5),
    candidateCount: candidates.length,
    sampleCount: selected.length,
    range: bars[0]?.sessionDate,
    asOf,
    cutoff,
    queryStart: window[0].sessionDate,
    inputRevisionIds: window.map((b) => b.revisionId),
    weights: WEIGHTS,
    featureVersion: DEJAVU_VERSION,
    methodVersion: "weighted-ohlcv-v1",
    scoreMeaning: "形状の類似度。上昇確率ではありません。",
    dataPolicy:
      "取得時点で既知の改訂のみ。候補とその後20営業日は比較元窓より前。",
  };
}
