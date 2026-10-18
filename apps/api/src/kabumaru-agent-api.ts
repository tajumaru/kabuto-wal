import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Service } from "./service";
import {
  agentSessionInputSchema,
  agentPlanInputSchema,
  agentToolSchema,
} from "../../../packages/core/kabumaru-agent-schema";
import {
  agentToolPermissions,
  agentForbiddenActions,
} from "../../../packages/core/kabumaru-agent-policy";
import { cohortIdSchema as id } from "../../../packages/core/hunter-cohort-schema";
import { agentAttestationNetworkSchema } from "../../../packages/core/kabumaru-agent-attestation";
import {
  createAgentSession,
  agentBase,
  AGENT_BASE,
  agentState,
  agentEvents,
  readAgentPlan,
  appendAgentEvent,
} from "./kabumaru-agent-audit";
import { proposeAgentPlan } from "./kabumaru-agent-planner";
import { readAgentApproval, approveAgentPlan } from "./kabumaru-agent";
import {
  runAgentSession,
  readAgentCheckpoint,
  agentCheckpointKey,
  controlAgentSession,
  recoverAgentExecution,
} from "./kabumaru-agent-runner";
import { createAgentFoldSet } from "./kabumaru-agent-walk-forward";
import { readAgentResearchReport } from "./kabumaru-agent-evaluation";
import {
  saveAgentMemory,
  syncAgentMemory,
  recallAgentMemory,
} from "./kabumaru-agent-memory";
import {
  agentAttestation,
  verifyAgentAttestation,
} from "./kabumaru-agent-attestation";
const paramsSchema = z.object({ id }),
  pageSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  });
