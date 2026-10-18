import type { Bar, Calendar } from "./index";
import { quantile } from "./index";
import { dejavu } from "./dejavu";
import { scoutSimilarSchema } from "./bottom-scout-schema";
export function scoutDejavu(
  bars: Bar[],
  asOf: string,
  cutoff: string,
  calendar: Calendar,
) {
  const r = dejavu(bars, bars, asOf, cutoff, calendar),
    examples = r.statisticalExamples;
  const returns = (e: (typeof examples)[number], h: number) =>
    e.futureShape[h - 1] / e.shape[19] - 1;
  const horizons = ([5, 10, 20] as const).map((sessions) => {
    const rows = examples.flatMap((e) => {
        const end = bars.findIndex(
            (b) => b.sessionDate === e.end && b.providerCode === e.providerCode,
          ),
          path = bars.slice(end + 1, end + sessions + 1),
          base = bars[end]?.adjClose;
        if (
          !base ||
          path.length !== sessions ||
          path.some((b) => !b.adjLow || !Number.isFinite(b.adjLow))
        )
          return [];
        const value = returns(e, sessions);
        return Number.isFinite(value)
          ? [
              {
                value,
                decline: Math.min(0, ...path.map((b) => b.adjLow! / base - 1)),
              },
            ]
          : [];
      }),
      values = rows.map((r) => r.value);
    return {
      sessions,
      count: rows.length,
      meanReturn: rows.length
        ? values.reduce((s, v) => s + v, 0) / rows.length
        : null,
      medianReturn: rows.length ? quantile(values, 0.5) : null,
      upRatio: rows.length
        ? values.filter((v) => v > 0).length / rows.length
        : null,
      worstDecline: rows.length
        ? Math.min(...rows.map((r) => r.decline))
        : null,
    };
  });
  return scoutSimilarSchema.parse({
    methodVersion: "scout-dejavu-5-10-20-v1",
    sampleCount: examples.length,
    bestSimilarity: examples[0]?.score ?? null,
    lowSample: examples.length < 20,
    horizons,
    examples: examples
      .slice(0, 5)
      .map((e) => ({
        id: e.id,
        start: e.start,
        end: e.end,
        similarity: e.score,
        returns: Object.fromEntries([5, 10, 20].map((h) => [h, returns(e, h)])),
        shape: e.shape,
        futureShape: e.futureShape,
      })),
    queryShape: r.query.shape,
    warnings: [
      ...(examples.length < 20
        ? [
            "類似事例が20件未満です。上昇した割合は、校正済みの上昇確率ではありません。",
          ]
        : []),
      "同じ銘柄内の過去事例です。比較窓・結果窓の重複と取得締切後の改訂を除外しています。",
    ],
  });
}
