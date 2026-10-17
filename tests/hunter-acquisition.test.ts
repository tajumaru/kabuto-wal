import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { JQuants } from "../packages/integrations/jquants";
import { HunterJobs } from "../apps/api/src/hunter-jobs";

it("取得失敗のcheckpointを保持して再開し、別ジョブの同時取得を抑止", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light");
  const root = await mkdtemp(path.join(os.tmpdir(), "hunter-acquisition-")), service = new Service(root, "live", false);
  const provider = new JQuants("fixture-key", vi.fn(), { gate: { wait: async () => {}, deferUntil: async () => {} } });
  const date = "2026-10-09";
  try {
    await service.init();
    vi.spyOn(provider, "calendar").mockResolvedValue([{ date, open: true }]);
    vi.spyOn(provider, "master").mockResolvedValue([{ Code: "72030", Date: date, CoName: "fixture", Mkt: "0111", ProdCat: "011" }]);
    const page = vi.spyOn(provider, "page").mockRejectedValueOnce(Error("J-Quants HTTP 401")).mockResolvedValue({ data: [{ Code: "72030", Date: date, O: 100, H: 101, L: 99, C: 100, Vo: 10000, Va: 200000000, AdjFactor: 1, ExRT: null }], next: undefined });
    const engine = new HunterJobs(service, () => new Date("2026-10-17T01:00:00.000Z"), () => provider);
    const job = await engine.create({ kind: "initial", asOf: date, from: date, confirmExternal: true });
    await expect(engine.run(job.id)).rejects.toThrow("401");
    expect(await service.store.read(`market/ingestion/${date}/initial/checkpoint.json`)).toMatchObject({ status: "partial", error: expect.any(String) });
    await engine.resume(job.id); await engine.run(job.id);
    expect((await engine.get(job.id)).status).toBe("completed");
    expect((await engine.get(job.id)).acquisition).toEqual({ completed: 1, total: 1, date });
    expect(page).toHaveBeenCalledTimes(2);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
    vi.spyOn(provider, "calendar").mockImplementationOnce(async () => { entered(); await gate; return [{ date, open: true }]; });
    const a = await engine.create({ kind: "update", asOf: date, from: date, confirmExternal: true });
    const b = await engine.create({ kind: "update", asOf: date, from: date, confirmExternal: true });
    const running = engine.run(a.id); await ready;
    await expect(new HunterJobs(service, () => new Date("2026-10-17T01:00:00.000Z"), () => provider).run(b.id)).rejects.toThrow("別のハンタージョブ");
    await engine.cancel(a.id); release(); await expect(running).rejects.toThrow("キャンセル");
    expect((await engine.get(a.id)).status).toBe("cancelled");
  } finally { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
