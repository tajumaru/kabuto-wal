import type { Bar } from "./index";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export function sma(xs: number[], n: number) {
  return xs.map((_, i) =>
    i < n - 1 ? null : mean(xs.slice(i - n + 1, i + 1)),
  );
}
export function ema(xs: number[], n: number): (number | null)[] {
  let value = 0;
  return xs.map((x, i) => {
    if (i < n - 1) return null;
    value =
      i === n - 1 ? mean(xs.slice(0, n)) : value + (2 / (n + 1)) * (x - value);
    return value;
  });
}
export function rsi(xs: number[], n = 14): (number | null)[] {
  let gain = 0,
    loss = 0;
  return xs.map((x, i) => {
    if (!i) return null;
    const delta = x - xs[i - 1];
    if (i <= n) {
      gain += Math.max(delta, 0) / n;
      loss += Math.max(-delta, 0) / n;
    } else {
      gain = (gain * (n - 1) + Math.max(delta, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-delta, 0)) / n;
    }
    return i < n
      ? null
      : gain === 0 && loss === 0
        ? 50
        : loss === 0
          ? 100
          : 100 - 100 / (1 + gain / loss);
  });
}
// Call only with a validated, continuous 80-session window of one adjustment series.
export function bottomFeatures(bars: Bar[]) {
  if (bars.length !== 80) throw Error("80営業日の日足が必要です");
  const c = bars.map((b) => b.adjClose!);
  const s5 = sma(c, 5),
    s20 = sma(c, 20),
    s60 = sma(c, 60),
    rs = rsi(c);
  const e12 = ema(c, 12),
    e26 = ema(c, 26);
  const macd = c.slice(25).map((_, i) => e12[i + 25]! - e26[i + 25]!);
  const signal = ema(macd, 9);
  const hist = macd.map((x, i) => (signal[i] === null ? null : x - signal[i]!));
  const tr = bars
    .slice(1)
    .map((b, i) =>
      Math.max(
        b.adjHigh! - b.adjLow!,
        Math.abs(b.adjHigh! - c[i]),
        Math.abs(b.adjLow! - c[i]),
      ),
    );
  let atr = mean(tr.slice(0, 14));
  for (const x of tr.slice(14)) atr = (atr * 13 + x) / 14;
  const last = bars[79],
    low20 = Math.min(...bars.slice(-20).map((b) => b.adjLow!));
  const priorVolume = mean(bars.slice(-21, -1).map((b) => b.volume!));
  return {
    close: c[79],
    sma5: s5[79]!,
    sma5Previous: s5[78]!,
    sma20: s20[79]!,
    sma20Previous3: s20[76]!,
    sma60: s60[79]!,
    sma60Previous: s60[78]!,
    rsi14: rs[79]!,
    rsiPrevious3: rs[76]!,
    minRsi5: Math.min(...(rs.slice(-5) as number[])),
    macd: macd.at(-1)!,
    signal: signal.at(-1)!,
    histogram: hist.at(-1)!,
    histogramPrevious: hist.at(-2)!,
    histogramPrevious2: hist.at(-3)!,
    atr14: atr,
    atrRatio: atr / c[79],
    drawdown60: c[79] / Math.max(...c.slice(-60)) - 1,
    return5: c[79] / c[74] - 1,
    return20: c[79] / c[59] - 1,
    volumeRatio: priorVolume > 0 ? last.volume! / priorVolume : null,
    lowerWickRatio:
      last.adjHigh === last.adjLow
        ? 0
        : (Math.min(last.adjOpen!, last.adjClose!) - last.adjLow!) /
          (last.adjHigh! - last.adjLow!),
    low20,
    lowAge: bars
      .slice(-20)
      .reverse()
      .findIndex((b) => b.adjLow === low20),
    supportDistance: c[79] / low20 - 1,
    low: last.adjLow!,
    priorLow5: Math.min(...bars.slice(-6, -1).map((b) => b.adjLow!)),
    open: last.adjOpen!,
    previousClose: c[78],
    volume: last.volume!,
  };
}
export type BottomFeatures = ReturnType<typeof bottomFeatures>;
