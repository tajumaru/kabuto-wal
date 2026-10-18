import type { AgentToolContext, AgentToolResult } from "./kabumaru-agent-tools";
import { compareAgentFolds } from "./kabumaru-agent-walk-forward";
import {
  agentResearchReportSchema,
  classifyAgentOutcome,
  type AgentResearchReport,
} from "../../../packages/core/kabumaru-agent-report-schema";
import { readLabReport } from "./hunter-experiment-report";
import {
  agentBase,
  agentHash,
  agentState,
  readAgentPlan,
  agentEvents,
} from "./kabumaru-agent-audit";
import { agentArtifacts } from "./kabumaru-agent-runner";
import { readAgentApproval } from "./kabumaru-agent";
import { verifyAgentSources } from "./kabumaru-agent-planner";
import { agentFoldComparisonSchema } from "../../../packages/core/kabumaru-agent-walk-forward";
import type { Service } from "./service";
import { readLabPlan } from "./hunter-experiment";
export async function evaluateAgentResearch(
  c: AgentToolContext,
  createdAt = new Date().toISOString(),
): Promise<AgentResearchReport> {
  const { s, plan: p } = c,
    allValidations = p.steps
      .filter((s) => s.tool === "run-validation")
      .every((step) =>
        c.artifacts.some(
          (a) => a.stepId === step.stepId && a.status === "completed",
        ),
      );
  const comparison = allValidations
    ? await compareAgentFolds(c)
    : {
        version: "agent-walk-forward-v1" as const,
        selectionPolicy: "positive-median-validation-20-v1" as const,
        folds: await Promise.all(
          p.foldPlanIds.map(async (labPlanId, index) => ({
            index,
            labPlanId,
            period: (await readLabPlan(s, labPlanId)).validation,
            included: false,
            reason: "承認したValidationステップが未完了または失敗しています。",
            methods: [],
          })),
        ),
        methods: [],
        pairedMethodDifferences: [],
        selectedMethodId: null,
        sufficient: false,
        trialCount: 0,
        warnings: ["未完了のValidationがあるため集計を確定しません。"],
      };
  const prior = c.artifacts.find((a) => a.tool === "compare-folds");
  if (prior) {
    const fixed = agentFoldComparisonSchema.parse(prior.output);
    comparison.trialCount = fixed.trialCount;
    if (agentHash(fixed) !== agentHash(comparison))
      throw Error("研究比較artifactと実験Evidenceの数値が一致しません");
  }
  const experiments: AgentResearchReport["experiments"] = [];
  for (const a of c.artifacts.filter(
    (a) =>
      ["run-validation", "run-final-test"].includes(a.tool) &&
      a.status === "completed",
  )) {
    await c.guard();
    const r = await readLabReport(s, String(a.output.runId));
    const step = p.steps.find((step) => step.stepId === a.stepId)!;
    if (
      r.reportId !== a.output.reportId ||
      r.evidenceId !== a.output.evidenceId ||
      !p.methodIds.includes(r.experimentId) ||
      !p.foldPlanIds.includes(r.planId) ||
      (a.tool === "run-validation" &&
        (r.stage !== "validation" ||
          r.planId !== step.input.labPlanId ||
          r.experimentId !== step.input.methodId)) ||
      (a.tool === "run-final-test" &&
        (r.stage !== "test" ||
          r.planId !== p.foldPlanIds.at(-1) ||
          r.experimentId !== comparison.selectedMethodId))
    )
      throw Error("研究結果の実験・Evidenceが承認外です");
    experiments.push({
      runId: r.runId,
      experimentId: r.experimentId,
      reportId: r.reportId,
      evidenceId: r.evidenceId,
      stage: r.stage as "validation" | "test",
    });
  }
  const finalRef = experiments.find((e) => e.stage === "test"),
    r = finalRef ? await readLabReport(s, finalRef.runId) : null,
    finalTest = r
      ? {
          runId: r.runId,
          experimentId: r.experimentId,
          reportId: r.reportId,
          evidenceId: r.evidenceId,
          sufficient: r.sufficient,
          difference:
            r.comparisons.find((c) => c.horizon === 20)
              ?.candidateMeanDifference ?? null,
        }
      : null;
  const best = comparison.methods[0],
    chosen = comparison.methods.find(
      (m) => m.methodId === comparison.selectedMethodId,
    ),
    classification = classifyAgentOutcome(
      comparison.sufficient,
      best?.median ?? null,
      chosen?.min ?? null,
      finalTest?.sufficient ?? false,
      finalTest?.difference ?? null,
    ),
    reason = {
      "insufficient-data":
        "必要な独立fold・候補対照・期限後評価が不足しています。",
      "not-supported":
        "Validation中央値が現行方式を上回らず、改善仮説は支持されません。Testは開封しません。",
      supported:
        "今回の固定Validationと最終Testで方向が一致しました。観測範囲内の記述的な支持です。",
      mixed:
        "期間または最終Testで結果が逆転しています。安定した改善とは判断できません。",
    }[classification];
  const evidenceIds = [
      ...new Set([...p.evidenceIds, ...experiments.map((e) => e.evidenceId)]),
    ].sort(),
    experimentIds = [...new Set(experiments.map((e) => e.experimentId))],
    uncertainty = [
      ...comparison.warnings,
      "分類は仮説に対する記述的評価で、株価上昇・統計的優位性・因果関係を保証しません。",
      "銘柄・学習期間の相関、欠損、業種・時価総額・相場局面の偏りと多重比較は未補正。",
      "方式間差の独立した信頼区間は未推定。標本不足では断定しません。",
      "本番採点・売買・外部同期・署名は実行していません。",
    ],
    nextTopics =
      classification === "insufficient-data"
        ? [
            "独立したValidation時点と候補・非候補の標本を蓄積する",
            "データ不足・取得締切の除外理由を確認する",
          ]
        : classification === "mixed"
          ? [
              "最悪foldと最終Testで逆転した相場局面を調べる",
              "新しい未使用期間を確保して安定性を再検証する",
            ]
          : classification === "not-supported"
            ? [
                "失敗条件をTraining内で再調査する",
                "調整後は新しい計画と未使用Testを確保する",
              ]
            : [
                "別相場局面・業種・規模で再検証する",
                "取引コストと多重比較の影響を検証する",
              ];
  const row = agentResearchReportSchema.parse({
      schemaVersion: 1,
      reportId: "0".repeat(64),
      sessionId: p.sessionId,
      planId: p.planId,
      planHash: agentHash(p),
      createdAt,
      methodVersion: "agent-research-evaluation-v1",
      validationVersion: "agent-walk-forward-v1",
      classification,
      reason,
      comparison,
      finalTest,
      experiments,
      evidenceIds,
      sourceRevisionHashes: p.sourceHashes,
      uncertainty,
      nextTopics,
      statements: [{ text: reason, evidenceIds, experimentIds }],
    }),
    { reportId: placeholder, ...body } = row;
  void placeholder;
  row.reportId = agentHash(body);
  return row;
}
export async function executeAgentEvaluation(
  c: AgentToolContext,
): Promise<AgentToolResult> {
  const report = await evaluateAgentResearch(c);
  await c.s.store.lock(() =>
    c.s.store.write(
      `${agentBase(c.plan.sessionId)}/plans/${c.plan.planId}/reports/${report.reportId}/original.json`,
      report,
      true,
    ),
  );
  return {
    status: "completed",
    output: {
      reportId: report.reportId,
      classification: report.classification,
      reason: report.reason,
      nextTopics: report.nextTopics,
    },
    references: [report.reportId, ...report.evidenceIds],
  };
}
export async function readAgentResearchReport(s: Service, sessionId: string) {
  const state = await agentState(s, sessionId);
  if (!state.planId) throw Error("研究計画がありません");
  const p = await readAgentPlan(s, sessionId, state.planId),
    artifacts = await agentArtifacts(s, p);
  await readAgentApproval(s, p);
  await verifyAgentSources(s, p);
  const c: AgentToolContext = {
    s,
    plan: p,
    step: p.steps.find((s) => s.tool === "evaluate-research")!,
    artifacts,
    guard: async () => {},
    chargeExperiment: async () => {
      throw Error("読み取り中は実験できません");
    },
    setChild: async () => {
      throw Error("読み取り中は実験できません");
    },
  };
  const result = artifacts.find((a) => a.tool === "evaluate-research");
  if (result) {
    const r = agentResearchReportSchema.parse(
        await s.store.read(
          `${agentBase(sessionId)}/plans/${p.planId}/reports/${String(result.output.reportId)}/original.json`,
        ),
      ),
      expected = await evaluateAgentResearch(c, r.createdAt);
    if (
      agentHash(r) !== agentHash(expected) ||
      r.reportId !== result.output.reportId ||
      r.classification !== result.output.classification
    )
      throw Error("研究レポートの説明・根拠が一致しません");
    return r;
  }
  if (!["failed", "cancelled"].includes(state.status))
    throw Error("研究評価は未完了です");
  const events = await agentEvents(s, sessionId),
    createdAt =
      [...events].reverse().find((e) => e.status)?.createdAt ?? p.createdAt,
    r = await evaluateAgentResearch(c, createdAt);
  await s.store.lock(async () => {
    const key = `${agentBase(sessionId)}/plans/${p.planId}/reports/${r.reportId}/original.json`;
    if (!(await s.store.read(key, null))) await s.store.write(key, r, true);
  });
  return r;
}
