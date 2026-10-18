import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { labFixture } from "../fixtures/lab";
import { createLabPlan, verifyLabPlanInputs } from "../apps/api/src/hunter-experiment-temporal";
import { createLabMethod, changeLabState } from "../apps/api/src/hunter-experiment";
import { createLabRun, runLabExperiment, completedLabParts } from "../apps/api/src/hunter-experiment-runner";
import { buildLabReport } from "../apps/api/src/hunter-experiment-report";
import { labDefaultWeights } from "../packages/core/hunter-experiment-method";
import { cohortEvaluationId } from "../apps/api/src/hunter-cohort-evaluation";
import { cohortBase } from "../apps/api/src/hunter-cohort";
import { hash } from "../packages/integrations/adjusted-series";

for (const mutation of ["calendar", "missing", "content", "cutoff"] as const) {
  it(`固定入力の${mutation}変更を開始・再開・完成レポートで拒否する`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lab-integrity-")), s = new Service(root, "demo", false);
    try {
      const input = await labFixture(s, 1), p = await createLabPlan(s, input, new Date("2025-01-04T00:00:00Z"));
      const m = await createLabMethod(s, { name: "test", hypothesis: "fixed inputs", parameters: labDefaultWeights, candidateThreshold: 60 });
      await changeLabState(s, m.experimentId, { status: "testing", reason: "test", confirm: true });
      const q = { planId: p.planId, experimentId: m.experimentId, stage: "training", confirm: true }, j = await createLabRun(s, q);
      await runLabExperiment(s, j.runId);
      await buildLabReport(s, j.runId);
      const file = (await s.store.files(`${cohortBase(input.cohortIds[0])}/evaluations`))[0];
      if (mutation === "calendar") await s.store.write("market/calendar.json", []);
      else if (mutation === "missing") await unlink(path.join(root, file));
      else {
        const row = await s.store.read(file);
        await writeFile(path.join(root, file), JSON.stringify({ ...row, ...(mutation === "content" ? { actualReturn: .99 } : { evaluationCutoff: "2025-01-03T00:00:00.000Z" }) }));
      }
      await expect(verifyLabPlanInputs(s, p.planId)).rejects.toThrow();
      await expect(createLabRun(s, q)).rejects.toThrow();
      await expect(runLabExperiment(s, j.runId)).rejects.toThrow();
      await expect(buildLabReport(s, j.runId)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

it("後日追加評価を固定集合へ混ぜず、旧形式の計画も書換えずに検証する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lab-addition-")), s = new Service(root, "demo", false);
  try {
    const input = await labFixture(s, 1), p = await createLabPlan(s, input, new Date("2025-01-04T00:00:00Z"));
    const file = (await s.store.files(`${cohortBase(input.cohortIds[0])}/evaluations`))[0], row = await s.store.read(file);
    const body = { ...row, actualReturn: .5, targetPrice:150, up:true, maxRise:.5, evaluatedAt: "2025-02-01T00:00:00.000Z", evaluationCutoff: "2025-02-01T00:00:00.000Z" }, id = cohortEvaluationId(body);
    await s.store.write(file.replace(`${row.evaluationId}.json`, `${id}.json`), { ...body, evaluationId: id }, true);
    expect((await verifyLabPlanInputs(s, p.planId)).evaluationIds).not.toContain(id);
    const {planId:unused,evaluationHashes:unusedHashes,...legacyBody}=p;
    void unused; void unusedHashes;
    const legacyId=hash(legacyBody),legacy={...legacyBody,planId:legacyId},legacyKey=`research/lab/plans/${legacyId}/original.json`;
    await s.store.write(legacyKey,legacy,true);
    expect(await verifyLabPlanInputs(s,legacyId)).toEqual(legacy);
    expect(await s.store.read(legacyKey)).toEqual(legacy);
    const m = await createLabMethod(s, { name: "test", hypothesis: "fixed inputs", parameters: labDefaultWeights, candidateThreshold: 60 });
    await changeLabState(s, m.experimentId, { status: "testing", reason: "test", confirm: true });
    const j = await createLabRun(s, { planId: p.planId, experimentId: m.experimentId, stage: "training", confirm: true });
    await runLabExperiment(s, j.runId, 0);
    const { controlLabRun } = await import("../apps/api/src/hunter-experiment-runner");
    await controlLabRun(s, j.runId, "resume");
    await runLabExperiment(s, j.runId);
    expect((await completedLabParts(s, j.runId)).parts.flatMap(x => x.evaluations).some(e => e.evaluationId === id)).toBe(false);
    await unlink(path.join(root,file));
    await expect(verifyLabPlanInputs(s,legacyId)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
