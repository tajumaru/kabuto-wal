import type { Service } from "./service";
import type { AgentPlan,AgentArtifact } from "../../../packages/core/kabumaru-agent-schema";
import { readNotebook } from "./kabumaru-notebook";
import { notebookInsights } from "./kabumaru-notebook-insights";
import { generateLabHypothesis } from "./hunter-experiment-hypotheses";
import { agentBase,agentHash } from "./kabumaru-agent-audit";
export class AgentToolError extends Error{constructor(message:string,public retryable=false){super(message);}}
export type AgentToolContext={s:Service;plan:AgentPlan;step:AgentPlan["steps"][number];artifacts:AgentArtifact[];guard:()=>Promise<void>;chargeExperiment:(key:string)=>Promise<void>;setChild:(id:string|null)=>Promise<void>;};
export type AgentToolResult={status:"completed"|"skipped";output:Record<string,unknown>;references:string[]};
// Closed switch: no HTTP client, approval API, SDK signer, shell, or dynamic code tool.
export async function executeAgentTool(c:AgentToolContext):Promise<AgentToolResult>{const {s,plan:p,step}=c;await c.guard();switch(step.tool){
 case "inspect-notebooks":{const notes=[];for(const id of p.notebookIds){await c.guard();const n=await readNotebook(s,id);notes.push({notebookId:id,theme:n.theme,statements:notebookInsights(n).statements.slice(0,10),evidenceIds:n.evidence.map(e=>e.evidenceId)});}return {status:"completed",output:{notes,missing:!notes.length,warning:"不足した特徴量やデジャヴ類似度を推測しません。"},references:p.evidenceIds};}
 case "propose-hypothesis":{const proposals=[];for(const labPlanId of p.foldPlanIds){if(!p.notebookIds.length)continue;await c.guard();const q=await generateLabHypothesis(s,{planId:labPlanId,notebookIds:p.notebookIds});proposals.push({proposalId:q.proposalId,planId:labPlanId,parameters:q.proposal.parameters,evidenceIds:q.proposal.evidenceIds});}return {status:proposals.length?"completed":"skipped",output:{proposals,reason:proposals.length?"Training限定の探索仮説。承認済み方式を書き換えません。":"Training根拠または検証計画が不足しています。"},references:proposals.map(r=>r.proposalId)};}
 case "compare-folds":case "run-validation":case "select-final-method":case "run-final-test":return (await import("./kabumaru-agent-walk-forward")).executeAgentExperimentTool(c);
 case "evaluate-research":return (await import("./kabumaru-agent-evaluation")).executeAgentEvaluation(c);
 case "save-local-memory":{const body={sessionId:p.sessionId,planId:p.planId,objective:p.objective,hypothesis:p.hypothesis,sourceHashes:p.sourceHashes,artifacts:c.artifacts.map(a=>({artifactId:a.artifactId,stepId:a.stepId,status:a.status,references:a.references})),externalConsent:false},recordId=agentHash(body),key=`${agentBase(p.sessionId)}/plans/${p.planId}/local-results/${recordId}/original.json`;await s.store.lock(async()=>{if(!await s.store.read(key,null))await s.store.write(key,{...body,recordId},true);});return {status:"completed",output:{recordId,externalWrites:0},references:[recordId]};}
 case "local-attestation":return {status:"completed",output:{manifestHash:agentHash([p,c.artifacts.map(a=>a.artifactId)]),sendSupported:false,suiTransactions:0},references:[p.planId]};
 }}
