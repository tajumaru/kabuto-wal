import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { agentFoldFixture } from "../fixtures/agent";
import { createLabMethod } from "../apps/api/src/hunter-experiment";
import { labDefaultWeights } from "../packages/core/hunter-experiment-method";
import {
  createAgentSession,
  agentHash,
} from "../apps/api/src/kabumaru-agent-audit";
import { proposeAgentPlan } from "../apps/api/src/kabumaru-agent-planner";
import { approveAgentPlan } from "../apps/api/src/kabumaru-agent";
import { agentToolPermissions } from "../packages/core/kabumaru-agent-policy";
import {
  runAgentSession,
  agentArtifacts,
} from "../apps/api/src/kabumaru-agent-runner";
import { agentFoldComparisonSchema } from "../packages/core/kabumaru-agent-walk-forward";
import { readLabReport } from "../apps/api/src/hunter-experiment-report";
import { readAgentResearchReport } from "../apps/api/src/kabumaru-agent-evaluation";
it("全fold選択後にだけ共通Testを開封し、悪い最終成績も原本に残す", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-folds-")),
    s = new Service(root, "demo", false),
    network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("external forbidden"));
  try {
    const f = await agentFoldFixture(s),
      m = await createLabMethod(s, {
        name: "fixed high threshold",
        hypothesis: "fixture research only",
        parameters: labDefaultWeights,
        candidateThreshold: 80,
      }),
      session = await createAgentSession(s, {
        objective: "方式の期間安定性を調べる",
      }),
      plan = await proposeAgentPlan(s, session.sessionId, {
        foldPlanIds: f.foldPlanIds,
        methodIds: [m.experimentId],
        budget: {
          maxExperiments: 3,
          maxCohorts: 100,
          maxRuntimeSeconds: 300,
          maxJQuantsRequests: 0,
          maxExternalWrites: 0,
          maxSuiTransactions: 0,
        },
      });
    await approveAgentPlan(s, session.sessionId, {
      planId: plan.planId,
      planHash: agentHash(plan),
      confirm: true,
      allowedTools: [...new Set(plan.steps.map((s) => s.tool))],
      permissions: [
        ...new Set(plan.steps.map((s) => agentToolPermissions[s.tool])),
      ],
      budget: plan.budget,
      failurePolicy: "pause-transient-stop-permanent-v1",
    });
    const j = await runAgentSession(s, session.sessionId);
    expect(j.status, j.error).toBe("completed");
    expect(j.usage.experiments).toHaveLength(3);
    const artifacts = await agentArtifacts(s, plan),
      comparison = agentFoldComparisonSchema.parse(
        artifacts.find((a) => a.tool === "compare-folds")?.output,
      );
    expect(comparison.sufficient).toBe(true);
    expect(comparison.folds).toHaveLength(2);
    expect(comparison.selectedMethodId).toBe(m.experimentId);
    const test = artifacts.find((a) => a.tool === "run-final-test")!;
    const evaluation=await readAgentResearchReport(s,session.sessionId);
    expect(evaluation.classification).toBe("mixed");
    expect(evaluation.experiments).toHaveLength(3);
    expect(evaluation.statements[0].evidenceIds).toEqual(evaluation.evidenceIds);
    expect(test.status).toBe("completed");
    const r = await readLabReport(s, String(test.output.runId));
    expect(r.comparisons.every((c) => c.candidateMeanDifference! < 0)).toBe(
      true,
    );
    await expect(
      proposeAgentPlan(
        s,
        (await createAgentSession(s, { objective: "reuse" })).sessionId,
        {
          foldPlanIds: f.foldPlanIds,
          methodIds: [m.experimentId],
          budget: plan.budget,
        },
      ),
    ).rejects.toThrow("未使用Test");
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
},240000);
