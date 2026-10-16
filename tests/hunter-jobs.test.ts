import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { demoBars } from "../fixtures/demo";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { analyzeBottom } from "../apps/api/src/bottom";

it("0件・1件・複数銘柄の銘柄別再開、同時起動抑止、個別判定との一致", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hunter-jobs-"));
  const service = new Service(dir, "demo", false);
  try {
    await service.init();
    const engine = new HunterJobs(service), asOf = "2026-10-09";
    const job = await engine.create({ asOf });
    await service.store.write("prices/72030/fixture.json", demoBars("72030"));
    const spy = vi.spyOn(service, "history");
    const paused = await engine.run(job.id, { maxSymbols: 1 });
    expect(paused.status).toBe("paused");
    expect((await engine.rows(job.id))).toHaveLength(1);
    const row = (await engine.rows(job.id))[0];
    const direct = await analyzeBottom(service, row.code, asOf, new Date(), { cutoff: job.cutoff });
    expect(row.score).toBe(direct.score);
    const calls = spy.mock.calls.filter(c => c[0] === row.code).length;
    await engine.resume(job.id);
    const first = engine.run(job.id);
    await expect(engine.run(job.id)).rejects.toThrow("実行中");
    expect((await first).status).toBe("completed");
    expect(spy.mock.calls.filter(c => c[0] === row.code)).toHaveLength(calls);
    expect(await engine.rows(job.id)).toHaveLength(4);
    const coverage = await service.store.read(`market/hunter/coverage/${job.id}.json`);
    expect(coverage).toMatchObject({ universeCount: 4, acquiredCount: 1, analyzedCount: 1, unavailableCount: 3, complete: false });
    await service.store.write("market/master.json", []);
    const empty = await engine.create({ asOf });
    expect((await engine.run(empty.id)).status).toBe("completed");
    expect(await engine.rows(empty.id)).toEqual([]);
    await service.store.write("market/master.json", [{ providerCode: "72030", name: "single" }]);
    const single = await engine.create({ asOf });
    expect((await engine.run(single.id)).status).toBe("completed");
    expect(await engine.rows(single.id)).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("キャンセル・再開と外部取得の明示確認を保持", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hunter-cancel-"));
  const service = new Service(dir, "demo", false);
  try {
    await service.init(); const engine = new HunterJobs(service);
    const job = await engine.create({ asOf: "2026-10-09" });
    await engine.cancel(job.id);
    expect((await engine.run(job.id)).status).toBe("cancelled");
    await engine.resume(job.id);
    expect((await engine.run(job.id)).status).toBe("completed");
    service.mode = "live";
    await expect(engine.create({ kind: "initial", from: "2026-06-01", asOf: "2026-07-01" })).rejects.toThrow("明示確認");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
