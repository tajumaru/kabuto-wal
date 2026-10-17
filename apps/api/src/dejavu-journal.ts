import { searchDejavuContext } from "./hunter-research";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { searchDejavu, snapshot } from "./dejavu";
import {
  predictionSchema,
  targetDate,
  type Calendar,
} from "../../../packages/core/index";
import {
  CONSENSUS_METHOD,
  HORIZONS,
} from "../../../packages/core/dejavu-consensus";
import { syncMemories, syncWarning } from "../../../packages/integrations/index";

export const reflectionNamespace = (mode: string, code: string) =>
  `kabutowal:dejavu:reflection:v1:${mode}:${code}`;
const query = z.object({
  code: z.string().regex(/^[A-Z0-9]{4,5}$/),
  compareCode: z
    .string()
    .regex(/^[A-Z0-9]{4,5}$/)
    .optional(),
  asOf: z.string().date().optional(),
  hunterJobId: z.string().uuid().optional(),
});
const reflectionSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("dejavu_reflection"),
  active: z.literal(true),
  recordId: z.string().uuid(),
  createdAt: z.string().datetime(),
  mode: z.string(),
  providerCode: z.string(),
  namespace: z.string(),
  dataAsOf: z.string().date(),
  text: z.string().max(200000),
  predictionId: z.string().uuid(),
  observations: z.object({
    actualReturn: z.number().finite(),
    predictedReturn: z.number().finite(),
    sampleCount: z.number().int().positive(),
    directionMatch: z.boolean(),
    dna: z.string(),
  }),
  interpretation: z.string(),
});

export async function recallReflections(
  service: Service,
  code: string,
  asOf: string,
  cutoff: string,
) {
  const namespace = reflectionNamespace(service.mode, code);
  const entries: unknown[] = await service.store.all("memories");
  let search = service.mode === "demo" ? "local-demo" : "local-fallback",
    error: string | undefined;
  if (
    service.mode !== "demo" &&
    process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true"
  ) {
    try {
      const provider = await service.memoryProvider();
      if (provider) {
        const response = await provider.recall({
          query: `${code} デジャヴ 評価 特徴量 違い 振り返り`,
          namespace,
          limit: 20,
        });
        for (const r of response.results)
          if (r.text.length <= 200000) {
            try {
              entries.push(JSON.parse(r.text));
            } catch {
              /* Untrusted search text. */
            }
          }
        search = "memwal-semantic";
      }
    } catch {
      error = "MemWal未接続。ローカルの評価記憶を表示しています。";
    }
  }
  const valid = new Map<string, z.infer<typeof reflectionSchema>>();
  const local = new Map(
    (await service.store.all("memories")).map((m) => [m.recordId, m]),
  );
  for (const entry of entries) {
    const r = reflectionSchema.safeParse(entry);
    if (!r.success) continue;
    const m = r.data;
    if (
      local.get(m.recordId)?.active === false || local.get(m.recordId)?.remoteDeletedAt ||
      m.namespace !== namespace ||
      m.mode !== service.mode ||
      m.providerCode !== code ||
      m.dataAsOf > asOf ||
      Date.parse(m.createdAt) > Date.parse(cutoff)
    )
      continue;
    valid.set(m.recordId, m);
  }
  return {
    search,
    error,
    memories: [...valid.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20),
    note: "評価記憶は振り返り専用です。統計の母集団・Scoreには加えません。",
  };
}

