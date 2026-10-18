import type { Service } from "./service";
import {
  agentCheckpointSchema,
  agentArtifactSchema,
  type AgentPlan,
  type AgentCheckpoint,
} from "../../../packages/core/kabumaru-agent-schema";
import {
  agentBase,
  agentHash,
  agentState,
  appendAgentEvent,
  readAgentPlan,
} from "./kabumaru-agent-audit";
import { authorizeAgentExecution, readAgentApproval } from "./kabumaru-agent";
import { verifyAgentSources } from "./kabumaru-agent-planner";
import { assertAgentPermission } from "../../../packages/core/kabumaru-agent-policy";
import {
  runResearchJob,
  controlResearchJob,
  recoverResearchJob,
} from "./research-json-worker";
import { executeAgentTool, AgentToolError } from "./kabumaru-agent-tools";
import { controlLabRun } from "./hunter-experiment-runner";
export const agentCheckpointKey = (p: AgentPlan) =>
  `${agentBase(p.sessionId)}/plans/${p.planId}/checkpoint.json`;
export async function agentArtifacts(s: Service, p: AgentPlan) {
  const artifacts = [];
  for (const step of p.steps) {
    const raw = await s.store.read(
      `${agentBase(p.sessionId)}/plans/${p.planId}/steps/${step.stepId}/result/original.json`,
      null,
    );
    if (!raw) continue;
    const a = agentArtifactSchema.parse(raw),
      { artifactId, ...body } = a;
    if (
      a.sessionId !== p.sessionId ||
      a.planId !== p.planId ||
      a.stepId !== step.stepId ||
      a.inputHash !== step.inputHash ||
      a.tool !== step.tool ||
      agentHash(body) !== artifactId
    )
      throw Error("研究ステップ結果の根拠hash不一致");
    artifacts.push(a);
  }
  return artifacts;
}
export async function readAgentCheckpoint(s: Service, p: AgentPlan) {
  const j = agentCheckpointSchema.parse(
    await s.store.read(agentCheckpointKey(p)),
  );
  if (
    j.sessionId !== p.sessionId ||
    j.planId !== p.planId ||
    j.runId !== agentHash([p.sessionId, p.planId]) ||
    j.total !== p.steps.length
  )
    throw Error("研究checkpointの入力不一致");
  return j;
}
async function initialize(s: Service, p: AgentPlan) {
  return s.store.lock(async () => {
    const old = await s.store.read(agentCheckpointKey(p), null);
    if (old) return readAgentCheckpoint(s, p);
    const j = agentCheckpointSchema.parse({
      runId: agentHash([p.sessionId, p.planId]),
      sessionId: p.sessionId,
      planId: p.planId,
      status: "queued",
      processed: 0,
      total: p.steps.length,
      failed: 0,
      usage: {
        runtimeMs: 0,
        experiments: [],
        cohorts: [],
        jquantsRequests: 0,
        externalWrites: 0,
        suiTransactions: 0,
      },
      attempts: {},
      inFlight: null,
      childRunId: null,
    });
    await s.store.write(agentCheckpointKey(p), j, true);
    return j;
  });
}
function remaining(j: AgentCheckpoint, p: AgentPlan) {
  const elapsed = j.inFlight
    ? Math.max(0, Date.now() - Date.parse(j.inFlight.startedAt))
    : 0;
  return p.budget.maxRuntimeSeconds * 1000 - j.usage.runtimeMs - elapsed;
}
export async function recoverAgentExecution(s: Service, sessionId: string) {
  const state = await agentState(s, sessionId);
  if (!state.planId) return state;
  const p = await readAgentPlan(s, sessionId, state.planId),
    raw = await s.store.read(agentCheckpointKey(p), null);
  if (!raw) return state;
  const old = agentCheckpointSchema.parse(raw);
  await recoverResearchJob(s, agentCheckpointKey(p));
  const j = await readAgentCheckpoint(s, p);
  if (old.status === "running" && j.status === "paused")
    await s.store.lock(async () => {
      const current = await readAgentCheckpoint(s, p);
      if (current.inFlight) {
        const completed = (await agentArtifacts(s, p)).find(
          (a) => a.stepId === current.inFlight!.stepId,
        );
        current.usage.runtimeMs +=
          completed?.durationMs ??
          Math.max(0, Date.now() - Date.parse(current.inFlight.startedAt));
        current.inFlight = null;
        await s.store.write(agentCheckpointKey(p), current);
      }
      const st = await agentState(s, sessionId);
      if (st.status === "running")
        await appendAgentEvent(s, sessionId, {
          kind: "recovered",
          status: "paused",
          planId: p.planId,
          reason:
            "異常終了を検出。未精算時間は保守的に累積し、明示再開まで停止。",
          references: [],
        });
    });
  return agentState(s, sessionId);
}
export async function runAgentSession(
  s: Service,
  sessionId: string,
  maxSteps = Infinity,
) {
  await recoverAgentExecution(s, sessionId);
  const { state, plan: p } = await authorizeAgentExecution(s, sessionId);
  if (state.status === "completed") return readAgentCheckpoint(s, p);
  if (state.status === "failed")
    throw Error("恒久失敗のため新しい計画・承認が必要です");
  let j = await initialize(s, p);
  if (j.status === "running")
    throw new AgentToolError("研究エージェントが既に実行中です", true);
  if (j.status === "cancelled") throw Error("キャンセル済み計画です");
  if (remaining(j, p) <= 0) throw Error("実行時間の累積予算を使い切っています");
  if (j.status === "paused")
    await controlResearchJob(s, agentCheckpointKey(p), "resume");
  await s.store.lock(async () => {
    const st = await agentState(s, sessionId);
    if (st.status !== "running")
      await appendAgentEvent(s, sessionId, {
        kind: "status",
        status: "running",
        planId: p.planId,
        reason: "承認hash・固定根拠・予算を再照合して開始",
        references: [],
      });
  });
  let retryable = false;
  try {
    j = agentCheckpointSchema.parse(
      await runResearchJob(
        s,
        agentCheckpointKey(p),
        async (index) => {
          const step = p.steps[index],
            existing = await agentArtifacts(s, p);
          if (existing.some((a) => a.stepId === step.stepId)) return;
          if (
            step.dependencies.some((d) => !existing.some((a) => a.stepId === d))
          )
            throw new AgentToolError("依存ステップが未完了です");
          const approval = await readAgentApproval(s, p);
          assertAgentPermission(p, approval, step.tool);
          await s.store.lock(async () => {
            const current = await readAgentCheckpoint(s, p);
            if (remaining(current, p) <= 0)
              throw new AgentToolError(
                "累積実行時間予算を超えるため停止します",
              );
            if ((current.retries[step.stepId] ?? 0) >= step.maxAttempts)
              throw new AgentToolError("再試行上限です");
            if (p.cohortIds.length > p.budget.maxCohorts)
              throw new AgentToolError("コホート予算超過");
            current.usage.cohorts = p.cohortIds;
            current.attempts[step.stepId] =
              (current.attempts[step.stepId] ?? 0) + 1;
            current.inFlight = {
              stepId: step.stepId,
              startedAt: new Date().toISOString(),
            };
            await s.store.write(agentCheckpointKey(p), current);
            await appendAgentEvent(s, sessionId, {
              kind: "attempt-started",
              planId: p.planId,
              stepId: step.stepId,
              reason: "権限・残予算を確認し、試行を予約",
              references: [],
              details: {
                attempt: current.attempts[step.stepId],
                runtimeMs: current.usage.runtimeMs,
              },
            });
          });
          const guard = async () => {
            const current = await readAgentCheckpoint(s, p);
            if (current.status !== "running")
              throw new AgentToolError(
                "利用者が中断・キャンセルしました",
                true,
              );
            if (remaining(current, p) <= 0)
              throw new AgentToolError("実行時間予算に達しました");
          };
          const chargeExperiment = async (key: string) =>
            s.store.lock(async () => {
              const current = await readAgentCheckpoint(s, p);
              if (current.usage.experiments.includes(key)) return;
              if (current.usage.experiments.length >= p.budget.maxExperiments)
                throw new AgentToolError("実験回数予算超過");
              current.usage.experiments.push(key);
              await s.store.write(agentCheckpointKey(p), current);
            });
          const setChild = async (id: string | null) =>
            s.store.lock(async () => {
              const current = await readAgentCheckpoint(s, p);
              current.childRunId = id;
              await s.store.write(agentCheckpointKey(p), current);
            });
          try {
            await verifyAgentSources(s, p);
            const result = await executeAgentTool({
              s,
              plan: p,
              step,
              artifacts: existing,
              guard,
              chargeExperiment,
              setChild,
            });
            await guard();
            const current = await readAgentCheckpoint(s, p),
              durationMs = Math.max(
                0,
                Date.now() - Date.parse(current.inFlight!.startedAt),
              ),
              a = agentArtifactSchema.parse({
                ...result,
                artifactId: "0".repeat(64),
                sessionId,
                planId: p.planId,
                stepId: step.stepId,
                inputHash: step.inputHash,
                tool: step.tool,
                createdAt: new Date().toISOString(),
                durationMs,
              }),
              { artifactId: placeholder, ...body } = a;
            void placeholder;
            a.artifactId = agentHash(body);
            if (JSON.stringify(a).length > 2_000_000)
              throw new AgentToolError("ステップ出力上限です");
            await s.store.lock(async () => {
              const cp = await readAgentCheckpoint(s, p);
              if (cp.status !== "running")
                throw new AgentToolError(
                  "利用者が中断・キャンセルしました",
                  true,
                );
              await s.store.write(
                `${agentBase(sessionId)}/plans/${p.planId}/steps/${step.stepId}/result/original.json`,
                a,
                true,
              );
              cp.usage.runtimeMs += durationMs;
              cp.inFlight = null;
              cp.childRunId = null;
              await s.store.write(agentCheckpointKey(p), cp);
              await appendAgentEvent(s, sessionId, {
                kind: "step-completed",
                planId: p.planId,
                stepId: step.stepId,
                reason:
                  result.status === "skipped"
                    ? "データ不足等で実験を行わずスキップ（理由を保存）"
                    : "ステップ結果と根拠を不変保存",
                references: [a.artifactId],
                details: { resultStatus: result.status, durationMs },
              });
            });
          } catch (error) {
            retryable = error instanceof AgentToolError && error.retryable;
            await s.store.lock(async () => {
              const cp = await readAgentCheckpoint(s, p);
              if (cp.inFlight)
                cp.usage.runtimeMs += Math.max(
                  0,
                  Date.now() - Date.parse(cp.inFlight.startedAt),
                );
              cp.inFlight = null;
              if (cp.status === "running")
                cp.retries[step.stepId] = (cp.retries[step.stepId] ?? 0) + 1;
              await s.store.write(agentCheckpointKey(p), cp);
              await appendAgentEvent(s, sessionId, {
                kind: "step-failed",
                planId: p.planId,
                stepId: step.stepId,
                reason: error instanceof Error ? error.message : "処理失敗",
                references: [],
                details: { retryable, attempt: cp.attempts[step.stepId] ?? 0 },
              });
            });
            throw error;
          }
        },
        maxSteps,
        { activeKey: "research/agent/active-coordinator.json" },
      ),
    );
  } catch (error) {
    retryable = error instanceof Error && error.message.includes("既に");
    await s.store.lock(async () => {
      const cp = await readAgentCheckpoint(s, p);
      if (cp.status === "queued") {
        cp.status = "paused";
        cp.error = "別のエージェントworkerが実行中です。";
        await s.store.write(agentCheckpointKey(p), cp);
      }
    });
    if (!retryable) throw error;
    // A competing invocation must never change the live owner's state.
    const live = await readAgentCheckpoint(s, p);
    if (live.status === "running") return live;
  }
  return s.store.lock(async () => {
    const cp = await readAgentCheckpoint(s, p);
    if (cp.status === "failed" && retryable) {
      cp.status = "paused";
      await s.store.write(agentCheckpointKey(p), cp);
    }
    const st = await agentState(s, sessionId),
      status =
        cp.status === "completed"
          ? "completed"
          : cp.status === "cancelled"
            ? "cancelled"
            : cp.status === "failed"
              ? "failed"
              : "paused";
    if (st.status !== status)
      await appendAgentEvent(s, sessionId, {
        kind: "status",
        status,
        planId: p.planId,
        reason: cp.error ?? `研究は${status}です`,
        references: [],
      });
    return cp;
  });
}
export async function controlAgentSession(
  s: Service,
  sessionId: string,
  action: "pause" | "cancel" | "resume",
) {
  await recoverAgentExecution(s, sessionId);
  const { plan: p, state } = await authorizeAgentExecution(s, sessionId);
  if (state.status === "failed")
    throw Error("恒久失敗は新しい計画・承認が必要です");
  const cp = await readAgentCheckpoint(s, p);
  if (cp.childRunId && action !== "resume")
    await controlLabRun(s, cp.childRunId, action);
  const j = await controlResearchJob(s, agentCheckpointKey(p), action);
  if (action !== "resume")
    await s.store.lock(async () => {
      const current = await agentState(s, sessionId),
        status = action === "cancel" ? "cancelled" : "paused";
      if (current.status !== status)
        await appendAgentEvent(s, sessionId, {
          kind: "control",
          status,
          planId: p.planId,
          reason: "利用者の明示操作を子実験へ伝播",
          references: [],
        });
    });
  return j;
}
