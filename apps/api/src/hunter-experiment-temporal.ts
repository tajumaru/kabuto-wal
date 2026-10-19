import { z } from "zod";
import type { Service } from "./service";
import type { Calendar } from "../../../packages/core/index";
import {
  labPlanInputSchema,
  labPlanSchema,
  labPlanHistorySchema,
  type LabPlan,
} from "../../../packages/core/hunter-experiment-schema";
import {
  cohortIdSchema,
  type CohortManifest,
} from "../../../packages/core/hunter-cohort-schema";
import { readCohort } from "./hunter-cohort";
import { cohortEvaluations } from "./hunter-cohort-evaluation";
import { hash } from "../../../packages/integrations/adjusted-series";
import { labBase, readExecutableLabPlan, readLabMethod } from "./hunter-experiment";
export function temporalPartition(
  c: CohortManifest,
  p: z.infer<typeof labPlanInputSchema>,
  calendar: Calendar,
) {
  const phase = (["training", "validation", "test"] as const).find(
    (k) => c.asOf >= p[k].from && c.asOf <= p[k].to,
  );
  if (!phase)
    return { partition: "purged" as const, reason: "outside-periods" };
  if (c.cutoff > `${c.asOf}T14:59:59.999Z`)
    return {
      partition: "purged" as const,
      reason: "features-not-known-at-decision",
    };
  const end = c.targets["20"],
    boundary =
      phase === "training"
        ? p.validation.from
        : phase === "validation"
          ? p.test.from
          : null;
  if (!end || end > p[phase].to || (boundary && end >= boundary))
    return {
      partition: "purged" as const,
      reason: "outcome-crosses-split-or-incomplete-calendar",
    };
  const previous =
    phase === "validation"
      ? p.training.to
      : phase === "test"
        ? p.validation.to
        : null;
  if (
    previous &&
    calendar.filter((d) => d.open && d.date > previous && d.date <= c.asOf)
      .length <= p.embargoSessions
  )
    return { partition: "purged" as const, reason: "embargo" };
  return { partition: phase, reason: "" };
}
const exposureSchema = z
  .object({
    planId: cohortIdSchema,
    experimentId: cohortIdSchema,
    mode: z.string(),
    from: z.string().date(),
    to: z.string().date(),
    createdAt: z.string().datetime(),
  })
  .strict();
