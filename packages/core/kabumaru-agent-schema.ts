import { z } from "zod";
import { cohortIdSchema as id } from "./hunter-cohort-schema";
export const AGENT_VERSION = "kabumaru-agent-v1";
export const agentStatusSchema = z.enum([
  "draft",
  "awaiting-approval",
  "approved",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export const agentPermissionSchema = z.enum([
  "ReadResearch",
  "ProposeExperiment",
  "RunApprovedExperiment",
  "SaveLocalMemory",
  "RequestExternalSync",
  "RequestSuiAttestation",
]);
export const agentToolSchema = z.enum([
  "inspect-notebooks",
  "propose-hypothesis",
  "run-validation",
  "compare-folds",
  "select-final-method",
  "run-final-test",
  "evaluate-research",
  "save-local-memory",
  "local-attestation",
]);
export const agentBudgetSchema = z
  .object({
    maxExperiments: z.number().int().min(0).max(30),
    maxCohorts: z.number().int().min(0).max(100),
    maxRuntimeSeconds: z.number().int().min(1).max(3600),
    maxJQuantsRequests: z.literal(0),
    maxExternalWrites: z.literal(0),
    maxSuiTransactions: z.literal(0),
  })
  .strict();
export const agentSessionInputSchema = z
  .object({
    objective: z.string().min(1).max(1000),
    topic: z
      .enum([
        "high-score-failure",
        "volume-reversal",
        "rsi-recovery",
        "dejavu-similarity",
        "candidate-control",
        "market-regimes",
        "method-stability",
        "missing-data",
      ])
      .default("method-stability"),
  })
  .strict();
export const agentSessionSchema = agentSessionInputSchema
  .extend({
    schemaVersion: z.literal(1),
    sessionId: id,
    mode: z.enum(["demo", "research"]),
    createdAt: z.string().datetime(),
    methodVersion: z.literal(AGENT_VERSION),
  })
  .strict();
export const agentStepSchema = z
  .object({
    stepId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    tool: agentToolSchema,
    input: z
      .object({
        labPlanId: id.optional(),
        methodId: id.optional(),
        foldIndex: z.number().int().min(0).max(4).optional(),
      })
      .strict(),
    inputHash: id,
    dependencies: z.array(z.string()).max(100),
    maxAttempts: z.number().int().min(1).max(3).default(2),
  })
  .strict();
export const agentPlanInputSchema = z
  .object({
    notebookIds: z.array(id).max(20).default([]),
    foldPlanIds: z.array(id).max(5).default([]),
    methodIds: z.array(id).max(5).default([]),
    budget: agentBudgetSchema,
  })
  .strict();
export const agentPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: id,
    sessionId: id,
    version: z.number().int().positive(),
    previousPlanId: id.nullable(),
    requestId: z.string().uuid().optional(),
    requestHash: id.optional(),
    hypothesis: z.string().max(2000),
    objective: z.string(),
    topic: agentSessionInputSchema.shape.topic,
    evidenceIds: z.array(id).max(1000),
    notebookIds: z.array(id).max(20),
    cohortIds: z.array(id).max(100),
    methodIds: z.array(id).max(5),
    foldPlanIds: z.array(id).max(5),
    sourceHashes: z.record(z.string(), id),
    cutoff: z.string().datetime(),
    steps: z.array(agentStepSchema).min(1).max(100),
    budget: agentBudgetSchema,
    createdAt: z.string().datetime(),
    methodVersion: z.literal(AGENT_VERSION),
    warnings: z.array(z.string()).max(30),
  })
  .strict();
export const agentApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvalId: id,
    sessionId: id,
    planId: id,
    planHash: id,
    approvedAt: z.string().datetime(),
    allowedTools: z.array(agentToolSchema),
    permissions: z.array(agentPermissionSchema),
    budget: agentBudgetSchema,
    actor: z.enum(["authenticated-user", "demo-user"]),
    failurePolicy: z.literal("pause-transient-stop-permanent-v1"),
  })
  .strict();
export const agentUsageSchema = z
  .object({
    runtimeMs: z.number().finite().nonnegative(),
    experiments: z.array(z.string()).max(30),
    cohorts: z.array(id).max(100),
    jquantsRequests: z.literal(0),
    externalWrites: z.literal(0),
    suiTransactions: z.literal(0),
  })
  .strict();
export const agentCheckpointSchema = z
  .object({
    runId: id,
    sessionId: id,
    planId: id,
    status: z.enum([
      "queued",
      "running",
      "paused",
      "cancelled",
      "failed",
      "completed",
    ]),
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    error: z.string().optional(),
    lease: z
      .object({
        token: z.string().uuid(),
        pid: z.number(),
        expiresAt: z.number(),
      })
      .optional(),
    usage: agentUsageSchema,
    attempts: z.record(z.string(), z.number().int().nonnegative()),
    retries: z.record(z.string(), z.number().int().nonnegative()).default({}),
    inFlight: z
      .object({ stepId: z.string(), startedAt: z.string().datetime() })
      .nullable(),
    childRunId: id.nullable(),
  })
  .strict();
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type AgentApproval = z.infer<typeof agentApprovalSchema>;
export type AgentCheckpoint = z.infer<typeof agentCheckpointSchema>;
export type AgentTool = z.infer<typeof agentToolSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export const agentArtifactSchema = z
  .object({
    artifactId: id,
    sessionId: id,
    planId: id,
    stepId: z.string(),
    inputHash: id,
    tool: agentToolSchema,
    status: z.enum(["completed", "skipped"]),
    createdAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    references: z.array(id).max(1000),
    output: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AgentArtifact = z.infer<typeof agentArtifactSchema>;
