import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { createApp } from "../apps/api/src/server";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { hunterRankingsSchema, hunterDetailSchema } from "../packages/core/hunter-schema";
import { demoBars } from "../fixtures/demo";

it("ページング・共有応答・詳細・不正入力・既存API互換を検証", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hunter-api-")), service = new Service(root, "demo", false);
  const app = await createApp(service);
  try {
    expect((await app.inject("/api/bottom/hunter/rankings")).json().rows).toEqual([]);
    await service.store.write("prices/72030/fixture.json", demoBars("72030"));
    const engine = new HunterJobs(service), job = await engine.create({ asOf: "2026-10-09" });
    await engine.run(job.id);
    const r = hunterRankingsSchema.parse((await app.inject(`/api/bottom/hunter/rankings?jobId=${job.id}&pageSize=1`)).json());
    expect(r.rows).toHaveLength(1); expect(r.total).toBe(4);
    expect(hunterDetailSchema.safeParse((await app.inject(`/api/bottom/hunter/candidates/72030?jobId=${job.id}`)).json()).success).toBe(true);
    expect((await app.inject("/api/bottom/hunter/rankings?pageSize=10000")).statusCode).toBe(400);
    expect((await app.inject("/api/bottom/hunter/candidates/../bad")).statusCode).toBe(404);
    expect((await app.inject("/api/bottom/analysis?code=72030&asOf=2026-10-09")).json().conditions).toHaveLength(10);
    expect((await app.inject({ method: "POST", url: "/api/bottom/hunter/jobs", headers: { origin: "https://bad.invalid" }, payload: { asOf: "2026-10-09" } })).statusCode).toBe(403);
    expect((await app.inject(`/api/bottom/hunter/jobs/${job.id}`)).json().status).toBe("completed");
    const master = await service.store.read<{ providerCode: string }[]>("market/master.json");
    await service.store.write("market/master.json", master.filter(m => m.providerCode !== "72030"));
    expect((await app.inject({ method: "POST", url: "/api/watchlist", payload: { code: "72030", hunterJobId: job.id } })).statusCode).toBe(200);
    expect((await service.store.read<{ providerCode: string }[]>("market/master.json")).some(m => m.providerCode === "72030")).toBe(true);
    await service.store.write("settings/watchlist.json", { codes: Array.from({ length: 10 }, (_,i) => String(10000+i*10)) });
    expect((await app.inject({ method: "POST", url: "/api/watchlist", payload: { code: "72030", hunterJobId: job.id } })).json().error).toBe("監視は10銘柄まで");
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
