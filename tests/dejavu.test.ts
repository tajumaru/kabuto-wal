import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { demoBars, calendar } from "../fixtures/demo";
import {
  dejavu,
  ohlcvFeatures,
  weightedScore,
  WEIGHTS,
} from "../packages/core/dejavu";
import { Service } from "../apps/api/src/service";
import {
  searchDejavu,
  saveDejavu,
  recallDejavu,
  snapshot,
} from "../apps/api/src/dejavu";
import { createApp } from "../apps/api/src/server";
const bars = () => demoBars("72030");
it("20本のOHLCV・価格倍率不変・重み合計・完全一致100点", () => {
  const w = bars().slice(0, 20),
    f = ohlcvFeatures(w);
  expect(f.shape).toHaveLength(20);
  expect(f.candles).toHaveLength(60);
  expect(Object.values(WEIGHTS).reduce((a, b) => a + b)).toBeCloseTo(1);
  expect(weightedScore(f, f).score).toBe(100);
  const scaled = w.map((b) => ({
    ...b,
    adjOpen: b.adjOpen! * 2,
    adjHigh: b.adjHigh! * 2,
    adjLow: b.adjLow! * 2,
    adjClose: b.adjClose! * 2,
    volume: b.volume! * 3,
  }));
  expect(weightedScore(f, ohlcvFeatures(scaled)).score).toBeCloseTo(100);
  expect(() => ohlcvFeatures(w.slice(1))).toThrow();
  for (const change of [
    { adjHigh: null },
    { volume: NaN },
    { adjLow: 0 },
    { adjOpen: 1e9 },
    { seriesId: "other" },
  ])
    expect(() =>
      ohlcvFeatures(w.map((b, i) => (i === 5 ? { ...b, ...change } : b))),
    ).toThrow();
});
it("未来追加・未来実績変更は順位に影響せず、候補の結果窓も比較元より前", () => {
  const b = bars(),
    asOf = b[400].sessionDate,
    cutoff = b[400].availableAt;
  const a = dejavu(b, b, asOf, cutoff, calendar());
  expect(a.examples.length).toBeGreaterThan(0);
  expect(a.examples.every((c) => c.outcomeEnd < a.queryStart)).toBe(true);
  expect(a.statisticalExamples.every((c) => c.outcomeEnd < a.queryStart)).toBe(true);
  const changed = b.map((x, i) => (i > 400 ? { ...x, adjClose: 999999 } : x));
  expect(dejavu(changed, changed, asOf, cutoff, calendar())).toEqual(a);
  expect(
    dejavu(b.slice(0, 401), b.slice(0, 401), asOf, cutoff, calendar()),
  ).toEqual(a);
  for (const c of a.statisticalExamples) expect(c.futureShape).toHaveLength(20);
  const late = b.map((x) => ({ ...x, availableAt: "2099-01-01T00:00:00Z" }));
  expect(dejavu(late, b, asOf, cutoff, calendar()).candidateCount).toBe(0);
  expect(() =>
    dejavu(
      b,
      b.filter((_, i) => i !== 395),
      asOf,
      cutoff,
      calendar(),
    ),
  ).toThrow();
  const duplicate = [...b.slice(0, 395), b[395], ...b.slice(395)];
  expect(() => dejavu(b, duplicate, asOf, cutoff, calendar())).toThrow();
});
it("OHLC足と出来高の変更を個別の距離に反映する", () => {
  const w = bars().slice(0, 20),
    f = ohlcvFeatures(w);
  const candle = weightedScore(
    f,
    ohlcvFeatures(w.map((b) => ({ ...b, adjHigh: b.adjHigh! * 1.1 }))),
  );
  expect(candle.components.shape).toBe(0);
  expect(candle.components.candles).toBeGreaterThan(0);
  expect(candle.score).toBeLessThan(100);
  const volume = weightedScore(
    f,
    ohlcvFeatures(
      w.map((b, i) => ({ ...b, volume: b.volume! * (i % 2 ? 5 : 1) })),
    ),
  );
  expect(volume.components.volume).toBeGreaterThan(0);
});
it("過去改訂選択・保存重複防止・デモ隔離・MemWalの構造化検索", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dejavu-"));
  const previous = process.env.ALLOW_MARKET_DATA_TO_MEMWAL;
  try {
    const service = new Service(dir, "demo", true);
    await service.init();
    const b = bars();
    await service.store.write("revisions/72030/late.json", {
      ...b[10],
      adjClose: 99999,
      availableAt: "2099-01-01T00:00:00Z",
    });
    expect(
      (await snapshot(service, "72030", b[400].availableAt))[10].adjClose,
    ).toBe(b[10].adjClose);
    const r = await searchDejavu(service, "72030");
    expect(r.mode).toBe("demo");
    expect(r.source).toBe("fixture");
    const spy = vi.spyOn(service, "memoryProvider");
    process.env.ALLOW_MARKET_DATA_TO_MEMWAL = "true";
    await saveDejavu(service, r);
    await saveDejavu(service, r);
    expect(spy).not.toHaveBeenCalled();
    const records = (await service.memories()).filter(
      (m) => m.kind === "dejavu_memory",
    );
    expect(records).toHaveLength(1);
    expect(
      (await recallDejavu(service, "72030", "2099-01-01")).memories,
    ).toHaveLength(1);
    expect(
      (await recallDejavu(service, "72030", b[400].sessionDate)).memories,
    ).toHaveLength(0);
    // Use a fake provider; tests never write into the user's real MemWal account.
    service.mode = "live";
    const live = {
      ...records[0],
      mode: "live",
      namespace: "stock-memory:dejavu:v1:live:72030",
      payload: { ...r, mode: "live" },
    };
    const provider = {
      remember: vi.fn(),
      waitForRememberJob: vi.fn(),
      recall: vi.fn().mockResolvedValue({
        results: [
          { text: JSON.stringify(live), distance: 0.1 },
          { text: JSON.stringify(records[0]), distance: 0 },
          { text: "broken", distance: 0 },
          {
            text: JSON.stringify({ ...live, providerCode: "99840" }),
            distance: 0,
          },
        ],
      }),
    };
    const recalled = await recallDejavu(
      service,
      "72030",
      "2099-01-01",
      provider,
    );
    expect(recalled.search).toBe("memwal-semantic");
    expect(recalled.memories).toHaveLength(1);
    expect(provider.recall).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: live.namespace }),
    );
    await service.store.write(`memories/${live.recordId}.json`, { ...live, active: false });
    expect((await recallDejavu(service, "72030", "2099-01-01", provider)).memories).toHaveLength(0);
    await service.store.write(`memories/${live.recordId}.json`, { ...live, active: true, remoteDeletedAt: new Date().toISOString() });
    expect((await recallDejavu(service, "72030", "2099-01-01", provider)).memories).toHaveLength(0);
    provider.recall.mockRejectedValueOnce(Error("offline"));
    expect(
      (await recallDejavu(service, "72030", "2099-01-01", provider)).search,
    ).toBe("local-fallback");
  } finally {
    if (previous === undefined) delete process.env.ALLOW_MARKET_DATA_TO_MEMWAL;
    else process.env.ALLOW_MARKET_DATA_TO_MEMWAL = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
it("API検索・明示保存・カブまる通知・日付検証", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dejavu-api-"));
  const service = new Service(dir, "demo", true),
    app = await createApp(service);
  try {
    const res = await app.inject("/api/similar?code=72030");
    expect(res.statusCode).toBe(200);
    expect(res.json().examples[0].score).toBeGreaterThan(0);
    const notices = await service.store.all("notifications");
    expect(notices.some((n) => n.kind === "dejavu")).toBe(true);
    expect(
      (await service.memories()).some((m) => m.kind === "dejavu_memory"),
    ).toBe(false);
    const saved = await app.inject({
      method: "POST",
      url: "/api/dejavu/save",
      payload: { code: "72030" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().externalAllowed).toBe(false);
    expect(
      (await app.inject("/api/similar?code=72030&asOf=2026-99-99")).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
