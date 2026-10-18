import type { Service } from "./service";
import { z } from "zod";
import {
  labRunInputSchema,
  labRunSchema,
  type LabRun,
  type LabMethod,
} from "../../../packages/core/hunter-experiment-schema";
import {
  cohortIdSchema,
  cohortMemberSchema,
  cohortEvaluationSchema,
  type CohortMember,
} from "../../../packages/core/hunter-cohort-schema";
import { rescoreLabMember } from "../../../packages/core/hunter-experiment-method";
import { BOTTOM_CONFIG } from "../../../packages/core/bottom-score";
import { hash } from "../../../packages/integrations/adjusted-series";
import { readCohort } from "./hunter-cohort";
import { cohortEvaluations } from "./hunter-cohort-evaluation";
import {
  labBase,
  readLabMethod,
  readLabPlan,
  labEvents,
} from "./hunter-experiment";
import {
  verifyLabPlanInputs,
  openLabTest,
  observeLabPeriod,
} from "./hunter-experiment-temporal";
import { runResearchJob, controlResearchJob } from "./research-json-worker";
export const labRunKey = (id: string) =>
  `${labBase}/runs/${cohortIdSchema.parse(id)}/checkpoint.json`;
export const labPartSchema = z
  .object({
    cohortId: cohortIdSchema,
    inputHash: cohortIdSchema,
    members: z.array(
      z.object({
        original: cohortMemberSchema,
        score: z.number().finite().nullable(),
        candidate: z.boolean(),
        status: z.enum(["ready", "excluded"]),
        reason: z.string().nullable(),
      }),
    ),
    evaluations: z.array(cohortEvaluationSchema),
    contentHash: cohortIdSchema,
  })
  .strict();
