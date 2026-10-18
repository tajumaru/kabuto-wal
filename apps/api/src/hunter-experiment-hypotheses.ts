import { z } from "zod";
import type { Service } from "./service";
import { readLabPlan, labBase } from "./hunter-experiment";
import { readNotebook } from "./kabumaru-notebook";
import { cohortIdSchema } from "../../../packages/core/hunter-cohort-schema";
import { labMethodInputSchema } from "../../../packages/core/hunter-experiment-schema";
import { labDefaultWeights } from "../../../packages/core/hunter-experiment-method";
import { hash } from "../../../packages/integrations/adjusted-series";
export const labProposalSchema = z
  .object({
    proposalId: cohortIdSchema,
    planId: cohortIdSchema,
    notebookIds: z.array(cohortIdSchema),
    createdAt: z.string().datetime(),
    sampleCount: z.number().int().nonnegative(),
    proposal: labMethodInputSchema,
    warnings: z.array(z.string()),
  })
  .strict();
export async function readLabProposal(s: Service, id: string) {
  const p = labProposalSchema.parse(
      await s.store.read(
        `${labBase}/proposals/${cohortIdSchema.parse(id)}/original.json`,
      ),
    ),
    { proposalId, ...body } = p;
  if (proposalId !== id || hash(body) !== id)
    throw Error("仮説の根拠hash不一致");
  return p;
}
export async function generateLabHypothesis(
  s: Service,
  raw: unknown,
  now = new Date(),
) {
  const q = z
      .object({
        planId: cohortIdSchema,
        notebookIds: z.array(cohortIdSchema).min(1).max(20),
      })
      .strict()
      .parse(raw),
    plan = await readLabPlan(s, q.planId),
    notes = [];
  for (const id of [...new Set(q.notebookIds)].sort()) {
    const n = await readNotebook(s, id);
    if (
      n.createdAt > plan.createdAt ||
      n.mode !== plan.mode ||
      n.cohortIds.some((c) => plan.partitions[c] !== "training") ||
      n.evaluationIds.some((e) => !plan.evaluationIds.includes(e))
    )
      throw Error("Training内で計画作成前に固定された研究ノートだけを使えます");
    notes.push(n);
  }
  const parameters = { ...labDefaultWeights },
    themes = notes.map((n) => n.theme);
  if (themes.includes("volume-reversal")) parameters.volume_rebound = 22.5;
  else if (themes.includes("rsi-recovery")) parameters.rsi_recovery = 5;
  else if (themes.includes("base-building")) parameters.support = 22.5;
  else if (themes.includes("downtrend-rebound")) parameters.above_sma20 = 15;
  else parameters.lower_wick = 7.5;
  if (themes.every((t) => t === "dejavu-similarity"))
    throw Error("固定済み類似度がないため仮説設定を生成できません");
  const sampleCount = notes.reduce(
    (n, x) => n + x.evidence.reduce((a, e) => a + e.sampleCount, 0),
    0,
  );
  const proposal = labMethodInputSchema.parse({
    name: "かぶまるの探索仮説",
    description: "Trainingの記述的研究から作成した未検証の設定候補",
    hypothesis:
      "保存済み条件の重みを変えた場合の選別結果を、Validationで確認する。改善は未確認。",
    parameters,
    candidateThreshold: 60,
    evidenceIds: [
      ...new Set(notes.flatMap((n) => n.evidence.map((e) => e.evidenceId))),
    ],
  });
  const body = {
      planId: plan.planId,
      notebookIds: notes.map((n) => n.notebookId),
      createdAt: now.toISOString(),
      sampleCount,
      proposal,
      warnings: [
        "標本数は期間窓を含む参照件数で、独立標本数ではありません。",
        "ルールベースの探索仮説。Training成績は採用根拠にしません。",
        "本番条件・コードは変更しません。実験開始には人間の明示確認が必要です。",
      ],
    },
    record = labProposalSchema.parse({ ...body, proposalId: hash(body) });
  await s.store.lock(() =>
    s.store.write(
      `${labBase}/proposals/${record.proposalId}/original.json`,
      record,
      true,
    ),
  );
  return record;
}
