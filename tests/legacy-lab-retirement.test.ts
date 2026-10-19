import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { labFixture } from "../fixtures/lab";
import { createLabPlan, verifyLabPlanInputs, openLabTest } from "../apps/api/src/hunter-experiment-temporal";
import { createLabMethod, changeLabState, readLabPlan } from "../apps/api/src/hunter-experiment";
import { createLabRun, runLabExperiment, controlLabRun } from "../apps/api/src/hunter-experiment-runner";
import { buildLabReport, readLabReport, readLegacyLabReportHistory } from "../apps/api/src/hunter-experiment-report";
import { labDefaultWeights } from "../packages/core/hunter-experiment-method";
import { labPlanSchema, labPlanHistorySchema, labRunSchema, type LabPlan } from "../packages/core/hunter-experiment-schema";
import { hash } from "../packages/integrations/adjusted-series";
import { createApp } from "../apps/api/src/server";
import { labReportSchema } from "../packages/core/hunter-lab-report-schema";
import { createAgentSession } from "../apps/api/src/kabumaru-agent-audit";
import { proposeAgentPlan } from "../apps/api/src/kabumaru-agent-planner";

it("旧形式原本を保護しつつ新規作成・開始・再開・Test開封・新規完成報告を禁止する",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"legacy-retirement-")),s=new Service(root,"demo",false);
  try {
    const input=await labFixture(s,1),modern=await createLabPlan(s,input,new Date("2025-01-04T00:00:00Z"));
    expect(labPlanSchema.safeParse(modern).success).toBe(true);
    const hashes={...modern.evaluationHashes};hashes[modern.evaluationIds[0]]="0".repeat(64);
    const changed=labPlanSchema.parse({...modern,evaluationHashes:hashes}),{planId:unusedChanged,...changedBody}=changed;void unusedChanged;
    changed.planId=hash(changedBody);
    await s.store.write(`research/lab/plans/${changed.planId}/original.json`,changed,true);
    await expect(verifyLabPlanInputs(s,changed.planId)).rejects.toThrow("固定評価原本");
    const {planId:unused,evaluationHashes:unusedHashes,...body}=modern;void unused;void unusedHashes;
    const legacy={...body,planId:hash(body)},key=`research/lab/plans/${legacy.planId}/original.json`;
    expect(labPlanHistorySchema.safeParse(legacy).success).toBe(true);
    expect(labPlanSchema.safeParse(legacy).success).toBe(false);
    expect(labPlanSchema.safeParse({...modern,evaluationHashes:{}}).success).toBe(false);
    await expect(createLabPlan(s,legacy)).rejects.toThrow();
    await s.store.write(key,legacy,true);
    const m=await createLabMethod(s,{name:"test",hypothesis:"legacy fixture",parameters:labDefaultWeights,candidateThreshold:60});
    await changeLabState(s,m.experimentId,{status:"testing",reason:"test",confirm:true});
    const q={experimentId:m.experimentId,planId:legacy.planId,stage:"training" as const,confirm:true as const},inputHash=hash([legacy,m,legacy.evaluationIds]),runId=hash(["lab-run-v1",q,inputHash]),runKey=`research/lab/runs/${runId}/checkpoint.json`;
    const checkpoint=labRunSchema.parse({...q,runId,inputHash,createdAt:"2025-01-04T00:00:00Z",status:"paused",processed:0,failed:0,total:1});
    await s.store.write(runKey,checkpoint,true);
    await expect(verifyLabPlanInputs(s,legacy.planId)).rejects.toThrow("旧形式");
    await expect(createLabRun(s,q)).rejects.toThrow("旧形式");
    await expect(runLabExperiment(s,runId)).rejects.toThrow("旧形式");
    await expect(controlLabRun(s,runId,"resume")).rejects.toThrow("旧形式");
    await expect(openLabTest(s,legacy as LabPlan,m.experimentId)).rejects.toThrow("旧形式");
    const session=await createAgentSession(s,{objective:"旧形式を使わない"});
    await expect(proposeAgentPlan(s,session.sessionId,{foldPlanIds:[legacy.planId],methodIds:[m.experimentId],budget:{maxExperiments:1,maxCohorts:10,maxRuntimeSeconds:60,maxJQuantsRequests:0,maxExternalWrites:0,maxSuiTransactions:0}})).rejects.toThrow("旧形式");
    await s.store.write(runKey,{...checkpoint,status:"completed",processed:1});
    await expect(buildLabReport(s,runId)).rejects.toThrow("旧形式");
    expect(await readLabPlan(s,legacy.planId)).toEqual(legacy);
    expect(await s.store.read(key)).toEqual(legacy);
    expect(await s.store.files(`research/lab/runs/${runId}/report`)).toEqual([]);
  } finally {await rm(root,{recursive:true,force:true});}
});

