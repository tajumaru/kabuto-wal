import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { saveAgentMemory,syncAgentMemory,recallAgentMemory,agentNamespace } from "../apps/api/src/kabumaru-agent-memory";
import { agentAttestation,verifyAgentAttestation } from "../apps/api/src/kabumaru-agent-attestation";
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
it("MemWalは初期OFFで、別操作のSDKモック同期・原本照合・削除抑止を維持する",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"agent-memory-")),s=new Service(root,"research",false),texts:string[]=[];const provider={remember:vi.fn(async(text:string)=>{texts.push(text);return {job_id:"agent-job"};}),waitForRememberJob:vi.fn(async()=>({blob_id:"agent-blob",namespace:agentNamespace("research")})),recall:vi.fn(async()=>({results:texts.map(text=>({text,distance:0}))}))};vi.spyOn(s,"memoryProvider").mockResolvedValue(provider);try{const {session}=await approvedReadSession(s);expect((await runAgentSession(s,session.sessionId)).status).toBe("completed");const memory=await saveAgentMemory(s,session.sessionId);expect(provider.remember).not.toHaveBeenCalled();vi.stubEnv("ALLOW_MARKET_DATA_TO_MEMWAL","false");vi.stubEnv("JQUANTS_MEMWAL_RIGHTS_CONFIRMED","true");await expect(syncAgentMemory(s,session.sessionId,true)).rejects.toThrow("明示許可");vi.stubEnv("ALLOW_MARKET_DATA_TO_MEMWAL","true");await syncAgentMemory(s,session.sessionId,true);expect(provider.remember).toHaveBeenCalledTimes(1);expect(texts[0]).not.toContain("sourceRevisionHashes");expect((await recallAgentMemory(s,session.sessionId,true)).records).toHaveLength(1);await s.store.write(`sync/${memory.recordId}.json`,{status:"deleted",directWalrusDeletion:true});expect((await saveAgentMemory(s,session.sessionId)).status).toBe("suppressed");expect((await recallAgentMemory(s,session.sessionId,true)).records).toHaveLength(0);await expect(syncAgentMemory(s,session.sessionId,true)).rejects.toThrow("削除");expect(provider.remember).toHaveBeenCalledTimes(1);}finally{vi.unstubAllEnvs();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}});
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
    const mainnet=await agentAttestation(s,session.sessionId,"mainnet"),testnet=await agentAttestation(s,session.sessionId,"testnet");expect(mainnet.manifestHash).not.toBe(testnet.manifestHash);expect(mainnet.sendSupported).toBe(false);expect(mainnet.transactionDigest).toBeNull();expect((await verifyAgentAttestation(s,session.sessionId,{network:"testnet",manifestHash:mainnet.manifestHash})).localVerified).toBe(false);expect((await verifyAgentAttestation(s,session.sessionId,{network:"mainnet",manifestHash:mainnet.manifestHash})).localVerified).toBe(true);
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
