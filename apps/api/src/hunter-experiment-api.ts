import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { cohortIdSchema } from "../../../packages/core/hunter-cohort-schema";
import { BOTTOM_CONFIG } from "../../../packages/core/bottom-score";
import {
  labFeatures,
  labMethodSchema,
  labRunSchema,
} from "../../../packages/core/hunter-experiment-schema";
import {
  labBase,
  createLabMethod,
  readLabMethod,
  labEvents,
  changeLabState,
  readLabPlan,
} from "./hunter-experiment";
import { createLabPlan, selectLabMethod } from "./hunter-experiment-temporal";
import { generateLabHypothesis } from "./hunter-experiment-hypotheses";
import {
  createLabRun,
  runLabExperiment,
  controlLabRun,
  readLabRun,
  labRunKey,
} from "./hunter-experiment-runner";
import { readLabReport } from "./hunter-experiment-report";
import {
  saveLabMemory,
  syncLabMemory,
  recallLabMemory,
  saveLabProvenance,
} from "./hunter-experiment-memory";
import { recoverResearchJob } from "./research-json-worker";
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const paramsSchema = z.object({ id: cohortIdSchema });
export function registerHunterLab(app: FastifyInstance, s: Service) {
  const start = (id: string) => {
    void runLabExperiment(s, id).catch(async (error) => {
      try {
        await s.store.lock(async () => {
          const j = await readLabRun(s, id);
          if (j.status === "queued")
            await s.store.write(labRunKey(id), {
              ...j,
              status: "paused",
              error:
                error instanceof Error && error.message.includes("既に")
                  ? "別の研究workerが実行中です。終了後に再開してください。"
                  : "入力を確認し、保存済み条件で再開してください。",
            });
        });
      } catch {
        /* Keep the durable checkpoint; no secrets or payload are logged. */
      }
    });
  };
  app.get("/api/research/lab", async () => ({
    current: BOTTOM_CONFIG,
    features: labFeatures,
    note: "現行候補判定の流動性・リスク条件は維持。本番方式の切替は実装しません。",
  }));
  app.get("/api/research/lab/methods", async (req) => {
    const q = pageSchema.parse(req.query),
      files = (await s.store.files(`${labBase}/methods`))
        .filter((f) =>
          /^research\/lab\/methods\/[a-f0-9]{64}\/original.json$/.test(f),
        )
        .sort()
        .reverse(),
      records = [];
    for (const file of files.slice(
      (q.page - 1) * q.pageSize,
      q.page * q.pageSize,
    )) {
      const m = labMethodSchema.parse(await s.store.read(file));
      await readLabMethod(s, m.experimentId);
      records.push({
        ...m,
        status: (await labEvents(s, m.experimentId)).at(-1)?.status ?? "draft",
      });
    }
    return { records, total: files.length, ...q };
  });
  app.post("/api/research/lab/methods", async (req) => {
    const q = z
      .object({ method: z.unknown(), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return createLabMethod(s, q.method);
  });
  app.get("/api/research/lab/methods/:id", async (req) => {
    const { id } = paramsSchema.parse(req.params);
    return {
      method: await readLabMethod(s, id),
      events: await labEvents(s, id),
    };
  });
  app.post("/api/research/lab/methods/:id/state", async (req) =>
    changeLabState(s, paramsSchema.parse(req.params).id, req.body),
  );
  app.post("/api/research/lab/hypotheses", async (req) =>
    generateLabHypothesis(s, req.body),
  );
  app.post("/api/research/lab/plans", async (req) =>
    createLabPlan(s, req.body),
  );
  app.get("/api/research/lab/plans", async (req) => {
    const q = pageSchema.parse(req.query),
      files = (await s.store.files(`${labBase}/plans`))
        .filter((f) =>
          /^research\/lab\/plans\/[a-f0-9]{64}\/original.json$/.test(f),
        )
        .sort()
        .reverse(),
      records = [];
    for (const f of files.slice(
      (q.page - 1) * q.pageSize,
      q.page * q.pageSize,
    )) {
      const p = await readLabPlan(s, f.split("/").at(-2)!);
      records.push({
        planId: p.planId,
        createdAt: p.createdAt,
        training: p.training,
        validation: p.validation,
        test: p.test,
        partitions: p.partitions,
        purgeReasons: p.purgeReasons,
        embargoSessions: p.embargoSessions,
      });
    }
    return { records, total: files.length, ...q };
  });
  app.post("/api/research/lab/plans/:id/select", async (req) => {
    const q = z
      .object({ experimentId: cohortIdSchema, confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return selectLabMethod(
      s,
      paramsSchema.parse(req.params).id,
      q.experimentId,
      q.confirm,
    );
  });
  app.post("/api/research/lab/runs", async (req) => {
    const j = await createLabRun(s, req.body);
    start(j.runId);
    return j;
  });
  app.get("/api/research/lab/runs", async (req) => {
    const q = pageSchema.parse(req.query),
      files = (await s.store.files(`${labBase}/runs`))
        .filter((f) => f.endsWith("/checkpoint.json"))
        .sort()
        .reverse();
    const records = await Promise.all(
      files
        .slice((q.page - 1) * q.pageSize, q.page * q.pageSize)
        .map((f) => s.store.read(f).then((r) => labRunSchema.parse(r))),
    );
    return { records, total: files.length, ...q };
  });
  app.get("/api/research/lab/runs/:id", async (req) => {
    const { id } = paramsSchema.parse(req.params);
    await recoverResearchJob(s, labRunKey(id));
    return readLabRun(s, id);
  });
  app.post("/api/research/lab/runs/:id/control", async (req) => {
    const { id } = paramsSchema.parse(req.params),
      q = z
        .object({ action: z.enum(["pause", "cancel", "resume"]) })
        .strict()
        .parse(req.body),
      j = await controlLabRun(s, id, q.action);
    if (q.action === "resume") start(id);
    return j;
  });
  app.get("/api/research/lab/runs/:id/report", async (req) => {
    const q = z
        .object({ view: z.literal("compact").optional() })
        .parse(req.query),
      r = await readLabReport(s, paramsSchema.parse(req.params).id);
    return q.view === "compact"
      ? {
          ...r,
          baseline: {
            ...r.baseline,
            evaluationIds: r.baseline.evaluationIds.slice(0, 20),
          },
          experiment: {
            ...r.experiment,
            evaluationIds: r.experiment.evaluationIds.slice(0, 20),
          },
          referenceCounts: {
            baseline: r.baseline.evaluationIds.length,
            experiment: r.experiment.evaluationIds.length,
          },
        }
      : r;
  });
  app.get("/api/research/lab/runs/:id/provenance", async (req) => {
    const q = z
        .object({ view: z.literal("compact").optional() })
        .parse(req.query),
      p = await saveLabProvenance(s, paramsSchema.parse(req.params).id);
    return q.view === "compact"
      ? {
          manifestHash: p.manifestHash,
          algorithm: p.algorithm,
          suiWrite: false,
        }
      : p;
  });
  app.post("/api/research/lab/runs/:id/memory", async (req) =>
    saveLabMemory(s, paramsSchema.parse(req.params).id),
  );
  app.post("/api/research/lab/runs/:id/sync", async (req) => {
    const q = z
      .object({ confirmExternal: z.literal(true) })
      .strict()
      .parse(req.body);
    return syncLabMemory(
      s,
      paramsSchema.parse(req.params).id,
      q.confirmExternal,
    );
  });
  app.post("/api/research/lab/recall", async (req) =>
    recallLabMemory(s, req.body),
  );
}
