import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { labFixture } from "../fixtures/lab";
import {
  createLabMethod,
  changeLabState,
  labBase,
} from "../apps/api/src/hunter-experiment";
import {
  createLabPlan,
  selectLabMethod,
} from "../apps/api/src/hunter-experiment-temporal";
import {
  createLabRun,
  runLabExperiment,
} from "../apps/api/src/hunter-experiment-runner";
import { buildLabReport } from "../apps/api/src/hunter-experiment-report";
import { labDefaultWeights } from "../packages/core/hunter-experiment-method";
import { hash } from "../packages/integrations/adjusted-series";
it("十分なValidation後だけ選択Testを開封し、別方式・再調整・数値改変を拒否する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lab-holdout-")),
    s = new Service(root, "demo", false),
    fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("external forbidden"));
  try {
    const input = await labFixture(s, 30, 10),
      p = await createLabPlan(s, input),
      m = await createLabMethod(s, {
        name: "holdout",
        hypothesis: "fixture only",
        parameters: labDefaultWeights,
        candidateThreshold: 80,
      });
    await changeLabState(s, m.experimentId, {
      status: "testing",
      reason: "confirmed",
      confirm: true,
    });
    const q = {
        experimentId: m.experimentId,
        planId: p.planId,
        stage: "validation",
        confirm: true,
      },
      run = await createLabRun(s, q);
    await runLabExperiment(s, run.runId);
    const report = await buildLabReport(s, run.runId);
    expect(report.sufficient).toBe(true);
    await changeLabState(s, m.experimentId, {
      status: "validated",
      reason: "separate validation",
      confirm: true,
    });
    await selectLabMethod(s, p.planId, m.experimentId, true);
    const test = await createLabRun(s, { ...q, stage: "test" });
    await runLabExperiment(s, test.runId);
    const final = await buildLabReport(s, test.runId);
    expect(final.stage).toBe("test");
    expect(final.comparisons.every((c) => c.candidateMeanDifference! < 0)).toBe(
      true,
    );
    expect((await createLabRun(s, { ...q, stage: "test" })).runId).toBe(
      test.runId,
    );
    await expect(createLabRun(s, { ...q, stage: "training" })).rejects.toThrow(
      "開封後",
    );
    await expect(createLabPlan(s, input)).rejects.toThrow("未使用Test");
    const other = await createLabMethod(s, {
      name: "adjusted after test",
      hypothesis: "new weights",
      parameters: { ...labDefaultWeights, rsi_recovery: 5 },
      candidateThreshold: 80,
    });
    await changeLabState(s, other.experimentId, {
      status: "testing",
      reason: "explicit",
      confirm: true,
    });
    await expect(
      createLabRun(s, {
        ...q,
        experimentId: other.experimentId,
        stage: "test",
      }),
    ).rejects.toThrow("封印");
    // Rehashing fabricated prose must still fail against regenerated numeric evidence.
    const { reportId, ...body } = final;
    void reportId;
    body.statements[0].text = "確実に100%上昇します";
    await s.store.write(`${labBase}/runs/${test.runId}/report/original.json`, {
      ...body,
      reportId: hash(body),
    });
    await expect(buildLabReport(s, test.runId)).rejects.toThrow("説明数値");
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