it("保存済み旧形式レポートは履歴専用で読み、生成経路へ流さずJSONを変更しない",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"legacy-history-")),s=new Service(root,"demo",false),app=await createApp(s);
  try {
    const input=await labFixture(s,1),modern=await createLabPlan(s,input,new Date("2025-01-04T00:00:00Z"));
    const m=await createLabMethod(s,{name:"test",hypothesis:"history fixture",parameters:labDefaultWeights,candidateThreshold:60});
    await changeLabState(s,m.experimentId,{status:"testing",reason:"test",confirm:true});
    const run=await createLabRun(s,{experimentId:m.experimentId,planId:modern.planId,stage:"training",confirm:true});
    await runLabExperiment(s,run.runId);const report=await buildLabReport(s,run.runId);
    const {planId:unused,evaluationHashes:unusedHashes,...body}=modern;void unused;void unusedHashes;
    const legacy=labPlanHistorySchema.parse({...body,planId:hash(body)}),planKey=`research/lab/plans/${legacy.planId}/original.json`;
    await s.store.write(planKey,legacy,true);
    const q={experimentId:m.experimentId,planId:legacy.planId,stage:"training" as const,confirm:true as const},inputHash=hash([legacy,m,legacy.evaluationIds]),runId=hash(["lab-run-v1",q,inputHash]),runKey=`research/lab/runs/${runId}/checkpoint.json`,reportKey=`research/lab/runs/${runId}/report/original.json`;
    const checkpoint={...await s.store.read(`research/lab/runs/${run.runId}/checkpoint.json`),...q,runId,inputHash};
    await s.store.write(runKey,checkpoint,true);
    const normalized=labReportSchema.parse({...report,runId,planId:legacy.planId,inputHash}),{reportId:unusedReport,...content}=normalized;void unusedReport;
    const saved={...normalized,reportId:hash(content)};await s.store.write(reportKey,saved,true);
    expect(await readLegacyLabReportHistory(s,runId)).toEqual(saved);
    await expect(readLabReport(s,runId)).rejects.toThrow("旧形式");
    const list=await app.inject({method:"GET",url:"/api/research/lab/plans"});
    expect(list.json().records.find((p:{planId:string})=>p.planId===legacy.planId)).toMatchObject({legacy:true,executable:false});
    const detail=await app.inject({method:"GET",url:`/api/research/lab/runs/${runId}`});
    expect(detail.json()).toMatchObject({legacy:true,executable:false});
    const history=await app.inject({method:"GET",url:`/api/research/lab/runs/${runId}/report?view=compact`});
    expect(history.statusCode,history.body).toBe(200);expect(history.json()).toMatchObject({historyOnly:true});
    expect(history.json().historyWarning).toContain("旧形式・再実行不可");
    expect(await s.store.read(planKey)).toEqual(legacy);
    expect(await s.store.read(runKey)).toEqual(checkpoint);
    expect(await s.store.read(reportKey)).toEqual(saved);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});
