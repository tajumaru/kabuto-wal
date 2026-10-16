import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { analyzeBottom } from "../apps/api/src/bottom";
import {
  adjustedSeries,
  hash,
  type RawDaily,
} from "../packages/integrations/adjusted-series";
import { demoBars, calendar } from "../fixtures/demo";

it("新しい原本系列だけで個別解析し、売買代金と過去cutoffを反映する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bottom-derived-"));
  const service = new Service(root, "demo", false);
  try {
    await service.init();
    const bars = demoBars("72030").slice(-80);
    const observations = bars.map((b) => {
      const row: RawDaily = {
        Code: "72030",
        Date: b.sessionDate,
        O: b.adjOpen!,
        H: b.adjHigh!,
        L: b.adjLow!,
        C: b.adjClose,
        Vo: b.volume,
        Va: 200000000,
        AdjFactor: 1,
        ExRT: null,
      };
      return { row, observedAt: b.availableAt, revisionId: hash(row) };
    });
    const series = adjustedSeries(
      observations,
      "72030",
      "2026-10-09",
      "2026-10-10T00:00:00.000Z",
      calendar(),
    );
    await service.store.write(
      `market/bottom-series/72030/2026-10-09/${series.seriesId}.json`,
      { ...series, contentHash: hash(series) },
      true,
    );
    const result = await analyzeBottom(service, "72030", "2026-10-09");
    expect(result.status).toBe("ready");
    expect(result.liquidity).toBe("sufficient");
    expect(result.averageTurnover20).toBe(200000000);
    expect(result.adjustmentVersion).toBe("raw-factor-asof-v1");
    expect(result.riskCodes).not.toContain("liquidity_unknown");
    expect(await service.history("72030")).toEqual([]);
    const corrupted = {
      ...series,
      bars: series.bars.map((b) => ({ ...b, adjClose: 1 })),
      contentHash: hash(series),
    };
    await service.store.write(
      `market/bottom-series/72030/2026-10-09/${series.seriesId}.json`,
      corrupted,
    );
    await expect(analyzeBottom(service, "72030", "2026-10-09")).rejects.toThrow(
      "破損",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