function labScoredMembers(members: CohortMember[], m: LabMethod) {
  return labPartSchema.shape.members.parse(
    members.map((original) => ({
      original,
      ...rescoreLabMember(original, m),
      ...(original.configHash !== hash(BOTTOM_CONFIG)
        ? {
            status: "excluded" as const,
            reason: "baseline-config-unavailable",
            score: null,
            candidate: false,
          }
        : {}),
    })),
  );
}
export async function readLabRun(s: Service, id: string) {
  const j = labRunSchema.parse(await s.store.read(labRunKey(id)));
  const input = labRunInputSchema.parse({
    experimentId: j.experimentId,
    planId: j.planId,
    stage: j.stage,
    confirm: j.confirm,
  });
  if (j.runId !== id || hash(["lab-run-v1", input, j.inputHash]) !== id)
    throw Error("実験ジョブhash不一致");
  return j;
}
export async function createLabRun(s: Service, raw: unknown, now = new Date()) {
  const q = labRunInputSchema.parse(raw),
    p = await verifyLabPlanInputs(s, q.planId),
    m = await readLabMethod(s, q.experimentId);
  const events = await labEvents(s, m.experimentId);
  if (
    !["testing", "validated", "proposed-for-adoption"].includes(
      events.at(-1)?.status ?? "draft",
    )
  )
    throw Error("実験方式をtestingへ明示変更してください");
  if (m.proposalId) {
    const { readLabProposal } = await import("./hunter-experiment-hypotheses");
    if ((await readLabProposal(s, m.proposalId)).planId !== p.planId)
      throw Error("仮説のTraining計画が違います");
  }
  if (!Object.values(p.partitions).includes(q.stage))
    throw Error("対象区間がありません");
  const inputHash = hash([p, m, p.evaluationIds]),
    runId = hash(["lab-run-v1", q, inputHash]);
  return s.store.lock(async () => {
    if (q.stage === "test") await openLabTest(s, p, m.experimentId);
    else if (
      await s.store.read(`${labBase}/exposures/${p.planId}/original.json`, null)
    )
      throw Error("最終Test開封後は方式探索を追加できません");
    const old = await s.store.read(labRunKey(runId), null);
    if (old) return readLabRun(s, runId);
    if (q.stage !== "test")
      await observeLabPeriod(s, p, m.experimentId, runId, q.stage);
    const j = labRunSchema.parse({
      ...q,
      runId,
      inputHash,
      createdAt: now.toISOString(),
      status: "queued",
      processed: 0,
      failed: 0,
      total: p.cohortIds.filter((c) => p.partitions[c] === q.stage).length,
    });
    await s.store.write(labRunKey(runId), j, true);
    return j;
  });
}
export async function runLabExperiment(
  s: Service,
  id: string,
  maxUnits = Infinity,
) {
  const j = await readLabRun(s, id),
    p = await verifyLabPlanInputs(s, j.planId),
    m = await readLabMethod(s, j.experimentId);
  if (hash([p, m, p.evaluationIds]) !== j.inputHash)
    throw Error("再開時の入力が変化しています");
  const ids = p.cohortIds.filter((c) => p.partitions[c] === j.stage);
  return runResearchJob(
    s,
    labRunKey(id),
    async (index) => {
      const cohortId = ids[index],
        { manifest, members } = await readCohort(s, cohortId);
      if (hash(manifest) !== p.cohortHashes[cohortId])
        throw Error("コホートが変更されました");
      const key = `${labBase}/runs/${id}/parts/${cohortId}.json`,
        old = await s.store.read(key, null);
      if (old) {
        const parsed = labPartSchema.parse(old),
          { contentHash, ...body } = parsed;
        if (hash(body) !== contentHash || parsed.inputHash !== j.inputHash)
          throw Error("checkpoint内容不一致");
        return;
      }
      const rows = labScoredMembers(members, m);
      const evaluations = (
        await cohortEvaluations(s, cohortId, p.evaluationCutoff)
      ).filter((e) => p.evaluationIds.includes(e.evaluationId));
      const normalized = labPartSchema.parse({
          cohortId,
          inputHash: j.inputHash,
          members: rows,
          evaluations,
          contentHash: "0".repeat(64),
        }),
        { contentHash: placeholder, ...body } = normalized;
      void placeholder;
      normalized.contentHash = hash(body);
      await s.store.lock(async () => {
        if (!(await s.store.read(key, null)))
          await s.store.write(key, normalized, true);
      });
    },
    maxUnits,
  );
}
export async function controlLabRun(
  s: Service,
  id: string,
  action: "pause" | "cancel" | "resume",
) {
  await readLabRun(s, id);
  return controlResearchJob(s, labRunKey(id), action);
}
export async function completedLabParts(s: Service, id: string) {
  const j = await readLabRun(s, id);
  if (j.status !== "completed" || j.processed !== j.total)
    throw Error("途中結果は完成レポートとして表示できません");
  const p = await readLabPlan(s, j.planId),
    m = await readLabMethod(s, j.experimentId),
    ids = p.cohortIds.filter((c) => p.partitions[c] === j.stage),
    parts = [];
  for (const c of ids) {
    const part = labPartSchema.parse(
        await s.store.read(`${labBase}/runs/${id}/parts/${c}.json`),
      ),
      { contentHash, ...body } = part;
    if (
      part.cohortId !== c ||
      part.inputHash !== j.inputHash ||
      hash(body) !== contentHash
    )
      throw Error("結果shard不一致");
    const fixed = await readCohort(s, c);
    if (
      hash(fixed.manifest) !== p.cohortHashes[c] ||
      hash(labScoredMembers(fixed.members, m)) !== hash(part.members)
    )
      throw Error("再採点結果と固定特徴量が一致しません");
    const originals = (await cohortEvaluations(s, c, p.evaluationCutoff))
      .filter((e) => p.evaluationIds.includes(e.evaluationId))
      .sort((a, b) => a.evaluationId.localeCompare(b.evaluationId));
    if (
      hash(originals) !==
      hash(
        [...part.evaluations].sort((a, b) =>
          a.evaluationId.localeCompare(b.evaluationId),
        ),
      )
    )
      throw Error("期限後評価と実験結果の根拠が一致しません");
    parts.push(part);
  }
  return { job: j, plan: p, parts };
}
export type ExperimentRun = LabRun;
