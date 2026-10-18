import { z } from "zod";
import { cohortIdSchema as id } from "./hunter-cohort-schema";
export const agentAttestationNetworkSchema=z.enum(["local","testnet","mainnet"]);
export const agentAttestationPayloadSchema=z.object({schemaVersion:z.literal(1),sessionId:id,planHash:id,experimentManifestHashes:z.array(id).max(30),resultHash:id,methodVersion:z.literal("kabumaru-agent-v1"),createdAt:z.string().datetime(),validationVersion:z.literal("agent-walk-forward-v1"),network:agentAttestationNetworkSchema}).strict();
export const agentAttestationSchema=z.object({attestationId:id,manifestHash:id,payload:agentAttestationPayloadSchema,algorithm:z.literal("sha256-canonical-json-v1"),sendSupported:z.literal(false),suiTransactions:z.literal(0),transactionDigest:z.null(),gasEstimate:z.null(),chainVerified:z.literal(false),note:z.string()}).strict();
