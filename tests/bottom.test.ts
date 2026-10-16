import { it, expect } from "vitest";
import {
  sma,
  ema,
  rsi,
  bottomFeatures,
} from "../packages/core/bottom-features";
import { scoreBottom, stageForScore } from "../packages/core/bottom-score";
import { demoBars } from "../fixtures/demo";

it("平均・EMAの初期化とWilder RSIを手計算値で確認する", () => {
  expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  expect(ema([1, 2, 3, 4, 8], 3)).toEqual([null, null, 2, 3, 5.5]);
  expect(rsi(Array(80).fill(100)).at(-1)).toBe(50);
  expect(rsi(Array.from({ length: 80 }, (_, i) => i + 1)).at(-1)).toBe(100);
  expect(rsi(Array.from({ length: 80 }, (_, i) => 80 - i)).at(-1)).toBe(0);
  expect(rsi([1, 3, 2, 4], 2)).toEqual([
    null,
    null,
    100 - 100 / 3,
    100 - 100 / 7,
  ]);
});
it("ATR・固定窓・出来高倍率・同値足を確認する", () => {
  const bars = demoBars("72030")
    .slice(-80)
    .map((b) => ({
      ...b,
      adjClose: 100,
      adjOpen: 100,
      adjHigh: 102,
      adjLow: 98,
      volume: 10,
    }));
  bars[79].volume = 20;
  const f = bottomFeatures(bars);
  expect(f.atr14).toBe(4);
  expect(f.volumeRatio).toBe(2);
  expect(f.macd).toBe(0);
  expect(f.histogram).toBe(0);
  expect(f.lowAge).toBe(0);
  expect(f.lowerWickRatio).toBe(0.5);
  expect(() => bottomFeatures(bars.slice(1))).toThrow();
  expect(
    bottomFeatures(
      bars.map((b) => ({ ...b, adjHigh: 100, adjLow: 100, volume: 0 })),
    ).volumeRatio,
  ).toBeNull();
  expect(
    bottomFeatures(bars.map((b) => ({ ...b, adjHigh: 100, adjLow: 100 })))
      .lowerWickRatio,
  ).toBe(0);
});
it("全条件の配点と厳密な比較、段階境界を固定する", () => {
  const f = {
    ...bottomFeatures(demoBars("72030").slice(-80)),
    drawdown60: -0.15,
    minRsi5: 30,
    low: 90,
    priorLow5: 90,
    lowAge: 2,
    close: 100,
    open: 100,
    sma5: 99,
    sma5Previous: 98,
    rsi14: 40,
    rsiPrevious3: 39,
    histogram: 3,
    histogramPrevious: 2,
    histogramPrevious2: 1,
    volumeRatio: 1.5,
    previousClose: 99,
    lowerWickRatio: 0.4,
    sma20: 95,
    sma20Previous3: 95,
  };
  expect(scoreBottom(f).score).toBe(100);
  expect(scoreBottom(f).candidatePrerequisite).toBe(true);
  expect(
    scoreBottom({ ...f, close: 99 }).conditions.find(
      (c) => c.code === "above_sma5",
    )?.earnedPoints,
  ).toBe(0);
  expect(scoreBottom({ ...f, drawdown60: -0.149 }).candidatePrerequisite).toBe(
    false,
  );
  expect([39, 40, 59, 60, 79, 80].map(stageForScore)).toEqual([
    "反転根拠が少ない",
    "底固めを観察",
    "底固めを観察",
    "反発初期候補",
    "反発初期候補",
    "反転条件が多い",
  ]);
});
