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
    const paused = await engine.run(job.id, { maxSymbols: 1 });
    expect(paused.status).toBe("paused");
    expect((await engine.rows(job.id))).toHaveLength(1);
    const row = (await engine.rows(job.id))[0];
    const direct = await analyzeBottom(service, row.code, asOf, new Date(), { cutoff: job.cutoff });
    expect(row.score).toBe(direct.score);
    const writes = vi.spyOn(service.store, "write");
    await engine.resume(job.id);
    const first = engine.run(job.id);
    await expect(engine.run(job.id)).rejects.toThrow("実行中");
    expect((await first).status).toBe("completed");
    expect(writes.mock.calls.filter(c => c[0].includes("/details/") && c[0].endsWith(`/${row.code}.json`))).toHaveLength(0);
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

it("完全一致した入力だけ再利用し、条件変更と別workerを拒否する", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hunter-identity-"));
  const service = new Service(dir, "demo", false);
  try {
    await service.init();
    const engine = new HunterJobs(service), other = new HunterJobs(service);
    const input = { asOf: "2026-10-09", cutoff: "2026-10-10T00:00:00.000Z" };
    const a = await engine.create(input);
    await engine.run(a.id);
    const writes = vi.spyOn(service.store, "write");
    const b = await engine.create(input);
    await other.run(b.id);
    expect((await engine.get(a.id)).analysisId).toBe((await engine.get(b.id)).analysisId);
    expect(writes.mock.calls.filter(c => c[0].includes("/details/"))).toHaveLength(0);
    const c = await engine.create({ ...input, cutoff: "2026-10-11T00:00:00.000Z" });
    await engine.run(c.id, { maxSymbols: 1 });
    expect((await engine.get(c.id)).analysisId).not.toBe((await engine.get(a.id)).analysisId);
    const saved = await engine.get(c.id);
    await service.store.write(`market/hunter/jobs/${c.id}.json`, { ...saved, analysisId: "obsolete-method" });
    await engine.resume(c.id);
    await expect(engine.run(c.id)).rejects.toThrow("分析条件");
    const d = await engine.create(input);
    const results = await Promise.allSettled([engine.run(d.id), other.run(d.id)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

it("分析中キャンセル後の結果保存を防ぎ、データ区分の変更を拒否する", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hunter-cancel-write-"));
  const service = new Service(dir, "demo", false);
  try {
    await service.init();
    const engine = new HunterJobs(service), job = await engine.create({ asOf: "2026-10-09" });
    const original = service.history.bind(service); let calls = 0;
    const spy = vi.spyOn(service, "history").mockImplementation(async code => {
      if (++calls === 5) await engine.cancel(job.id);
      return original(code);
    });
    expect((await engine.run(job.id)).status).toBe("cancelled");
    expect(await engine.rows(job.id)).toEqual([]);
    spy.mockRestore();
    const other = await engine.create({ asOf: "2026-10-09" });
    service.mode = "live";
    await expect(engine.run(other.id)).rejects.toThrow("データ区分");
    expect(await engine.rows(other.id)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});
