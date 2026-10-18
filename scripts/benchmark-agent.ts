import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createNotebook } from "../apps/api/src/kabumaru-notebook";
// Isolated synthetic fixture only. Approval below is a benchmark harness, never an agent tool.
const root = await mkdtemp(path.join(os.tmpdir(), "agent-benchmark-")),
  s = new Service(root, "demo", false),
  originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error("benchmark external access forbidden");
};
let peakRss = process.memoryUsage().rss,
  checkpointWrites = 0,
  firstAttempt = 0;
const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20),
  write = s.store.write.bind(s.store);
s.store.write = async (key, data, immutable) => {
  if (key.endsWith("/checkpoint.json")) checkpointWrites++;
  if (
    !firstAttempt &&
    key.includes("/agent/") &&
    key.includes("/events/") &&
    JSON.stringify(data).includes('"kind":"attempt-started"')
  )
    firstAttempt = performance.now();
  return write(key, data, immutable);
};
try {
  const f = await agentFoldFixture(s, 5, 30),
    m = await createLabMethod(s, {
      name: "benchmark fixture method",
      hypothesis: "synthetic only",
      parameters: labDefaultWeights,
      candidateThreshold: 80,
    }),
    session = await createAgentSession(s, {
      objective: "5fold人工データの実行計測",
    });
  const planningStart = performance.now(),
    plan = await proposeAgentPlan(s, session.sessionId, {
      foldPlanIds: f.foldPlanIds,
      methodIds: [m.experimentId],
      budget: {
        maxExperiments: 6,
        maxCohorts: 100,
        maxRuntimeSeconds: 600,
        maxJQuantsRequests: 0,
        maxExternalWrites: 0,
        maxSuiTransactions: 0,
      },
    }),
    planningMs = performance.now() - planningStart;
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
  const rssBeforeRun = process.memoryUsage().rss;
  checkpointWrites = 0;
  const start = performance.now(),
    job = await runAgentSession(s, session.sessionId),
    runMs = performance.now() - start;
  if (job.status !== "completed") throw Error(job.error ?? job.status);
  const artifacts = await agentArtifacts(s, plan),
    foldMs = artifacts
      .filter((a) => a.tool === "run-validation")
      .map((a) => ({ stepId: a.stepId, durationMs: a.durationMs })),
    notebookStart = performance.now();
  await createNotebook(s, {
    theme: "high-score-failure",
    cohortIds: f.cohortIds,
    hypothesis: "人工市場の記述的失敗分析（判定入力には戻さない）",
  });
  const result = {
    fixture:
      "synthetic 30 symbols, 31 fixed cohorts, 5 validation folds; 4 independent validation dates/fold => insufficient; final Test stays sealed",
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    planningMs: +planningMs.toFixed(2),
    startToFirstAttemptMs: +(firstAttempt - start).toFixed(2),
    foldMs,
    fiveFoldTotalMs: foldMs.reduce((sum, f) => sum + f.durationMs, 0),
    completeRunMs: +runMs.toFixed(2),
    notebookGenerationMs: +(performance.now() - notebookStart).toFixed(2),
    checkpointWrites,
    rssBeforeRunBytes: rssBeforeRun,
    peakRssBytes: peakRss,
    experiments: job.usage.experiments.length,
    budgetRuntimeMs: job.usage.runtimeMs,
    unmeasured: [
      "real market",
      "full-market large-cohort processing",
      "physical iPhone Safari",
    ],
    externalRequests: 0,
  };
  await writeFile(
    "docs/agent-performance.json",
    JSON.stringify(result, null, 2),
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  clearInterval(timer);
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