export async function recordDejavuForecast(
  service: Service,
  input: z.infer<typeof query>,
) {
  if (input.hunterJobId) throw Error("ハンターの研究仮説は専用の記録操作を使用してください");
  return service.store.lock(async () => {
    const r = await searchDejavu(
      service,
      input.code,
      input.asOf,
      input.compareCode,
    );
    const base = (await snapshot(service, input.code, r.cutoff)).find(
      (b) => b.sessionDate === r.asOf,
    );
    if (!base?.adjClose) throw Error("基準日の価格が不足しています");
    const calendar = await service.store.read<Calendar>("market/calendar.json");
    const plans = HORIZONS.map((h) => {
      const s = r.consensus.horizons[h];
      if (
        !s.sampleCount ||
        s.medianReturn === null ||
        s.upRatio === null ||
        !s.percentileRange
      )
        throw Error("有効な過去事例がないため仮説を記録できません");
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            service.mode,
            input.code,
            r.compareCode,
            r.asOf,
            CONSENSUS_METHOD,
            h,
          ]),
        )
        .digest("hex");
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const now = new Date().toISOString();
      return predictionSchema.parse({
        schemaVersion: 1,
        recordId: id,
        predictionId: id,
        kind: "prediction",
        createdAt: now,
        generatedAt: now,
        source: r.source,
        providerCode: input.code,
        mode: service.mode === "demo" ? "demo" : "research",
        dataAsOf: r.asOf,
        horizonSessions: h,
        targetSessionDate: targetDate(calendar, r.asOf, h),
        referencePrice: base.adjClose,
        referenceBasis: "取得締切時点の調整済み終値・改訂ID固定",
        predictedReturn: s.medianReturn,
        expectedPrice: base.adjClose! * (1 + s.medianReturn),
        returnQuantiles: s.percentileRange,
        pUp: s.upRatio,
        sampleCount: s.sampleCount,
        inputRevisionIds: [
          ...r.inputRevisionIds,
          ...r.examples.flatMap((e) => e.revisionIds),
        ],
        candidateIds: r.consensus.exampleIds,
        featureVersion: r.featureVersion,
        methodVersion: CONSENSUS_METHOD,
        model: "local-numeric",
        promptVersion: "deterministic-v1",
        reason: `${s.reliability}。過去類似事例の中央値による研究仮説。上昇確率ではありません。`,
        falsification:
          "価格形状・出来高などの差異と期限後の実績を確認。因果は特定しません。",
        dejavu: {
          schemaVersion: 1,
          compareCode: r.compareCode,
          asOf: r.asOf,
          evaluationStatus: "pending",
          sourceDejavuRecordId: r.recordId,
          dataCutoff: r.cutoff,
          consensusScore: s.consensusScore,
          weightedReturn: s.weightedReturn,
          medianReturn: s.medianReturn,
          upRatio: s.upRatio,
          percentileRange: s.percentileRange,
          exampleIds: r.consensus.exampleIds,
          selection: r.consensus.selection,
          dnaSummary: r.dna[0]?.explanation || "特徴量なし",
        },
      });
    });
    const records = [];
    for (const p of plans) {
      const key = `predictions/${p.predictionId}/original.json`;
      const old = await service.store.read(key, null);
      if (!old) {
        await service.store.write(key, p, true);
      }
      if (
        !(await service.store.read(
          `predictions/${p.predictionId}/state.json`,
          null,
        ))
      ) {
        await service.store.write(`predictions/${p.predictionId}/state.json`, {
          schemaVersion: 1,
          status: "pending",
        });
      }
      records.push(old || p);
    }
    // Keep the exact source analysis beside its hypotheses, without nesting locks.
    const sourceKey = `memories/${r.recordId}.json`;
    if (!(await service.store.read(sourceKey, null))) {
      await service.store.write(
        sourceKey,
        {
          schemaVersion: 1,
          recordId: r.recordId,
          kind: "dejavu_memory",
          active: true,
          createdAt: new Date().toISOString(),
          mode: r.mode,
          source: r.source,
          providerCode: r.providerCode,
          namespace: r.namespace,
          dataAsOf: r.asOf,
          text: JSON.stringify(r),
          payload: r,
        },
        true,
      );
    }
    if (!(await service.store.read(`sync/${r.recordId}.json`, null))) {
      await service.store.write(`sync/${r.recordId}.json`, {
        status: "pending",
      });
    }
    await service.store.rebuild();
    return { records };
  });
}

export function registerDejavuJournal(app: FastifyInstance, service: Service) {
  app.get("/api/dejavu/consensus", async (req) => {
    const q = query.parse(req.query);
    return (await searchDejavuContext(service, q.code, q.asOf, q.compareCode, q.hunterJobId))
      .consensus;
  });
  app.get("/api/dejavu/explanation", async (req) => {
    const q = query.parse(req.query),
      r = await searchDejavuContext(service, q.code, q.asOf, q.compareCode, q.hunterJobId);
    const reflections = await recallReflections(
      service,
      q.code,
      r.asOf,
      r.cutoff,
    );
    return {
      mode: "deterministic-template",
      dna: r.dna,
      reflections,
      summary:
        r.dna[0]?.explanation || "比較できる過去事例がないため解説できません。",
      caution:
        "過去の経験分布です。将来の価格・ニュース・決算や因果関係は推測しません。",
    };
  });
  app.post("/api/dejavu/forecast", async (req) => {
    const saved = await recordDejavuForecast(service, query.parse(req.body));
    let syncError: string | undefined;
    if (
      service.mode !== "demo" &&
      process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true"
    ) {
      try {
        syncError = syncWarning(await service.store.lock(async () =>
          syncMemories(service.store, await service.memoryProvider(), true),
        ));
      } catch {
        syncError = "ローカル保存済み。MemWal同期は次回ジョブで再試行します。";
      }
    }
    return { ...saved, syncError };
  });
  app.get("/api/dejavu/evaluations", async (req) => {
    const q = query.parse(req.query);
    return (await service.predictions()).filter(
      (p) =>
        p.providerCode === q.code &&
        p.methodVersion === CONSENSUS_METHOD &&
        (service.mode === "demo" ? p.mode === "demo" : p.mode !== "demo") &&
        p.dejavu?.compareCode === (q.compareCode || q.code) &&
        (!q.asOf || p.dataAsOf <= q.asOf),
    );
  });
}
