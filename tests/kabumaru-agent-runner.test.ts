import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import {
  createAgentSession,
  agentHash,
  agentState,
  agentEvents,
} from "../apps/api/src/kabumaru-agent-audit";
import { proposeAgentPlan } from "../apps/api/src/kabumaru-agent-planner";
import { approveAgentPlan } from "../apps/api/src/kabumaru-agent";
import { agentToolPermissions } from "../packages/core/kabumaru-agent-policy";
import {
  runAgentSession,
  agentArtifacts,
  agentCheckpointKey,
} from "../apps/api/src/kabumaru-agent-runner";
export async function approvedReadSession(s: Service, maxRuntimeSeconds = 30) {
  const session = await createAgentSession(s, {
      objective: "保存済み研究の不足を確認",
    }),
    plan = await proposeAgentPlan(s, session.sessionId, {
      budget: {
        maxExperiments: 0,
        maxCohorts: 0,
        maxRuntimeSeconds,
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
  return { session, plan };
}
it("承認済み研究を一段ずつ再開し、累積予算・冪等結果・監査履歴を維持する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-run-")),
    s = new Service(root, "demo", false),
    network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("external forbidden"));
  try {
    const { session, plan } = await approvedReadSession(s);
    const paused = await runAgentSession(s, session.sessionId, 1);
    expect(paused.status).toBe("paused");
    expect(paused.processed).toBe(1);
    const complete = await runAgentSession(s, session.sessionId);
    expect(complete.status, complete.error).toBe("completed");
    expect(complete.usage.runtimeMs).toBeGreaterThanOrEqual(
      paused.usage.runtimeMs,
    );
    expect(complete.usage.experiments).toHaveLength(0);
    expect(
      (await agentArtifacts(s, plan)).find(
        (a) => a.tool === "evaluate-research",
      )?.output.classification,
    ).toBe("insufficient-data");
    expect((await runAgentSession(s, session.sessionId)).usage).toEqual(
      complete.usage,
    );
    expect((await agentState(s, session.sessionId)).status).toBe("completed");
    expect(
      (await agentEvents(s, session.sessionId)).filter(
        (e) => e.kind === "step-completed",
      ),
    ).toHaveLength(plan.steps.length);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
it("再開しても消費した時間予算をリセットできない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-budget-")),
    s = new Service(root, "demo", false);
  try {
    const { session, plan } = await approvedReadSession(s, 1);
    await runAgentSession(s, session.sessionId, 0);
    const cp = await s.store.read(agentCheckpointKey(plan));
    await s.store.write(agentCheckpointKey(plan), {
      ...cp,
      usage: { ...cp.usage, runtimeMs: 1000 },
    });
    await expect(runAgentSession(s, session.sessionId)).rejects.toThrow(
      "累積予算",
    );
    expect((await agentState(s, session.sessionId)).status).toBe("paused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
