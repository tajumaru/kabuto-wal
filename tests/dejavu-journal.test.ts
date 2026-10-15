import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { demoBars, calendar } from "../fixtures/demo";
import { Service } from "../apps/api/src/service";
import {
  recordDejavuForecast,
  recallReflections,
} from "../apps/api/src/dejavu-journal";
import { searchDejavu } from "../apps/api/src/dejavu";
import { createApp } from "../apps/api/src/server";
import { aggregate } from "../packages/core/analysis";
import Fastify from "fastify";
import { registerDejavuJournal } from "../apps/api/src/dejavu-journal";

it("原本・評価の直後に中断しても再実行で状態と反省記憶を復旧する", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dejavu-interrupted-"));
  const service = new Service(dir, "demo", false);
  try {
    await service.init();
    const bars = demoBars("72030").slice(0, 650), date = bars[600].sessionDate;
    await service.store.write("prices/72030/fixture.json", bars);
    const write = service.store.write.bind(service.store);
    let interrupted = false;
    const spy = vi.spyOn(service.store, "write").mockImplementation(async (key, value, immutable) => {
      if (!interrupted && key.endsWith("/state.json")) { interrupted = true; throw Error("interrupted"); }
      return write(key,value,immutable);
    });
    await expect(recordDejavuForecast(service,{code:"72030",asOf:date})).rejects.toThrow("interrupted");
    spy.mockRestore();
    const partial = (await service.store.all("predictions")).find(p=>p.kind==="prediction");
    const repaired = await recordDejavuForecast(service,{code:"72030",asOf:date});
    expect(repaired.records.find(p=>p.predictionId===partial.predictionId)).toEqual(partial);
    expect((await service.predictions()).every(p=>p.state.status==="pending")).toBe(true);
    const memoryWrite = vi.spyOn(service.store,"write").mockImplementation(async (key,value,immutable)=>{
      if ((value as any)?.kind === "dejavu_reflection") throw Error("memory-interrupted");
      return write(key,value,immutable);
    });
    await expect(service.evaluateDue()).rejects.toThrow("memory-interrupted");
    memoryWrite.mockRestore();
    await service.evaluateDue();
    expect(await service.store.all("evaluations")).toHaveLength(3);
    expect((await service.store.all("memories")).filter(m=>m.kind==="dejavu_reflection")).toHaveLength(3);
    expect(await service.evaluateDue()).toBe(0);
  } finally { vi.restoreAllMocks(); await rm(dir,{recursive:true,force:true}); }
});

