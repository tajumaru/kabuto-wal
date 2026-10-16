import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { createApp } from "../apps/api/src/server";
import { analyzeBottom } from "../apps/api/src/bottom";
import { demoBars } from "../fixtures/demo";

it("取得済みデータだけで解析し、過去日時点と欠損・系列不一致を検査する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bottom-api-"));
  const service = new Service(root, "demo", false);
  const app = await createApp(service);
  const bars = demoBars("72030").slice(-100);
  try {
    const noPrices = (
      await app.inject("/api/bottom/analysis?code=72030")
    ).json();
    expect(noPrices.score).toBeNull();
    expect(noPrices.reasonCodes).toContain("no_prices");
    await service.store.write("prices/72030/fixture.json", bars);
    const write = vi.spyOn(service.store, "write");
    const response = await app.inject(
      "/api/bottom/analysis?code=72030&asOf=2026-10-09",
    );
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.status).toBe("ready");
    expect(result.conditions).toHaveLength(10);
    expect(result.inputRevisionIds).toHaveLength(80);
    expect(result.calibratedProbability).toBeNull();
    expect(result.riskCodes).toContain("liquidity_unknown");
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    const historical = await analyzeBottom(
      service,
      "72030",
      bars[89].sessionDate,
    );
    await service.store.write("prices/72030/fixture.json", bars.slice(0, 90));
    expect(await analyzeBottom(service, "72030", bars[89].sessionDate)).toEqual(
      historical,
    );
    const changed = bars.map((b) => ({ ...b }));
    changed[99].availableAt = "2026-10-10T00:00:00Z";
    await service.store.write("prices/72030/fixture.json", changed);
    expect(
      (await analyzeBottom(service, "72030", "2026-10-09")).reasonCodes,
    ).toContain("asof_not_observed");
    changed[99] = { ...bars[99], seriesId: "different" };
    await service.store.write("prices/72030/fixture.json", changed);
    expect(
      (await analyzeBottom(service, "72030", "2026-10-09")).reasonCodes,
    ).toContain("inconsistent_adjustment_series");
    changed[99] = { ...bars[99], adjLow: null };
    await service.store.write("prices/72030/fixture.json", changed);
    expect(
      (await analyzeBottom(service, "72030", "2026-10-09")).reasonCodes,
    ).toContain("invalid_ohlcv");
    await service.store.write(
      "prices/72030/fixture.json",
      bars.filter((_, i) => i !== 95),
    );
    expect(
      (await analyzeBottom(service, "72030", "2026-10-09")).reasonCodes,
    ).toContain("missing_sessions");
    await service.store.write("prices/72030/fixture.json", bars.slice(-79));
    expect(
      (await analyzeBottom(service, "72030", "2026-10-09")).reasonCodes,
    ).toContain("insufficient_history");
    await service.store.write(
      "prices/72030/fixture.json",
      bars.map((b) => ({ ...b, volume: 0 })),
    );
    const emptyVolume = await analyzeBottom(service, "72030", "2026-10-09");
    expect(emptyVolume.score).toBeNull();
    expect(emptyVolume.reasonCodes).toContain("volume_history_empty");
    expect(
      (await app.inject("/api/bottom/analysis?code=../../x")).statusCode,
    ).toBe(422);
    expect(
      (await app.inject("/api/bottom/analysis?code=72030&asOf=2026-02-30"))
        .statusCode,
    ).toBe(422);
    expect(
      (await app.inject("/api/bottom/analysis?code=12340")).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
