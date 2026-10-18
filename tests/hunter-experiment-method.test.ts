import { it, expect } from "vitest";
import {
  labMethodSchema,
  labMethodInputSchema,
  labFeatures,
} from "../packages/core/hunter-experiment-schema";
import {
  labDefaultWeights,
  rescoreLabMember,
} from "../packages/core/hunter-experiment-method";
import { cohortMemberSchema } from "../packages/core/hunter-cohort-schema";
import { scoreBottom, BOTTOM_CONFIG } from "../packages/core/bottom-score";
import type { BottomFeatures } from "../packages/core/bottom-features";
it("現行十条件のコード・重み・100点を固定する", () => {
  const f = {
    drawdown60: -0.2,
    minRsi5: 20,
    low: 10,
    priorLow5: 9,
    lowAge: 2,
    close: 20,
    sma5: 15,
    sma5Previous: 14,
    rsi14: 40,
    rsiPrevious3: 30,
    histogram: 3,
    histogramPrevious: 2,
    histogramPrevious2: 1,
    volumeRatio: 2,
    previousClose: 19,
    lowerWickRatio: 0.5,
    open: 19,
    sma20: 18,
    sma20Previous3: 17,
  } as BottomFeatures;
  const a = scoreBottom(f);
  expect(a.score).toBe(100);
  expect(a.candidatePrerequisite).toBe(true);
  expect(a.conditions.map((c) => c.code)).toEqual(labFeatures);
  expect(a.conditions.map((c) => c.maxPoints)).toEqual([
    10, 10, 15, 10, 5, 10, 10, 15, 5, 10,
  ]);
  expect(BOTTOM_CONFIG.methodVersion).toBe("bottom-rule-v1");
  expect(BOTTOM_CONFIG).toEqual({featureVersion:"bottom-80-v1",methodVersion:"bottom-rule-v1",historySessions:80,drawdown:-0.15,oversoldRsi:30,volumeRatio:1.5,wickRatio:0.4,highAtr:0.08,farSupport:0.1,minAverageTurnover:100000000,weights:[10,10,15,10,5,10,10,15,5,10]});
  const changes:Partial<BottomFeatures>[]=[{drawdown60:-0.149},{minRsi5:31},{lowAge:1},{sma5:20},{sma5Previous:15},{rsiPrevious3:40},{histogramPrevious:3},{volumeRatio:1.49},{lowerWickRatio:0.39},{sma20:20}];
  changes.forEach((change,i)=>{const result=scoreBottom({...f,...change});expect(result.conditions[i].met).toBe(false);expect(result.score).toBe(100-BOTTOM_CONFIG.weights[i]);});
});
it("1024通りの固定条件で現行点数を再現し、実験は原本を書き換えない", () => {
  const m = labMethodSchema.parse({
    schemaVersion: 1,
    experimentId: "a".repeat(64),
    createdAt: new Date().toISOString(),
    parentMethodVersion: "bottom-rule-v1",
    featureVersion: "bottom-80-v1",
    methodVersion: "hunter-experiment-v1",
    name: "test",
    hypothesis: "test",
    parameters: labDefaultWeights,
    candidateThreshold: 0,
  });
  for (let mask = 0; mask < 1024; mask++) {
    const conditions = labFeatures.filter((_, i) => mask & (1 << i)),
      score = labFeatures.reduce(
        (n, k) => n + (conditions.includes(k) ? labDefaultWeights[k] : 0),
        0,
      ),
      member = cohortMemberSchema.parse({
        code: "72030",
        score,
        candidate: true,
        classification: "反転兆候あり",
        referencePrice: 100,
        inputRevisionIds: ["r"],
        eligible: true,
        exclusionReasons: [],
        conditions,
        risks: [],
        indicators: {},
        adjustmentVersion: "v",
        scoringMethodVersion: "bottom-rule-v1",
        featureVersion: "bottom-80-v1",
      });
    expect(rescoreLabMember(member, m).score).toBe(score);
    expect(member.score).toBe(score);
  }
});
it("範囲外、任意コード、NaN、Infinityを拒否する", () => {
  const q = {
    name: "a",
    hypothesis: "b",
    parameters: labDefaultWeights,
    candidateThreshold: 50,
  };
  for (const value of [-1, 101, NaN, Infinity])
    expect(
      labMethodInputSchema.safeParse({ ...q, candidateThreshold: value })
        .success,
    ).toBe(false);
  expect(
    labMethodInputSchema.safeParse({
      ...q,
      parameters: { ...labDefaultWeights, execute: "javascript" },
    }).success,
  ).toBe(false);
});
