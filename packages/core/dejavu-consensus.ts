import { quantile } from "./index";
import { WEIGHTS } from "./dejavu";

export const CONSENSUS_METHOD = "dejavu-consensus-v1";
export const CONSENSUS_WEIGHT_POWER = 2;
export const HORIZONS = [1, 5, 20] as const;
export type DejaVuExample = {
  id: string;
  score: number;
  start: string;
  end: string;
  providerCode: string;
  outcomeEnd: string;
  future: Record<number, number | null>;
  shape: number[];
  futureShape: number[];
  components: Record<keyof typeof WEIGHTS, number>;
};
export function consensus(examples: DejaVuExample[]) {
  // Recheck the complete matching + outcome interval, including duplicate IDs.
  const selected: DejaVuExample[] = [];
  for (const e of [...examples].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  )) {
    if (
      !Number.isFinite(e.score) ||
      selected.some(
        (s) =>
          s.id === e.id ||
          (s.providerCode === e.providerCode &&
            e.start <= s.outcomeEnd &&
            s.start <= e.outcomeEnd),
      )
    )
      continue;
    selected.push(e);
  }
  const stats = (rows: { value: number; score: number }[]) => {
    const values = rows.map((r) => r.value);
    const n = values.length;
    const weights = rows.map(
      (r) => Math.max(r.score / 100, 0) ** CONSENSUS_WEIGHT_POWER,
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    const up = values.filter((v) => v > 0).length,
      down = values.filter((v) => v < 0).length;
    return {
      sampleCount: n,
      up,
      down,
      flat: n - up - down,
      upRatio: n ? up / n : null,
      medianReturn: n ? quantile(values, 0.5) : null,
      meanReturn: n ? values.reduce((a, b) => a + b, 0) / n : null,
      minReturn: n ? Math.min(...values) : null,
      maxReturn: n ? Math.max(...values) : null,
      percentileRange: n
        ? [quantile(values, 0.25), quantile(values, 0.75)]
        : null,
      weightedReturn: sum
        ? rows.reduce((s, r, i) => s + weights[i] * r.value, 0) / sum
        : null,
      consensusScore: sum
        ? rows.reduce((s, r, i) => s + weights[i] * Math.sign(r.value), 0) / sum
        : null,
      reliability:
        n === 0
          ? "集計不能"
          : n < 3
            ? "参考不足"
            : n < 5
              ? "少数事例"
              : "参考統計",
    };
  };
  return {
    methodVersion: CONSENSUS_METHOD,
    weightPower: CONSENSUS_WEIGHT_POWER,
    selection:
      "表示用上位5件。類似度降順、同銘柄の比較窓と結果窓が重なる事例を除外。",
    exampleIds: selected.map((e) => e.id),
    horizons: Object.fromEntries(
      HORIZONS.map((h) => [
        h,
        stats(
          selected.flatMap((e) => {
            const value = e.future[h];
            return typeof value === "number" && Number.isFinite(value)
              ? [{ value, score: e.score }]
              : [];
          }),
        ),
      ]),
    ),
    trajectory: Array.from({ length: 21 }, (_, day) => {
      const values = selected.flatMap((e) => {
        const base = e.shape[19],
          value = day === 0 ? base : e.futureShape[day - 1];
        return Number.isFinite(base) && base > 0 && Number.isFinite(value)
          ? [value / base - 1]
          : [];
      });
      return {
        day,
        sampleCount: values.length,
        median: values.length ? quantile(values, 0.5) : null,
        lower: values.length ? quantile(values, 0.25) : null,
        upper: values.length ? quantile(values, 0.75) : null,
      };
    }),
  };
}
const labels = {
  shape: "価格形状",
  returns: "騰落率",
  candles: "ローソク足",
  volume: "出来高",
  volatility: "変動率",
};
export function dna(example: DejaVuExample) {
  const elements = Object.entries(WEIGHTS).map(([name, weight]) => {
    const key = name as keyof typeof WEIGHTS,
      distance = example.components[key];
    const valid = Number.isFinite(distance) && distance >= 0;
    return {
      key,
      label: labels[key],
      distance: valid ? distance : null,
      similarity: valid ? 100 * Math.exp(-distance) : null,
      weight,
      contribution: valid ? weight * distance : null,
    };
  });
  const ranked = elements
    .filter((e) => e.similarity !== null)
    .sort((a, b) => b.similarity! - a.similarity!);
  return {
    exampleId: example.id,
    score: example.score,
    elements,
    mostSimilar: ranked[0]?.label,
    mostDifferent: ranked.at(-1)?.label,
    explanation: ranked.length
      ? `${ranked[0].label}が最も似ているね（要素類似度${ranked[0].similarity!.toFixed(1)}点）。${ranked.at(-1)!.label}は相対的に違いが大きいよ（${ranked.at(-1)!.similarity!.toFixed(1)}点）。距離だけでは当時より高いか低いかは分からないよ。`
      : "特徴量が不足しています。",
  };
}
