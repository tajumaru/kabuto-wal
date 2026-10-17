import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { recordHunterForecast } from "../apps/api/src/hunter-journal";
import { syncMemories } from "../packages/integrations/index";
import { seedHunterRaw } from "./hunter-fixture";

it("研究要約・反省の冪等性、契約確認、削除抑止、通信失敗のローカル保持", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light"); vi.stubEnv("ALLOW_MARKET_DATA_TO_MEMWAL", "true"); vi.stubEnv("JQUANTS_MEMWAL_RIGHTS_CONFIRMED", "false");
  const dir = await mkdtemp(path.join(os.tmpdir(), "hunter-memory-")), service = new Service(dir, "live", false);
  const remember = vi.fn().mockRejectedValue(Error("offline"));
  const provider = { remember, waitForRememberJob: vi.fn(), recall: vi.fn() };
  try {
    await service.init(); const f = await seedHunterRaw(service, 140);
    const engine = new HunterJobs(service), job = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff });
    await engine.run(job.id);
    await recordHunterForecast(service, { jobId: job.id, code: "72030" });
    await service.store.lock(() => service.evaluateDue());
    const memories = await service.store.all("memories");
    expect(memories).toHaveLength(6);
    expect(memories.filter(m => m.kind === "hunter_reflection")).toHaveLength(3);
    expect(memories.every(m => !m.payload && !JSON.stringify(m).includes('"chart"'))).toBe(true);
    await syncMemories(service.store, provider, true); expect(remember).not.toHaveBeenCalled();
    for (const [i,m] of memories.entries()) if (i) {
      await service.store.write(`memories/${m.recordId}.json`, { ...m, active: false });
      await service.store.write(`sync/${m.recordId}.json`, { status: "deleted" });
    }
    await recordHunterForecast(service, { jobId: job.id, code: "72030" });
    await service.store.lock(() => service.evaluateDue());
    expect(await service.store.all("memories")).toHaveLength(6);
    expect((await service.store.all("memories")).filter(m => m.active)).toHaveLength(1);
    vi.stubEnv("JQUANTS_MEMWAL_RIGHTS_CONFIRMED", "true");
    await syncMemories(service.store, provider, false); expect(remember).not.toHaveBeenCalled();
    expect((await syncMemories(service.store, provider, true)).uncertain).toBe(1);
    expect(await service.store.read(`sync/${memories[0].recordId}.json`)).toMatchObject({ status: "uncertain", pendingText: expect.any(String) });
    expect(await service.store.all("predictions")).toHaveLength(6);
  } finally { await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