it("デジャヴ原本の冪等保存・期限後の別評価・反省記憶・再起動・デモ隔離", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dejavu-v2-"));
  const service = new Service(dir, "demo", false);
  const app = await createApp(service);
  try {
    const bars = demoBars("72030").slice(0, 650),
      date = bars[600].sessionDate;
    await service.store.write("prices/72030/fixture.json", bars);
    const provider = vi
      .spyOn(service, "memoryProvider")
      .mockRejectedValue(Error("offline"));
    const search = await searchDejavu(service, "72030", date);
    const r = await app.inject({
      method: "POST",
      url: "/api/dejavu/forecast",
      payload: { code: "72030", asOf: date },
    });
    expect(r.statusCode).toBe(200);
    const originals = r.json().records;
    expect(originals).toHaveLength(3);
    expect(originals[0].dejavu.sourceDejavuRecordId).toBe(search.recordId);
    expect(originals[1].predictedReturn).toBe(
      search.consensus.horizons[5].medianReturn,
    );
    expect(
      (await recordDejavuForecast(service, { code: "72030", asOf: date }))
        .records,
    ).toEqual(originals);
    expect(await service.store.lock(() => service.evaluateDue())).toBe(3);
    expect(await service.store.lock(() => service.evaluateDue())).toBe(0);
    expect(await service.store.all("evaluations")).toHaveLength(3);
    for (const p of originals)
      expect(
        await service.store.read(`predictions/${p.predictionId}/original.json`),
      ).toEqual(p);
    const reflections = await recallReflections(
      service,
      "72030",
      "2099-01-01",
      "2099-01-01T00:00:00Z",
    );
    expect(reflections.memories).toHaveLength(3);
    expect(reflections.memories[0].observations.sampleCount).toBeGreaterThan(0);
    expect(
      (await recallReflections(service, "72030", date, `${date}T14:59:59Z`))
        .memories,
    ).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
    expect(
      aggregate(await service.predictions()).every((g) => g.evaluated === 1),
    ).toBe(true);
    await new Service(dir, "demo", false).init();
    expect((await service.predictions()).length).toBe(3);
    expect(
      (await app.inject("/api/dejavu/evaluations?code=72030")).json(),
    ).toHaveLength(3);
    expect(
      (await app.inject("/api/dejavu/consensus?code=72030&asOf=2026-99-99"))
        .statusCode,
    ).toBe(400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("期限前や実績欠損はpendingを維持し、未来追加で原本を変えない", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dejavu-pending-"));
  try {
    const service = new Service(dir, "demo", false);
    await service.init();
    const bars = demoBars("72030").slice(0, 650),
      date = bars[600].sessionDate;
    await service.store.write("prices/72030/fixture.json", bars.slice(0, 601));
    const saved = await recordDejavuForecast(service, {
      code: "72030",
      asOf: date,
    });
    expect(await service.evaluateDue()).toBe(0);
    expect(
      (await service.predictions()).every((p) => p.state.status === "pending"),
    ).toBe(true);
    await service.store.write(
      "prices/72030/fixture.json",
      bars.filter((_, i) => i !== 601),
    );
    expect(await service.evaluateDue()).toBe(2);
    expect(
      (await service.predictions()).find((p) => p.horizonSessions === 1).state
        .status,
    ).toBe("pending");
    expect(
      (await recordDejavuForecast(service, { code: "72030", asOf: date }))
        .records,
    ).toEqual(saved.records);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("実接続の許可なしは送信せず、障害時もローカル評価・検索・再同期を続ける", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dejavu-offline-"));
  const previous = process.env.ALLOW_MARKET_DATA_TO_MEMWAL;
  const service = new Service(dir, "live", false),
    app = Fastify();
  registerDejavuJournal(app, service);
  try {
    process.env.ALLOW_MARKET_DATA_TO_MEMWAL = "false";
    await service.init();
    await service.store.write("market/calendar.json", calendar());
    // Synthetic market provider fixture in an isolated test store; no real network.
    const bars = demoBars("72030").slice(0, 650),
      date = bars[600].sessionDate;
    await service.store.write("prices/72030/fixture.json", bars);
    const provider = {
      remember: vi.fn().mockResolvedValue({ job_id: "test-job" }),
      waitForRememberJob: vi.fn().mockResolvedValue({ blob_id: "test-blob" }),
      recall: vi.fn().mockRejectedValue(Error("offline")),
    };
    const connection = vi
      .spyOn(service, "memoryProvider")
      .mockResolvedValue(provider);
    const save = () =>
      app.inject({
        method: "POST",
        url: "/api/dejavu/forecast",
        payload: { code: "72030", asOf: date },
      });
    expect((await save()).statusCode).toBe(200);
    expect(connection).not.toHaveBeenCalled();
    expect(await service.evaluateDue()).toBe(3);
    expect(
      (
        await recallReflections(
          service,
          "72030",
          "2099-01-01",
          "2099-01-01T00:00:00Z",
        )
      ).memories,
    ).toHaveLength(3);
    expect(connection).not.toHaveBeenCalled();
    process.env.ALLOW_MARKET_DATA_TO_MEMWAL = "true";
    connection.mockRejectedValueOnce(Error("offline"));
    const offline = await save();
    expect(offline.json().syncError).toContain("ローカル保存済み");
    expect(await service.store.all("evaluations")).toHaveLength(3);
    const recalled = await recallReflections(
      service,
      "72030",
      "2099-01-01",
      "2099-01-01T00:00:00Z",
    );
    expect(recalled.search).toBe("local-fallback");
    expect(recalled.memories).toHaveLength(3);
    const external = {
      ...recalled.memories[0],
      recordId: "11111111-1111-5111-a111-111111111111",
    };
    provider.recall.mockResolvedValueOnce({
      results: [
        { text: JSON.stringify(external), distance: 0.1 },
        { text: "broken", distance: 0 },
        { text: JSON.stringify({ ...external, mode: "demo" }), distance: 0 },
      ],
    });
    const semantic = await recallReflections(
      service,
      "72030",
      "2099-01-01",
      "2099-01-01T00:00:00Z",
    );
    expect(semantic.search).toBe("memwal-semantic");
    expect(semantic.memories).toHaveLength(4);
    await save();
    expect(provider.remember).toHaveBeenCalledTimes(4);
    expect(
      (await service.store.all("sync")).every((s) => s.status === "synced"),
    ).toBe(true);
    await save();
    expect(provider.remember).toHaveBeenCalledTimes(4);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_MARKET_DATA_TO_MEMWAL;
    else process.env.ALLOW_MARKET_DATA_TO_MEMWAL = previous;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
