import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import { memoryResetClient, type MemoryResetClient, type ResetNamespace } from "../../../packages/integrations/memwal-reset";

type Plan = { id: string; binding: string; createdAt: string; state: "prepared" | "running" | "completed" | "partial"; namespaces: (ResetNamespace & { state: "pending" | "completed" | "failed"; deleted?: number; error?: string })[] };
const planKey = "settings/memwal-search-reset.json";
const binding = () => createHash("sha256").update(JSON.stringify([process.env.OWNER_ADDRESS, process.env.MEMWAL_ACCOUNT_ID, process.env.MEMWAL_SERVER_URL || "https://relayer.memory.walrus.xyz"])).digest("hex");
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
  app.post("/api/memory-reset/preview", async () => service.store.lock(async () => {
    const remote = client();
    await remote.identity();
    await checkJobs();
    const namespaces = await remote.namespaces();
    const plan: Plan = { id: randomUUID(), binding: binding(), createdAt: new Date().toISOString(), state: "prepared", namespaces: namespaces.map((ns) => ({ ...ns, state: "pending" })) };
    await service.store.write(planKey, plan);
    return plan;
  }));
  app.post("/api/memory-reset/execute", async (req) => service.store.lock(async () => {
    const body = z.object({ planId: z.string().uuid(), confirmation: z.literal("検索リセット") }).strict().parse(req.body);
    const remote = client();
    const plan: Plan | null = await service.store.read(planKey, null);
    if (!plan || plan.id !== body.planId || plan.binding !== binding() || plan.state !== "prepared" || Date.now() - Date.parse(plan.createdAt) > 600000) throw Error("対象確認の期限切れ、設定変更、または実行済みです。対象を確認し直してください。");
    await remote.identity();
    await checkJobs();
    const current = await remote.namespaces();
    if (JSON.stringify(current) !== JSON.stringify(plan.namespaces.map(({ name, memory_count }) => ({ name, memory_count })))) throw Error("MemWalの対象や件数が変わりました。対象を確認し直してください。");
    // Durable guards precede remote changes. A crash must not re-upload old records.
    const names = new Set(plan.namespaces.map((ns) => ns.name));
    const resetAt = new Date().toISOString();
    for (const memory of await service.store.all("memories")) {
      if (typeof memory.namespace !== "string" || (!names.has(memory.namespace) && !names.has(memory.namespace.replace(/^stock-memory:/, "kabutowal:")))) continue;
      const key = `sync/${memory.recordId}.json`;
      await service.store.write(key, { ...(await service.store.read(key, { status: "pending" })), searchResetAt: resetAt });
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
