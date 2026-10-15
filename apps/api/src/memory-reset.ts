import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { memoryResetClient, type MemoryResetClient, type ResetNamespace } from "../../../packages/integrations/memwal-reset";
import { memwalBinding } from "../../../packages/integrations/memwal-config";

type Plan = { id: string; binding: string; createdAt: string; memoryId?: string; targetNamespace?: string; state: "prepared" | "running" | "completed" | "partial"; namespaces: (ResetNamespace & { state: "pending" | "completed" | "failed"; deleted?: number; error?: string })[] };
const planKey = "settings/memwal-search-reset.json";
const binding = memwalBinding;
export function registerMemoryReset(app: FastifyInstance, service: Service, factory: () => MemoryResetClient = memoryResetClient) {
  function client() {
    if (service.mode === "demo") throw Error("デモではMemWal検索リセットを実行できません。");
    return factory();
  }
  async function checkJobs() {
    for (const sync of await service.store.all("sync")) {
      if (["accepted", "submitting", "uncertain"].includes(sync.status)) throw Error("MemWalへ送信中、または送信結果未確認の記憶があります。同期結果を確認してからリセットしてください。");
    }
  }
  async function memoryNamespace(memoryId: string) {
    const memory = await service.store.read(`memories/${memoryId}.json`);
    const sync = await service.store.read(`sync/${memoryId}.json`, {});
    if (sync.environmentBinding && sync.environmentBinding !== binding()) throw Error("記憶の保存先と現在の接続先が一致しません。");
    return z.string().min(1).parse(sync.namespace || memory.namespace);
  }
  app.post("/api/memory-reset/preview", async (req) => service.store.lock(async () => {
    const { memoryId } = z.object({ memoryId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict().parse(req.body);
    const targetNamespace = memoryId ? await memoryNamespace(memoryId) : undefined;
    const remote = client();
    await remote.identity();
    await checkJobs();
    const namespaces = (await remote.namespaces()).filter(ns => !memoryId || ns.name === targetNamespace);
    const plan: Plan = { id: randomUUID(), binding: binding(), createdAt: new Date().toISOString(), memoryId, targetNamespace, state: "prepared", namespaces: namespaces.map((ns) => ({ ...ns, state: "pending" })) };
    await service.store.write(planKey, plan);
    return plan;
  }));
  app.post("/api/memory-reset/execute", async (req) => service.store.lock(async () => {
    const body = z.object({ planId: z.string().uuid(), confirmation: z.literal("検索リセット"), namespaces: z.array(z.string().min(1)).min(1) }).strict().parse(req.body);
    const remote = client();
    const plan: Plan | null = await service.store.read(planKey, null);
    if (!plan || plan.id !== body.planId || plan.binding !== binding() || plan.state !== "prepared" || Date.now() - Date.parse(plan.createdAt) > 600000) throw Error("対象確認の期限切れ、設定変更、または実行済みです。対象を確認し直してください。");
    await remote.identity();
    await checkJobs();
    if (plan.memoryId && await memoryNamespace(plan.memoryId) !== plan.targetNamespace) throw Error("記憶の保存区分が変わりました。対象を確認し直してください。");
    const current = (await remote.namespaces()).filter(ns => !plan.memoryId || ns.name === plan.targetNamespace);
    if (JSON.stringify(current) !== JSON.stringify(plan.namespaces.map(({ name, memory_count }) => ({ name, memory_count })))) throw Error("MemWalの対象や件数が変わりました。対象を確認し直してください。");
    // Durable guards precede remote changes. A crash must not re-upload old records.
    const names = new Set(body.namespaces);
    if (names.size !== body.namespaces.length || [...names].some(name => !plan.namespaces.some(ns => ns.name === name))) throw Error("確認していない保存区分、または重複した区分が指定されています。");
    plan.namespaces = plan.namespaces.filter(ns => names.has(ns.name));
    const resetAt = new Date().toISOString();
    for (const memory of await service.store.all("memories")) {
      const key = `sync/${memory.recordId}.json`;
      const sync = await service.store.read(key, { status: "pending" });
      const savedNamespace = sync.namespace || memory.namespace;
      const pendingNamespace = !sync.jobId && !sync.blobId && typeof memory.namespace === "string" ? memory.namespace.replace(/^stock-memory:/, "kabutowal:") : savedNamespace;
      if (!names.has(savedNamespace) && !names.has(pendingNamespace)) continue;
      await service.store.write(key, { ...sync, searchResetAt: resetAt });
    }
    plan.state = "running";
    await service.store.write(planKey, plan);
    for (const ns of plan.namespaces) {
      try {
        ns.deleted = await remote.forget(ns.name);
        ns.state = "completed";
      } catch (e) {
        ns.state = "failed"; ns.error = (e as Error).message;
        plan.state = "partial";
        await service.store.write(planKey, plan);
        return plan;
      }
      await service.store.write(planKey, plan);
    }
    plan.state = "completed";
    await service.store.write(planKey, plan);
    return plan;
  }));
}
