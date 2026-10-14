import { describe, it, expect } from "vitest";
import {
  targetDate,
  similar,
  direction,
  evaluate,
  quantile,
  type Prediction,
} from "../packages/core/index";
import { canonical, commitment } from "../packages/core/commitment";
import { demoBars } from "../fixtures/demo";
describe("営業日と数値分析", () => {
  it("祝日、年末年始をカレンダーで除外し営業日数を進める", () => {
    const cal = [
      { date: "2026-12-30", open: true },
      { date: "2026-12-31", open: false },
      { date: "2027-01-01", open: false },
      { date: "2027-01-04", open: true },
      { date: "2027-01-05", open: true },
    ];
    expect(targetDate(cal, "2026-12-30", 1)).toBe("2027-01-04");
    expect(() => targetDate(cal, "2026-12-30", 5)).toThrow();
  });
  it("類似例の重複・未来を除外し、未来追記で結果が変わらない", () => {
    const bars = demoBars("72030"),
      date = bars[1400].sessionDate,
      a = similar(bars.slice(0, 1401), date),
      b = similar(bars, date);
    expect(a).toEqual(b);
    expect(a.sampleCount).toBeGreaterThanOrEqual(20);
    for (const c of a.candidates) {
      expect(c.index + 20).toBeLessThan(1400);
      expect(
        a.candidates.filter((d) => Math.abs(c.index - d.index) <= 20),
      ).toHaveLength(1);
    }
    expect(a.examples[0].distance).toBeLessThanOrEqual(a.examples[1].distance);
  });
  it("方向閾値とBrierイベントを区別し、分割後同一系列で評価する", () => {
    const p = {
      dataAsOf: "2026-01-01",
      targetSessionDate: "2026-01-02",
      referencePrice: 100,
      predictedReturn: 0.002,
      expectedPrice: 100.2,
      pUp: 0.75,
      returnQuantiles: [-0.1, 0.1],
    } as Prediction;
    const bars = demoBars("72030")
      .slice(0, 2)
      .map((b, i) => ({
        ...b,
        sessionDate: i ? "2026-01-02" : "2026-01-01",
        close: i ? 51 : 100,
        adjClose: i ? 51 : 50,
      }));
    const result = evaluate(p, bars)!;
    expect(result.actualReturn).toBeCloseTo(0.02);
    expect(result.brier).toBeCloseTo(0.0625);
    expect(result.priceError).toBeCloseTo(-1.8);
    expect(result.directionMatch).toBe(false);
    expect(direction(0.005)).toBe("flat");
    expect(direction(-0.005)).toBe("flat");
    expect(quantile([0, 10], 0.1)).toBe(1);
    expect(evaluate(p, [bars[0]])).toBeNull();
  });
  it("JSON canonicalizationとsaltの改変を検出", () => {
    const a = { z: 1, a: { c: 2, b: 3 } };
    expect(canonical(a)).toBe('{"a":{"b":3,"c":2},"z":1}');
    expect(commitment(a, new Uint8Array(32))).toBe(
      commitment({ a: { b: 3, c: 2 }, z: 1 }, new Uint8Array(32)),
    );
    expect(commitment(a, new Uint8Array(32))).not.toBe(
      commitment(a, new Uint8Array(32).fill(1)),
    );
  });
});
