import { expect, it } from "vitest";
import {
  consensus,
  consensusComparison,
  dna,
  type DejaVuExample,
} from "../packages/core/dejavu-consensus";

function example(id: number, value: number | null, score = 100): DejaVuExample {
  return {
    id: String(id),
    score,
    providerCode: String(id),
    start: "2020-01-01",
    end: "2020-01-28",
    outcomeEnd: "2020-02-25",
    future: { 1: value, 5: value, 20: value },
    shape: Array(20).fill(100),
    futureShape: Array(20).fill(110),
    components: { shape: 0, returns: 1, candles: 2, volume: 3, volatility: 4 },
  };
}
it("手計算に一致する中央値・分位・ゼロ件数・加重平均・方向Score", () => {
  const rows = [example(1, 0.1), example(2, -0.1, 50), example(3, 0, 100)];
  const a = consensus(rows),
    s = a.horizons[5];
  expect(s).toMatchObject({
    sampleCount: 3,
    up: 1,
    down: 1,
    flat: 1,
    medianReturn: 0,
    meanReturn: 0,
    minReturn: -0.1,
    maxReturn: 0.1,
    percentileRange: [-0.05, 0.05],
    reliability: "少数事例",
  });
  expect(s.upRatio).toBeCloseTo(1 / 3);
  expect(s.weightedReturn).toBeCloseTo((0.1 - 0.025) / 2.25);
  expect(s.consensusScore).toBeCloseTo(0.75 / 2.25);
  expect(consensus(rows)).toEqual(a);
  expect(consensus([example(1, -0.1)]).horizons[1].consensusScore).toBe(-1);
  expect(a.trajectory[20]).toMatchObject({ sampleCount: 3 });
  expect(a.trajectory[20].median).toBeCloseTo(0.1);
});
it("空・欠損・非有限値・重み0を扱い、重複した40営業日窓を除外", () => {
  expect(consensus([]).horizons[1]).toMatchObject({
    sampleCount: 0,
    consensusScore: null,
    medianReturn: null,
    reliability: "集計不能",
  });
  const a = example(1, 0.1),
    b = { ...example(2, -0.1), providerCode: a.providerCode };
  expect(consensus([a, b, a]).exampleIds).toHaveLength(1);
  expect(
    consensus([example(1, NaN), example(2, null), example(3, Infinity)])
      .horizons[5].sampleCount,
  ).toBe(0);
  expect(consensus([example(1, 0.1, 0)]).horizons[5]).toMatchObject({
    sampleCount: 1,
    weightedReturn: null,
    consensusScore: null,
  });
  expect(
    consensus([example(1, 0.1, -1)]).horizons[5].consensusScore,
  ).toBeNull();
});
it("DNAは距離から変換し総合スコアと区別する", () => {
  const d = dna(example(1, 0.1, 80));
  expect(d.score).toBe(80);
  expect(d.elements[0].similarity).toBe(100);
  expect(d.elements[1].similarity).toBeCloseTo(100 * Math.exp(-1));
  expect(d.elements[1].contribution).toBe(0.25);
  expect(d.mostSimilar).toBe("価格形状");
  expect(d.mostDifferent).toBe("変動率");
});

it("上位5・10・20を独立比較し、v1・不足件数・欠損・同点の順序を維持", () => {
  for (const count of [0, 1, 5, 25]) {
    for (const value of [-0.1, 0.1]) {
      const rows = Array.from({ length: count }, (_, i) => example(i, value));
      const before = consensus(rows.slice(0, 5));
      const comparison = consensusComparison(rows);
      expect(comparison.comparisons.map(c => c.horizons[5].sampleCount)).toEqual([5, 10, 20].map(n => Math.min(n, count)));
      expect(consensus(rows.slice(0, 5))).toEqual(before);
      for (const c of comparison.comparisons) expect(c.horizons[5].upRatio).toBe(count ? Number(value > 0) : null);
      expect(consensusComparison([...rows].reverse())).toEqual(comparison);
    }
  }
  const rows = Array.from({ length: 25 }, (_, i) => example(i, i % 2 ? -0.1 : 0.1));
  rows[0].future[5] = null;
  const c = consensusComparison(rows).comparisons[2];
  expect(c.horizons[5].sampleCount).toBe(19);
  expect(c.horizons[5].upRatio).toBeGreaterThan(0);
  expect(c.horizons[5].upRatio).toBeLessThan(1);
  const overlap = { ...rows[1], providerCode: rows[0].providerCode };
  expect(consensusComparison([rows[0], overlap, rows[0]]).comparisons[2].exampleIds).toHaveLength(1);
});
