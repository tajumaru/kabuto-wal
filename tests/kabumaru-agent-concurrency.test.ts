import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import {
  createAgentSession,
  agentHash,
  agentState,
} from "../apps/api/src/kabumaru-agent-audit";
import {
  proposeAgentPlan,
  verifyAgentSources,
} from "../apps/api/src/kabumaru-agent-planner";
import { approveAgentPlan } from "../apps/api/src/kabumaru-agent";
import { agentToolPermissions } from "../packages/core/kabumaru-agent-policy";
import {
  runAgentSession,
  readAgentCheckpoint,
  agentCheckpointKey,
  controlAgentSession,
  recoverAgentExecution,
  agentArtifacts,
} from "../apps/api/src/kabumaru-agent-runner";
import * as tools from "../apps/api/src/kabumaru-agent-tools";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-concurrency-")),
    s = new Service(root, "demo", false),
    session = await createAgentSession(s, { objective: "中断と復旧" }),
    plan = await proposeAgentPlan(s, session.sessionId, {
      budget: {
        maxExperiments: 0,
        maxCohorts: 0,
        maxRuntimeSeconds: 60,
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
  return { root, s, session, plan };
}
it("同時開始は先行workerの状態を変更せず、キャンセル後の結果を成功保存しない", async () => {
  const { root, s, session, plan } = await fixture(),
    original = tools.executeAgentTool;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const spy = vi
    .spyOn(tools, "executeAgentTool")
    .mockImplementation(async (ctx) => {
      entered();
      await gate;
      return original(ctx);
    });
  try {
    const running = runAgentSession(s, session.sessionId);
    await started;
    await expect(runAgentSession(s, session.sessionId)).rejects.toThrow("既に");
    expect((await agentState(s, session.sessionId)).status).toBe("running");
    await controlAgentSession(s, session.sessionId, "cancel");
    release();
    expect((await running).status).toBe("cancelled");
    expect(await agentArtifacts(s, plan)).toHaveLength(0);
    expect((await agentState(s, session.sessionId)).status).toBe("cancelled");
  } finally {
    release();
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
it("利用者の一時停止は失敗予算を消費せず、異常終了時の未精算時間を復旧する", async () => {
  const { root, s, session, plan } = await fixture(),
    original = tools.executeAgentTool;
  try {
    for (let i = 0; i < 3; i++) {
      const spy = vi
        .spyOn(tools, "executeAgentTool")
        .mockImplementationOnce(async (ctx) => {
          await controlAgentSession(s, session.sessionId, "pause");
          await ctx.guard();
          return original(ctx);
        });
      expect((await runAgentSession(s, session.sessionId)).status).toBe(
        "paused",
      );
      spy.mockRestore();
    }
    const cp = await readAgentCheckpoint(s, plan);
    expect(cp.attempts[plan.steps[0].stepId]).toBe(3);
    expect(cp.retries[plan.steps[0].stepId] ?? 0).toBe(0);
    await s.store.write(agentCheckpointKey(plan), {
      ...cp,
      status: "running",
      lease: { token: crypto.randomUUID(), pid: process.pid, expiresAt: 0 },
      inFlight: {
        stepId: plan.steps[0].stepId,
        startedAt: new Date(Date.now() - 100).toISOString(),
      },
    });
    await recoverAgentExecution(s, session.sessionId);
    const recovered = await readAgentCheckpoint(s, plan);
    expect(recovered.status).toBe("paused");
    expect(recovered.usage.runtimeMs).toBeGreaterThanOrEqual(
      cp.usage.runtimeMs + 100,
    );
    expect(recovered.inFlight).toBeNull();
    await verifyAgentSources(s, plan);
    expect((await runAgentSession(s, session.sessionId)).status).toBe(
      "completed",
    );
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
it("一時的失敗を成功として保存せず、再試行上限を再開後も強制する", async () => {
  const { root, s, session, plan } = await fixture(),
    spy = vi
      .spyOn(tools, "executeAgentTool")
      .mockRejectedValue(new tools.AgentToolError("一時的なfixture障害", true));
  try {
    expect((await runAgentSession(s, session.sessionId)).status).toBe("paused");
    expect((await runAgentSession(s, session.sessionId)).status).toBe("paused");
    const failed = await runAgentSession(s, session.sessionId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("再試行上限");
    expect(await agentArtifacts(s, plan)).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
