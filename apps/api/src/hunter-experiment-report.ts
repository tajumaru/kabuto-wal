import type { Service } from "./service";
import { completedLabParts, readLabRun } from "./hunter-experiment-runner";
import { labBase, readLabMethod } from "./hunter-experiment";
import { readCohort } from "./hunter-cohort";
import {
  comparativeCohortReport,
  cohortMetrics,
  type CohortObservation,
} from "./hunter-cohort-report";
import { hash } from "../../../packages/integrations/adjusted-series";
import {
  labReportSchema,
  type LabReport,
} from "../../../packages/core/hunter-lab-report-schema";
import { cohortIdSchema } from "../../../packages/core/hunter-cohort-schema";
export async function buildLabReport(
  s: Service,
  id: string,
): Promise<LabReport> {
  const { job: j, plan: p, parts } = await completedLabParts(s, id),
    m = await readLabMethod(s, j.experimentId),
    baseline: CohortObservation[] = [],
    experiment: CohortObservation[] = [];
  let eligible = 0,
    excluded = 0,
    agree = 0,
    union = 0,
    intersection = 0;
  for (const part of parts) {
    const { manifest: c } = await readCohort(s, part.cohortId),
      latest = new Map<string, (typeof part.evaluations)[number]>();
    for (const e of [...part.evaluations].sort(
      (a, b) =>
        a.evaluationCutoff.localeCompare(b.evaluationCutoff) ||
        a.evaluatedAt.localeCompare(b.evaluatedAt) ||
        a.evaluationId.localeCompare(b.evaluationId),
    ))
      latest.set(`${e.code}/${e.horizon}`, e);
    for (const r of part.members) {
      if (r.status === "ready") {
        eligible++;
        if (r.original.candidate === r.candidate) agree++;
        if (r.original.candidate || r.candidate) union++;
        if (r.original.candidate && r.candidate) intersection++;
      } else excluded++;
      for (const horizon of [1, 5, 20] as const) {
        const member = { ...r.original, eligible: r.status === "ready" },
          evaluation = latest.get(`${member.code}/${horizon}`);
        baseline.push({ cohort: c, member, horizon, evaluation });
        experiment.push({
          cohort: c,
          member: { ...member, score: r.score, candidate: r.candidate },
          horizon,
          evaluation,
        });
      }
    }
  }
  // Use the same pre-outcome overlap selection for both methods and all derived metrics.
  const accepted = new Set<string>(),
    ends = new Map<string, string>();
  for (const r of [...baseline].sort(
    (a, b) =>
      a.cohort.asOf.localeCompare(b.cohort.asOf) ||
      a.cohort.createdAt.localeCompare(b.cohort.createdAt) ||
      a.cohort.cohortId.localeCompare(b.cohort.cohortId),
  )) {
    if (!r.member.eligible) continue;
    const k = `${r.member.code}/${r.horizon}`,
      end = ends.get(k);
    if (end && end >= r.cohort.asOf) continue;
    accepted.add(`${r.cohort.cohortId}/${k}`);
    ends.set(
      k,
      r.cohort.targets[String(r.horizon) as "1" | "5" | "20"] ?? "9999-12-31",
    );
  }
  const keep = (r: CohortObservation) =>
      !r.member.eligible ||
      accepted.has(`${r.cohort.cohortId}/${r.member.code}/${r.horizon}`),
    baseRows = baseline.filter(keep),
    experimentRows = experiment.filter(keep);
  const ids = parts.map((r) => r.cohortId),
    now = new Date(j.createdAt),
    a = comparativeCohortReport(baseline, ids, now),
    b = comparativeCohortReport(experiment, ids, now),
    cost = (2 * (p.costBps + p.slippageBps)) / 10000;
  // Cost is a separate derived metric; original evaluation prices/returns are untouched.
  const net = (report: typeof a, rows: CohortObservation[]) => {
    for (const g of report.groups) {
      const selected = rows.filter(
          (r) => r.horizon === g.horizon && r.member.eligible,
        ),
        adjust = (
          metric: typeof g.candidate,
          predicate: (r: CohortObservation) => boolean,
        ) => {
          if (metric.meanReturn !== null) metric.meanReturn -= cost;
          if (metric.medianReturn !== null) metric.medianReturn -= cost;
          const es = selected.filter(
            (r) => predicate(r) && r.evaluation?.status === "evaluated",
          );
          if (es.length)
            metric.upRatio =
              es.filter((r) => r.evaluation!.actualReturn! > cost).length /
              es.length;
        };
      adjust(g.candidate, (r) => r.member.candidate);
      adjust(g.control, (r) => !r.member.candidate);
      for (const [band, metric] of Object.entries(g.bands))
        adjust(metric, (r) => {
          const x = r.member.score;
          return (
            x !== null &&
            (x < 40
              ? "0-39"
              : x < 60
                ? "40-59"
                : x < 80
                  ? "60-79"
                  : "80-100") === band
          );
        });
    }
    return report;
  };
  net(a, baseRows);
  net(b, experimentRows);
  const comparisons = [1, 5, 20].map((horizon) => {
    const all = baseRows.filter(
        (r) => r.horizon === horizon && r.member.eligible,
      ),
      market = cohortMetrics(all).meanReturn,
      ag = a.groups.find((g) => g.horizon === horizon),
      bg = b.groups.find((g) => g.horizon === horizon),
      pairs: number[] = [];
    const dates = [...new Set(all.map((r) => r.cohort.asOf))];
    for (const date of dates) {
      const av = cohortMetrics(
          all.filter((r) => r.cohort.asOf === date && r.member.candidate),
        ).meanReturn,
        bv = cohortMetrics(
          experimentRows.filter(
            (r) =>
              r.horizon === horizon &&
              r.member.eligible &&
              r.cohort.asOf === date &&
              r.member.candidate,
          ),
        ).meanReturn;
      if (av !== null && bv !== null) pairs.push(bv - av);
    }
    return {
      horizon,
      marketMean: market === null ? null : market - cost,
      baselineExcess:
        market !== null &&
        ag?.candidate.meanReturn !== null &&
        ag?.candidate.meanReturn !== undefined
          ? ag.candidate.meanReturn - (market - cost)
          : null,
      experimentExcess:
        market !== null &&
        bg?.candidate.meanReturn !== null &&
        bg?.candidate.meanReturn !== undefined
          ? bg.candidate.meanReturn - (market - cost)
          : null,
      candidateMeanDifference: pairs.length
        ? pairs.reduce((x, y) => x + y, 0) / pairs.length
        : null,
      pairedDates: pairs.length,
    };
  });
  const trialCount = (await s.store.files(`${labBase}/runs`)).filter((f) =>
      f.endsWith("/checkpoint.json"),
    ).length,
    sufficient =
      a.groups.length === 3 &&
      b.groups.length === 3 &&
      [...a.groups, ...b.groups].every((g) => !g.lowSample) &&
      comparisons.every((c) => c.pairedDates >= 10),
    evaluatedPairs = baseRows.filter(
      (r) => r.member.eligible && r.evaluation?.status === "evaluated",
    ).length;
  const evidenceId = hash([
      "lab-evidence-v1",
      j.inputHash,
      parts.map((r) => r.contentHash),
      a,
      b,
    ]),
    notes = [
      "探索的な比較。取引コスト控除前の終値ベース最大下落・再下落は参考指標です。",
      "市場平均は同一固定ユニバース内の等銘柄平均。TOPIX超過リターンではありません。",
      "業種・時価総額・上場廃止の偏りは保存情報不足で未調整。",
      "同一銘柄の重複結果窓は既存レポートで除外。候補一致率・時点別差は固定対応集合の記述指標で、独立標本数ではありません。",
      "方式間の差に対する信頼区間は未推定。各方式の候補対照差の区間は探索的な二軸bootstrap。",
      "試行回数は保存済み全実験ジョブ数。多重比較の補正や有意な改善の証明ではありません。",
      ...(j.stage === "test"
        ? [
            "最終Testは開封済みです。この期間は次の方式調整に対する未使用Testには戻せません。",
          ]
        : [
            "Training/Validationは探索・選択用。最終Testの好成績を保証しません。",
          ]),
      ...(!sufficient
        ? ["期間・銘柄・両群の標本不足のため方式の優劣を判断しません。"]
        : []),
    ];
  const body = {
    schemaVersion: 1 as const,
    runId: id,
    planId: p.planId,
    experimentId: m.experimentId,
    stage: j.stage,
    inputHash: j.inputHash,
    methodVersion: "lab-comparison-v1" as const,
    baseline: a,
    experiment: b,
    period: p[j.stage],
    costPerTrade: cost,
    candidateAgreement: eligible ? agree / eligible : null,
    candidateJaccard: union ? intersection / union : null,
    missingFeatureRate:
      eligible + excluded ? excluded / (eligible + excluded) : 1,
    evaluatedPairs,
    sufficient,
    trialCount,
    comparisons,
    notes,
    evidenceId,
    statements: [
      {
        text: `${m.name}：${j.stage}、比較可能${eligible}銘柄時点、特徴量不足${excluded}件。${sufficient ? "期間ごとの逆転や多重比較にも注意し、採用は人間が判断するよ。" : "根拠が不足しており、まだ優劣を判断できないよ。"}`,
        evidenceId,
      },
      ...comparisons.map((c) => ({
        text: `${c.horizon}営業日：同時点の候補平均差（実験−現行）は${c.candidateMeanDifference === null ? "未評価" : `${(c.candidateMeanDifference * 100).toFixed(2)}ポイント`}、対応${c.pairedDates}時点だよ。`,
        evidenceId,
      })),
    ],
  };
  const notebookIds = m.proposalId
    ? (
        await (
          await import("./hunter-experiment-hypotheses")
        ).readLabProposal(s, m.proposalId)
      ).notebookIds
    : [];
  const report = labReportSchema.parse({
    ...body,
    method: m,
    notebookIds,
    reportId: "0".repeat(64),
  });
  const { reportId: placeholder, ...normalized } = report;
  void placeholder;
  report.reportId = hash(normalized);
  return s.store.lock(async () => {
    const key = `${labBase}/runs/${id}/report/original.json`,
      old = await s.store.read(key, null);
    if (old) {
      const parsed = labReportSchema.parse(old),
        { reportId, ...content } = parsed;
      const expected = labReportSchema.parse({
          ...report,
          trialCount: parsed.trialCount,
        }),
        { reportId: unused, ...expectedBody } = expected;
      void unused;
      expected.reportId = hash(expectedBody);
      if (
        hash(content) !== reportId ||
        JSON.stringify(parsed) !== JSON.stringify(expected)
      )
        throw Error("レポート根拠・説明数値の不一致");
      return parsed;
    }
    await s.store.write(key, report, true);
    if (j.stage === "validation")
      await s.store.write(
        `${labBase}/methods/${m.experimentId}/validation/${id}.json`,
        { runId: id, planId: p.planId, reportId: report.reportId, sufficient },
        true,
      );
    return report;
  });
}
export async function readLabReport(s: Service, id: string) {
  await readLabRun(s, cohortIdSchema.parse(id));
  return buildLabReport(s, id);
}
