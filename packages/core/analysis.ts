import {
  similar,
  quantile,
  evaluate,
  type Bar,
  type Prediction,
} from "./index";
export function aggregate(predictions: any[]) {
  const groups = new Map<string, any>();
  for (const p of predictions) {
    const key = [p.horizonSessions, p.mode, p.methodVersion].join("/");
    const g = groups.get(key) || {
      key,
      horizon: p.horizonSessions,
      mode: p.mode,
      methodVersion: p.methodVersion,
      total: 0,
      evaluated: 0,
      pending: 0,
      missing: 0,
      absoluteReturnError: 0,
      baselineAbsoluteError: 0,
      brier: 0,
      directionMatch: 0,
      inRange: 0,
    };
    g.total++;
    const e = p.evaluations.at(-1);
    if (e) {
      g.evaluated++;
      g.absoluteReturnError += Math.abs(e.returnError);
      g.baselineAbsoluteError += Math.abs(e.baselineError);
      g.brier += e.brier;
      g.directionMatch += Number(e.directionMatch);
      g.inRange += Number(e.inRange);
    } else if (p.state.status === "missing") g.missing++;
    else g.pending++;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    mae: g.evaluated ? g.absoluteReturnError / g.evaluated : null,
    baselineMae: g.evaluated ? g.baselineAbsoluteError / g.evaluated : null,
    meanBrier: g.evaluated ? g.brier / g.evaluated : null,
    directionRate: g.evaluated ? g.directionMatch / g.evaluated : null,
    inRangeRate: g.evaluated ? g.inRange / g.evaluated : null,
  }));
}
// Retrospective numeric research only. No LLM; no claim about historical publication time.
export function walkForward(
  bars: Bar[],
  horizon: 1 | 5 | 20,
  start: number,
  step = 20,
) {
  const rows = [];
  let excluded = 0;
  for (
    let end = Math.max(500, start);
    end + horizon < bars.length;
    end += step
  ) {
    try {
      const result = similar(
        bars.slice(0, end + 1),
        bars[end].sessionDate,
        horizon,
      );
      if (result.sampleCount < 20) {
        excluded++;
        continue;
      }
      const returns = result.candidates
        .map((c) => c.future[horizon])
        .filter((v): v is number => v !== null);
      const median = quantile(returns, 0.5);
      const p = {
        dataAsOf: bars[end].sessionDate,
        targetSessionDate: bars[end + horizon].sessionDate,
        referencePrice: bars[end].adjClose!,
        expectedPrice: bars[end].adjClose! * (1 + median),
        predictedReturn: median,
        returnQuantiles: [quantile(returns, 0.1), quantile(returns, 0.9)],
        pUp: returns.filter((r) => r > 0).length / returns.length,
      } as Prediction;
      rows.push({
        dataAsOf: p.dataAsOf,
        sampleCount: returns.length,
        ...evaluate(p, bars),
      });
    } catch {
      excluded++;
    }
  }
  return {
    mode: "backtest",
    methodVersion: "neighbors-v1",
    horizon,
    rows,
    excluded,
    note: "現在の調整系列を使う回顧的数値研究。過去公表時点の保証・当時LLM予測ではありません。",
  };
}