export async function createLabPlan(
  s: Service,
  raw: unknown,
  now = new Date(),
) {
  const q = labPlanInputSchema.parse(raw),
    calendar = await s.store.read<Calendar>("market/calendar.json", []);
  if (
    !calendar.length ||
    new Set(calendar.map((d) => d.date)).size !== calendar.length
  )
    throw Error("整合した営業日カレンダーが必要です");
  const partitions: LabPlan["partitions"] = {},
    purgeReasons: Record<string, string> = {},
    cohortHashes: Record<string, string> = {},
    evaluationIds: string[] = [],
    evaluationHashes: Record<string, string> = {},
    versions = new Set<string>(),
    sizes = { training: 0, validation: 0, test: 0 };
  const ids = [...new Set(q.cohortIds)].sort();
  for (const id of ids) {
    const { manifest: c } = await readCohort(s, id);
    if (c.createdAt > now.toISOString() || c.cutoff > now.toISOString())
      throw Error("未来の入力です");
    versions.add(
      JSON.stringify([
        c.mode,
        c.experiment,
        c.methodVersion,
        c.scoringVersions,
        c.plan,
        c.delayDays,
      ]),
    );
    cohortHashes[id] = hash(c);
    const part = temporalPartition(c, q, calendar);
    partitions[id] = part.partition;
    if (part.reason) purgeReasons[id] = part.reason;
    if (
      part.partition !== "purged" &&
      (sizes[part.partition] += c.memberCount) > 50000
    )
      throw Error(
        "各区間50,000銘柄時点が上限です。計画の対象期間を分けてください",
      );
    for (const e of await cohortEvaluations(s, id, now.toISOString())) {
      evaluationIds.push(e.evaluationId);
      evaluationHashes[e.evaluationId] = hash(e);
    }
  }
  if (versions.size !== 1)
    throw Error("区分・現行方式・プランが一致するコホートだけを比較できます");
  if (
    (["training", "validation", "test"] as const).some(
      (k) => !Object.values(partitions).includes(k),
    )
  )
    throw Error(
      "purge・embargo後の各区間にコホートが必要です。期間を広げてください",
    );
  const mode = s.mode === "demo" ? "demo" : "research";
  // Previously displayed notebook outcomes are not a pristine holdout.
  const notes = await s.store.files("research/notebooks");
  for (const file of notes.filter((f) => f.endsWith("/original.json"))) {
    const n = await s.store.read<{
      mode: string;
      period: { from: string; to: string };
      evidence: { sampleCount: number }[];
    }>(file);
    if (
      n.mode === mode &&
      n.period.from <= q.test.to &&
      n.period.to >= q.test.from &&
      n.evidence.some((e) => e.sampleCount > 0)
    )
      throw Error("既存研究ノートで評価済みの期間を未使用Testに指定できません");
  }
  const body = {
      ...q,
      cohortIds: ids,
      mode,
      createdAt: now.toISOString(),
      evaluationCutoff: now.toISOString(),
      cohortHashes,
      calendarHash: hash(calendar),
      partitions,
      purgeReasons,
      evaluationIds: [...new Set(evaluationIds)].sort(),
      evaluationHashes,
      methodVersion: "temporal-lab-v1" as const,
    },
    plan = labPlanSchema.parse({ ...body, planId: "0".repeat(64) });
  const { planId: placeholder, ...normalized } = plan;
  void placeholder;
  plan.planId = hash(normalized);
  return s.store.lock(async () => {
    for (const raw of [
      ...(await s.store.all(`${labBase}/exposures`)),
      ...(await s.store.all(`${labBase}/observed`)),
    ]) {
      const e = exposureSchema.parse(raw);
      if (e.mode === mode && e.from <= q.test.to && e.to >= q.test.from)
        throw Error("参照済み期間は別計画の未使用Testに再利用できません");
    }
    await s.store.write(
      `${labBase}/plans/${plan.planId}/original.json`,
      plan,
      true,
    );
    return plan;
  });
}
export async function verifyLabPlanInputs(s: Service, id: string) {
  const p = await readExecutableLabPlan(s, id);
  const calendar = await s.store.read<Calendar>("market/calendar.json", []);
  if (hash(calendar) !== p.calendarHash)
    throw Error("固定営業日カレンダーの変更を検出しました");
  const fixedIds = new Set(p.evaluationIds), found = new Set<string>();
  if (fixedIds.size !== p.evaluationIds.length ||
      (p.evaluationHashes && (Object.keys(p.evaluationHashes).length !== fixedIds.size || Object.keys(p.evaluationHashes).some(key => !fixedIds.has(key)))))
    throw Error("固定評価集合が一致しません");
  for (let offset = 0; offset < p.cohortIds.length; offset += 8) {
    const batches = await Promise.all(p.cohortIds.slice(offset, offset + 8).map(async c => {
      if (hash((await readCohort(s, c)).manifest) !== p.cohortHashes[c])
        throw Error("固定入力の変更を検出しました");
      return cohortEvaluations(s, c, p.evaluationCutoff);
    }));
    // Existing reader verifies schema, semantic ID, file path, cohort and cutoff.
    // Later additions are not evidence of this plan; missing frozen IDs fail closed.
    for (const e of batches.flat()) {
      if (!fixedIds.has(e.evaluationId)) continue;
      if (found.has(e.evaluationId) || (p.evaluationHashes && p.evaluationHashes[e.evaluationId] !== hash(e)))
        throw Error("固定評価原本の変更を検出しました");
      found.add(e.evaluationId);
    }
  }
  if (found.size !== fixedIds.size) throw Error("固定評価原本が欠損またはcutoff外です");
  return p;
}
export async function selectLabMethod(
  s: Service,
  planId: string,
  experimentId: string,
  confirm: boolean,
) {
  if (!confirm) throw Error("方式選択の明示確認が必要です");
  const p = await verifyLabPlanInputs(s, planId),
    m = await readLabMethod(s, experimentId);
  let found = false;
  const { readLabReport } = await import("./hunter-experiment-report");
  for (const receipt of await s.store.all<{ runId: string }>(
    `${labBase}/methods/${experimentId}/validation`,
  )) {
    const report = await readLabReport(s, receipt.runId);
    if (
      report.planId === p.planId &&
      report.experimentId === experimentId &&
      report.stage === "validation" &&
      report.sufficient
    )
      found = true;
  }
  return s.store.lock(async () => {
    if (!found) throw Error("同一計画の十分なValidationが必要です");
    if (m.createdAt > new Date().toISOString()) throw Error("未来の方式です");
    const key = `${labBase}/plans/${planId}/selection/original.json`,
      old = await s.store.read(key, null);
    if (old) {
      if (old.experimentId !== experimentId)
        throw Error("Test方式は既に固定されています");
      return old;
    }
    const row = {
      planId,
      experimentId,
      createdAt: new Date().toISOString(),
      rollback: "本番切替なし。採用候補をrejectedにする追記で撤回する。",
    };
    await s.store.write(key, row, true);
    return row;
  });
}
// Must run under the writer lock, before a Test worker reads any outcomes.
export async function openLabTest(
  s: Service,
  p: LabPlan,
  experimentId: string,
) {
  const fixed = await verifyLabPlanInputs(s, p.planId);
  if(hash(fixed)!==hash(p))throw Error("Test開封時の固定入力が一致しません");
  const selection = await s.store.read<{ experimentId: string }>(
    `${labBase}/plans/${p.planId}/selection/original.json`,
    null,
  );
  if (selection?.experimentId !== experimentId)
    throw Error("最終Testは方式選択完了まで封印されています");
  const key = `${labBase}/exposures/${p.planId}/original.json`,
    old = await s.store.read(key, null);
  if (old) {
    if (old.experimentId !== experimentId)
      throw Error("Test開封方式が違います");
    return;
  }
  for (const f of (await s.store.files("research/notebooks")).filter((f) =>
    f.endsWith("/original.json"),
  )) {
    const n = await s.store.read<{
      mode: string;
      period: { from: string; to: string };
      evidence: { sampleCount: number }[];
    }>(f);
    if (
      n.mode === p.mode &&
      n.period.from <= p.test.to &&
      n.period.to >= p.test.from &&
      n.evidence.some((e) => e.sampleCount > 0)
    )
      throw Error(
        "計画後にTest期間の研究ノートが作成されています。未使用Testとして開封できません",
      );
  }
  for (const raw of [
    ...(await s.store.all(`${labBase}/exposures`)),
    ...(await s.store.all(`${labBase}/observed`)),
  ]) {
    const e = exposureSchema.parse(raw);
    if (e.mode === p.mode && e.from <= p.test.to && e.to >= p.test.from)
      throw Error("Test期間が既に参照されています");
  }
  await s.store.write(
    key,
    {
      planId: p.planId,
      experimentId,
      mode: p.mode,
      ...p.test,
      createdAt: new Date().toISOString(),
    },
    true,
  );
}
// Called under the writer lock before non-Test work. A viewed training/validation
// interval cannot later be relabelled as an untouched Test by another plan.
export async function observeLabPeriod(
  s: Service,
  p: LabPlan,
  experimentId: string,
  runId: string,
  stage: "training" | "validation",
) {
  for (const f of (await s.store.files(`${labBase}/plans`)).filter((f) =>
    /^research\/lab\/plans\/[a-f0-9]{64}\/original.json$/.test(f),
  )) {
    const other = labPlanHistorySchema.parse(await s.store.read(f));
    if (other.planId === p.planId || other.mode !== p.mode) continue;
    if (
      other.test.from <= p[stage].to &&
      other.test.to >= p[stage].from &&
      !(await s.store.read(
        `${labBase}/exposures/${other.planId}/original.json`,
        null,
      ))
    )
      throw Error("別計画で封印中のTest期間を探索に利用できません");
  }
  const key = `${labBase}/observed/${runId}/original.json`;
  if (!(await s.store.read(key, null)))
    await s.store.write(
      key,
      {
        planId: p.planId,
        experimentId,
        mode: p.mode,
        ...p[stage],
        createdAt: new Date().toISOString(),
      },
      true,
    );
}
