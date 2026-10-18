import type { ScoutIndicators } from "./bottom-scout-indicators";
export const SCOUT_METHOD = "bottom-scout-v1";
// Research-only scoring. Never changes bottom-rule-v1 / hunter prediction originals.
export function scoreScout(
  f: ScoutIndicators,
  similarity: { score: number; sampleCount: number } | null = null,
) {
  const rules = [
    [
      "rsi",
      "RSIが直近から回復",
      15,
      f.rsi14 > f.rsiPrevious3 && f.minRsi5 < 50,
    ],
    [
      "macd",
      "MACDの下落圧力が2回連続で弱まる",
      15,
      f.histogram > f.histogramPrevious &&
        f.histogramPrevious > f.histogramPrevious2,
    ],
    [
      "ma5",
      "株価が上向きの5日平均を上回る",
      10,
      f.close > f.sma5 && f.sma5 > f.sma5Previous,
    ],
    [
      "ma25",
      "25日平均が横ばい以上で株価が上回る",
      10,
      f.close > f.sma25 && f.sma25 >= f.sma25Previous3,
    ],
    [
      "ma75",
      "75日平均の下落が止まる、または株価が上回る",
      10,
      f.sma75 >= f.sma75Previous3 || f.close > f.sma75,
    ],
    ["bollinger", "ボリンジャー下限付近から内側へ戻る", 10, f.bandReentry],
    [
      "volume",
      "上昇日に出来高が前20日平均の1.5倍以上",
      15,
      f.close > f.previousClose &&
        f.volumeRatio !== null &&
        f.volumeRatio >= 1.5,
    ],
    [
      "support",
      "直近安値の更新が止まる",
      10,
      f.low >= f.priorLow5 && f.lowAge >= 1,
    ],
    [
      "dejavu",
      "非重複の類似事例が3件以上で最良類似度65点以上",
      5,
      similarity !== null &&
        similarity.sampleCount >= 3 &&
        similarity.score >= 65,
    ],
  ] as const;
  const contributions = rules.map(([code, label, maxPoints, met]) => ({
      code,
      label,
      maxPoints,
      met,
      earnedPoints: met ? maxPoints : 0,
    })),
    score = contributions.reduce((s, c) => s + c.earnedPoints, 0),
    met = new Set(contributions.filter((c) => c.met).map((c) => c.code));
  const candidate =
    score >= 60 &&
    f.drawdown75 <= -0.05 &&
    f.volume > 0 &&
    met.has("support") &&
    met.has("ma5") &&
    ["rsi", "macd", "volume"].filter((c) => met.has(c as "rsi")).length >= 2;
  return {
    methodVersion: SCOUT_METHOD,
    score,
    candidate,
    contributions,
    calibratedProbability: null,
    risks: [
      ...(f.close < f.sma75 && f.sma75 < f.sma75Previous3
        ? ["長期の下落傾向が続いています"]
        : []),
      ...(f.low < f.priorLow5 ? ["直近安値を更新しています"] : []),
      ...(f.volume === 0 ? ["当日の出来高がゼロです"] : []),
      ...(f.volumeRatio === null ? ["比較用の出来高が不足しています"] : []),
      ...(similarity === null || similarity.sampleCount < 20
        ? ["類似事例が20件未満のため経験統計は不安定です"]
        : []),
    ],
  };
}