export function registerKabumaruAgent(
  app: FastifyInstance,
  s: Service,
  allowedOrigins: string[],
) {
  app.addHook("onRequest", async (req, reply) => {
    if (
      !req.url.startsWith("/api/research/agent") ||
      ["GET", "HEAD"].includes(req.method)
    )
      return;
    if (
      !req.headers.origin ||
      !allowedOrigins.includes(req.headers.origin) ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin") ||
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return reply
        .code(403)
        .send({
          error:
            "エージェント操作には許可されたOriginとJSONリクエストが必要です",
        });
  });
  const launch = (sessionId: string) => {
    void runAgentSession(s, sessionId).catch(async (error) => {
      if (error instanceof Error && error.message.includes("既に")) return;
      try {
        await s.store.lock(async () => {
          let state = await agentState(s, sessionId);
          if (state.status === "approved") {
            await appendAgentEvent(s, sessionId, {
              kind: "status",
              status: "running",
              planId: state.planId ?? undefined,
              reason: "実行前検証を開始",
              references: [],
            });
            state = await agentState(s, sessionId);
          }
          if (["running", "paused"].includes(state.status))
            await appendAgentEvent(s, sessionId, {
              kind: "status",
              status: "failed",
              planId: state.planId ?? undefined,
              reason:
                error instanceof Error
                  ? error.message
                  : "研究の実行に失敗しました",
              references: [],
            });
        });
      } catch {
        /* The immutable audit chain remains the source of recovery; never log payloads. */
      }
    });
  };
  app.get("/api/research/agent", async () => ({
    methodVersion: "kabumaru-agent-v1",
    tools: agentToolSchema.options,
    permissions: agentToolPermissions,
    forbidden: agentForbiddenActions,
    externalWrites: 0,
    suiTransactions: 0,
    jquantsRequests: 0,
    suiSendSupported: false,
    topics: [
      "high-score-failure",
      "volume-reversal",
      "rsi-recovery",
      "dejavu-similarity",
      "candidate-control",
      "market-regimes",
      "method-stability",
      "missing-data",
    ],
  }));
  app.post("/api/research/agent/folds", async (req) =>
    createAgentFoldSet(s, req.body),
  );
  app.post("/api/research/agent/sessions", async (req) => {
    const q = agentSessionInputSchema
        .extend({ requestId: z.string().uuid() })
        .strict()
        .parse(req.body),
      { requestId, ...input } = q;
    return createAgentSession(s, input, requestId);
  });
  app.get("/api/research/agent/sessions", async (req) => {
    const q = pageSchema.parse(req.query),
      files = (await s.store.files(`${AGENT_BASE}/sessions`))
        .filter((f) =>
          /^research\/agent\/sessions\/[a-f0-9]{64}\/original.json$/.test(f),
        )
        .sort()
        .reverse(),
      records = [];
    for (const f of files.slice((q.page - 1) * q.pageSize, q.page * q.pageSize))
      records.push(await recoverAgentExecution(s, f.split("/").at(-2)!));
    return { records, total: files.length, ...q };
  });
  app.get("/api/research/agent/sessions/:id", async (req) => {
    const { id } = paramsSchema.parse(req.params),
      state = await recoverAgentExecution(s, id),
      plan = state.planId ? await readAgentPlan(s, id, state.planId) : null,
      approval =
        plan &&
        (await s.store.read(
          `${agentBase(id)}/plans/${plan.planId}/approval/original.json`,
          null,
        ))
          ? await readAgentApproval(s, plan)
          : null,
      checkpoint =
        plan && (await s.store.read(agentCheckpointKey(plan), null))
          ? await readAgentCheckpoint(s, plan)
          : null;
    return { ...state, plan, approval, checkpoint };
  });
  app.post("/api/research/agent/sessions/:id/propose", async (req) => {
    const q = z
      .object({ requestId: z.string().uuid(), proposal: agentPlanInputSchema })
      .strict()
      .parse(req.body);
    return proposeAgentPlan(
      s,
      paramsSchema.parse(req.params).id,
      q.proposal,
      new Date(),
      q.requestId,
    );
  });
  app.post("/api/research/agent/sessions/:id/approve", async (req) =>
    approveAgentPlan(s, paramsSchema.parse(req.params).id, req.body),
  );
  app.post("/api/research/agent/sessions/:id/start", async (req) => {
    const { id: sessionId } = paramsSchema.parse(req.params),
      q = z.object({ planId: id, approvalId: id }).strict().parse(req.body),
      state = await agentState(s, sessionId);
    if (state.planId !== q.planId)
      throw Error("開始対象の計画が変更されています");
    const p = await readAgentPlan(s, sessionId, q.planId),
      a = await readAgentApproval(s, p);
    if (
      a.approvalId !== q.approvalId ||
      !["approved", "paused", "running", "completed"].includes(state.status)
    )
      throw Error("実行承認と状態が一致しません");
    launch(sessionId);
    return { sessionId, accepted: true, planId: q.planId };
  });
  app.post("/api/research/agent/sessions/:id/control", async (req) => {
    const { id: sessionId } = paramsSchema.parse(req.params),
      q = z
        .object({ action: z.enum(["pause", "resume", "cancel"]) })
        .strict()
        .parse(req.body),
      state = await agentState(s, sessionId);
    if (q.action === "cancel" && state.status === "cancelled") return state;
    if (
      q.action === "cancel" &&
      ["draft", "awaiting-approval", "approved"].includes(state.status) &&
      (!state.planId ||
        !(await s.store.read(
          agentCheckpointKey(await readAgentPlan(s, sessionId, state.planId)),
          null,
        )))
    )
      return s.store.lock(() =>
        appendAgentEvent(s, sessionId, {
          kind: "control",
          status: "cancelled",
          planId: state.planId ?? undefined,
          reason: "利用者が開始前にキャンセル",
          references: [],
        }),
      );
    const checkpoint = await controlAgentSession(s, sessionId, q.action);
    if (q.action === "resume") launch(sessionId);
    return checkpoint;
  });
  app.get("/api/research/agent/sessions/:id/timeline", async (req) => {
    const { id } = paramsSchema.parse(req.params),
      q = pageSchema.parse(req.query),
      events = await agentEvents(s, id);
    return {
      records: events.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      total: events.length,
      ...q,
    };
  });
  app.get("/api/research/agent/sessions/:id/evidence", async (req) => {
    const { id } = paramsSchema.parse(req.params),
      q = pageSchema.parse(req.query),
      state = await agentState(s, id);
    if (!state.planId) return { records: [], total: 0, ...q };
    const p = await readAgentPlan(s, id, state.planId);
    return {
      records: p.evidenceIds.slice(
        (q.page - 1) * q.pageSize,
        q.page * q.pageSize,
      ),
      total: p.evidenceIds.length,
      ...q,
    };
  });
  app.get("/api/research/agent/sessions/:id/report", async (req) =>
    readAgentResearchReport(s, paramsSchema.parse(req.params).id),
  );
  app.post("/api/research/agent/sessions/:id/memory", async (req) => {
    z.object({}).strict().parse(req.body);
    return saveAgentMemory(s, paramsSchema.parse(req.params).id);
  });
  app.post("/api/research/agent/sessions/:id/sync", async (req) => {
    const q = z
      .object({ confirmExternal: z.literal(true) })
      .strict()
      .parse(req.body);
    return syncAgentMemory(
      s,
      paramsSchema.parse(req.params).id,
      q.confirmExternal,
    );
  });
  app.post("/api/research/agent/sessions/:id/recall", async (req) => {
    const q = z
      .object({ confirmExternal: z.literal(true) })
      .strict()
      .parse(req.body);
    return recallAgentMemory(
      s,
      paramsSchema.parse(req.params).id,
      q.confirmExternal,
    );
  });
  app.get("/api/research/agent/sessions/:id/attestation", async (req) => {
    const q = z
      .object({ network: agentAttestationNetworkSchema.default("local") })
      .strict()
      .parse(req.query);
    return agentAttestation(s, paramsSchema.parse(req.params).id, q.network);
  });
  app.post("/api/research/agent/sessions/:id/attestation/verify", async (req) =>
    verifyAgentAttestation(s, paramsSchema.parse(req.params).id, req.body),
  );
}
