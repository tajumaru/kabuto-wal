import type { Service } from "./service";
import { z } from "zod";
import { agentAttestationSchema,agentAttestationNetworkSchema,agentAttestationPayloadSchema } from "../../../packages/core/kabumaru-agent-attestation";
import { cohortIdSchema } from "../../../packages/core/hunter-cohort-schema";
import { readAgentResearchReport } from "./kabumaru-agent-evaluation";
import { labProvenance } from "./hunter-experiment-memory";
import { agentHash,agentBase } from "./kabumaru-agent-audit";
import type { AgentToolContext,AgentToolResult } from "./kabumaru-agent-tools";
export async function agentAttestation(s:Service,sessionId:string,network:unknown="local"){
 const target=agentAttestationNetworkSchema.parse(network),r=await readAgentResearchReport(s,sessionId),experimentManifestHashes=[];for(const e of r.experiments)experimentManifestHashes.push((await labProvenance(s,e.runId)).manifestHash);
 const payload=agentAttestationPayloadSchema.parse({schemaVersion:1,sessionId,planHash:r.planHash,experimentManifestHashes:experimentManifestHashes.sort(),resultHash:r.reportId,methodVersion:"kabumaru-agent-v1",createdAt:r.createdAt,validationVersion:"agent-walk-forward-v1",network:target}),manifestHash=agentHash(payload),record=agentAttestationSchema.parse({attestationId:agentHash(["agent-attestation-v1",manifestHash]),manifestHash,payload,algorithm:"sha256-canonical-json-v1",sendSupported:false,suiTransactions:0,transactionDigest:null,gasEstimate:null,chainVerified:false,note:"ローカルのhash生成・照合のみ。研究証跡の専用コントラクト、gas見積・署名内容・チェーン再照合を揃えたフローは未実装のため送信はできません。"});
 return s.store.lock(async()=>{const key=`${agentBase(sessionId)}/plans/${r.planId}/attestations/${record.attestationId}/original.json`,old=await s.store.read(key,null);if(old&&agentHash(agentAttestationSchema.parse(old))!==agentHash(record))throw Error("研究証跡とローカル原本が一致しません");if(!old)await s.store.write(key,record,true);return record;});
}
export async function verifyAgentAttestation(s:Service,sessionId:string,raw:unknown){const q=z.object({network:agentAttestationNetworkSchema,manifestHash:cohortIdSchema}).strict().parse(raw),expected=await agentAttestation(s,sessionId,q.network);return {network:q.network,localVerified:expected.manifestHash===q.manifestHash,chainVerified:false as const,expectedHash:expected.manifestHash,transactionDigest:null,sendSupported:false as const};}
export async function executeAgentAttestation(c:AgentToolContext):Promise<AgentToolResult>{await c.guard();const r=await agentAttestation(c.s,c.plan.sessionId,"local");return {status:"completed",output:{attestationId:r.attestationId,manifestHash:r.manifestHash,network:r.payload.network,sendSupported:false,suiTransactions:0},references:[r.attestationId,r.manifestHash]};}
