import { randomUUID } from "node:crypto";
import type { Service } from "../apps/api/src/service";
import { cohortIdentity, cohortBase } from "../apps/api/src/hunter-cohort";
import { cohortEvaluationId } from "../apps/api/src/hunter-cohort-evaluation";
import {
  cohortManifestSchema,
  cohortMemberSchema,
  cohortEvaluationSchema,
} from "../packages/core/hunter-cohort-schema";
import { labFeatures } from "../packages/core/hunter-experiment-schema";
import { labDefaultWeights } from "../packages/core/hunter-experiment-method";
import { BOTTOM_CONFIG } from "../packages/core/bottom-score";
import { hash } from "../packages/integrations/adjusted-series";
// Artificial daily calendar and returns, never a claim about Japanese market performance.
export async function labFixture(s: Service, count = 12, foldDates = 1) {
  const firstYear = foldDates === 1 ? 2024 : 2020,
    dates = Array.from({ length: foldDates === 1 ? 366 : 1096 }, (_, i) =>
      new Date(Date.UTC(firstYear, 0, i + 1)).toISOString().slice(0, 10),
    );
  await s.store.write(
    "market/calendar.json",
    dates.map((date) => ({ date, open: true })),
  );
  const ids: string[] = [];
  const anchors =
    foldDates === 1
      ? ["2024-01-01", "2024-04-01", "2024-07-01"]
      : Array.from({ length: 3 }, (_, stage) =>
          Array.from({ length: foldDates }, (_, i) =>
            new Date(Date.UTC(2020 + stage, 0, 25 + i * 25))
              .toISOString()
              .slice(0, 10),
          ),
        ).flat();
  for (const [index, asOf] of anchors.entries()) {
    const start = dates.indexOf(asOf),
      members = Array.from({ length: count }, (_, i) => {
        const conditions =
            i % 3 === 0
              ? [...labFeatures]
              : i % 3 === 1
                ? [
                    "drawdown",
                    "oversold",
                    "support",
                    "above_sma5",
                    "sma5_rising",
                    "rsi_recovery",
                  ]
                : ["support", "above_sma5"],
          score = conditions.reduce(
            (n, k) =>
              n + labDefaultWeights[k as keyof typeof labDefaultWeights],
            0,
          );
        return cohortMemberSchema.parse({
          code: String(10000 + i),
          score,
          candidate: i % 3 !== 2,
          classification: i % 3 !== 2 ? "反転兆候あり" : "警戒",
          referencePrice: 100,
          inputRevisionIds: [`r${index}-${i}`],
          eligible: true,
          exclusionReasons: [],
          conditions,
          risks: [],
          indicators: {},
          adjustmentVersion: "fixture-v1",
          scoringMethodVersion: BOTTOM_CONFIG.methodVersion,
          featureVersion: BOTTOM_CONFIG.featureVersion,
          configHash: hash(BOTTOM_CONFIG),
        });
      });
    const base = {
      schemaVersion: 1 as const,
      jobId: randomUUID(),
      datasetId: `fixture-${index}`,
      analysisId: `fixture-${index}`,
      asOf,
      cutoff: `${asOf}T14:59:59.999Z`,
      methodVersion: "bottom-hunter-v1",
      scoringVersions: [
        JSON.stringify([
          BOTTOM_CONFIG.methodVersion,
          BOTTOM_CONFIG.featureVersion,
          hash(BOTTOM_CONFIG),
        ]),
      ],
      cohortMethod: "hunter-cohort-v1" as const,
      universeId: `fixture-${index}`,
      mode: "demo" as const,
      experiment: "walk-forward" as const,
      plan: "fixture",
      delayDays: 0,
      targets: {
        "1": dates[start + 1],
        "5": dates[start + 5],
        "20": dates[start + 20],
      },
      memberCount: members.length,
      shards: [
        {
          key: "members/00000.json",
          hash: hash(members),
          count: members.length,
        },
      ],
    };
    const cohortId = cohortIdentity(base),
      manifest = cohortManifestSchema.parse({
        ...base,
        cohortId,
        createdAt: "2025-01-01T00:00:00.000Z",
      });
    ids.push(cohortId);
    await s.store.write(
      `${cohortBase(cohortId)}/members/00000.json`,
      members,
      true,
    );
    await s.store.write(
      `${cohortBase(cohortId)}/manifest.json`,
      manifest,
      true,
    );
    for (const [i, m] of members.entries())
      for (const horizon of [1, 5, 20] as const) {
        const actualReturn =
            ((i % 3 === 0 ? -0.02 : i % 3 === 1 ? 0.03 : 0.01) * horizon) / 5,
          body = {
            schemaVersion: 1 as const,
            cohortId,
            code: m.code,
            horizon,
            target: base.targets[String(horizon) as "1" | "5" | "20"],
            status: "evaluated" as const,
            reasons: [],
            actualReturn,
            up: actualReturn > 0,
            maxDrawdown: Math.min(0, actualReturn),
            maxRise: Math.max(0, actualReturn),
            relapse: false,
            inputRevisionIds: [`outcome-${index}-${i}-${horizon}`],
            evaluatedAt: "2025-01-02T00:00:00.000Z",
            evaluationCutoff: "2025-01-02T00:00:00.000Z",
            dataAvailableAt: "2024-12-31T00:00:00.000Z",
            adjustmentVersion: "fixture-v1",
            basePrice: 100,
            targetPrice: 100 * (1 + actualReturn),
          },
          row = cohortEvaluationSchema.parse({
            ...body,
            evaluationId: cohortEvaluationId(body),
          });
        await s.store.write(
          `${cohortBase(cohortId)}/evaluations/${m.code}/${horizon}/${row.evaluationId}.json`,
          row,
          true,
        );
      }
  }
  return {
    cohortIds: ids,
    training:
      foldDates === 1
        ? { from: "2024-01-01", to: "2024-03-01" }
        : { from: "2020-01-01", to: "2020-12-31" },
    validation:
      foldDates === 1
        ? { from: "2024-04-01", to: "2024-06-01" }
        : { from: "2021-01-01", to: "2021-12-31" },
    test:
      foldDates === 1
        ? { from: "2024-07-01", to: "2024-09-01" }
        : { from: "2022-01-01", to: "2022-12-31" },
    embargoSessions: 20,
  };
}
