import type { BottomFeatures } from "./bottom-features";

export const BOTTOM_CONFIG = {
  featureVersion: "bottom-80-v1",
  methodVersion: "bottom-rule-v1",
  historySessions: 80,
  drawdown: -0.15,
  oversoldRsi: 30,
  volumeRatio: 1.5,
  wickRatio: 0.4,
  highAtr: 0.08,
  farSupport: 0.1,
  minAverageTurnover: 100000000,
  weights: [10, 10, 15, 10, 5, 10, 10, 15, 5, 10],
} as const;
export function stageForScore(score: number) {
  return score < 40
    ? "反転根拠が少ない"
    : score < 60
      ? "底固めを観察"
      : score < 80
        ? "反発初期候補"
        : "反転条件が多い";
}
export function scoreBottom(f: BottomFeatures) {
  const c = BOTTOM_CONFIG;
  const rules = [
    ["drawdown", "60日高値から15%以上下落", f.drawdown60 <= c.drawdown],
    ["oversold", "直近5日のRSIが30以下", f.minRsi5 <= c.oversoldRsi],
    [
      "support",
      "安値更新が止まり、20日安値から2営業日経過",
      f.low >= f.priorLow5 && f.lowAge >= 2,
    ],
    ["above_sma5", "終値が5日平均を上回る", f.close > f.sma5],
    ["sma5_rising", "5日平均が上向く", f.sma5 > f.sma5Previous],
    ["rsi_recovery", "RSIが3営業日前から回復", f.rsi14 > f.rsiPrevious3],
    [
      "macd_recovery",
      "MACDヒストグラムが2回連続改善",
      f.histogram > f.histogramPrevious &&
        f.histogramPrevious > f.histogramPrevious2,
    ],
    [
      "volume_rebound",
      "上昇日に出来高が前20日平均の1.5倍以上",
      f.volumeRatio !== null &&
        f.volumeRatio >= c.volumeRatio &&
        f.close > f.previousClose,
    ],
    [
      "lower_wick",
      "下ヒゲ40%以上の陽線・同値線",
      f.lowerWickRatio >= c.wickRatio && f.close >= f.open,
    ],
    [
      "above_sma20",
      "終値が20日平均を上回り、平均も横ばい以上",
      f.close > f.sma20 && f.sma20 >= f.sma20Previous3,
    ],
  ] as const;
  const conditions = rules.map(([code, label, met], i) => ({
    code,
    label,
    met,
    maxPoints: c.weights[i],
    earnedPoints: met ? c.weights[i] : 0,
  }));
  const score = conditions.reduce((sum, r) => sum + r.earnedPoints, 0);
  return {
    score,
    stage: stageForScore(score),
    conditions,
    candidatePrerequisite: conditions[0].met && conditions[1].met,
  };
}
