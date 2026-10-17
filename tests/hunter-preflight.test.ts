import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Service } from "../apps/api/src/service";
import { hunterPreflight } from "../apps/api/src/hunter-preflight";

it("Lightの期間・速度・短い履歴・保存済み日数と待機を外部接続せず検査", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light"); vi.stubEnv("JQUANTS_API_KEY", "fixture-only"); vi.stubEnv("JQUANTS_REQUESTS_PER_MINUTE", "");
  const root = await mkdtemp(path.join(os.tmpdir(), "hunter-preflight-"));
  const service = new Service(root, "live", false), now = new Date("2026-10-17T01:00:00Z");
  const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    await service.init();
    await service.store.write("market/calendar.json", [{ date: "2026-10-15", open: true }, { date: "2026-10-16", open: true }]);
    await service.store.write("market/ingestion/2026-10-15/initial/checkpoint.json", { status: "completed" });
    const id = createHash("sha256").update("fixture-only").digest("hex");
    await service.store.write(`market/request-budgets/${id}/state.json`, { nextAllowedAt: now.getTime() + 60000 });
    const check = await hunterPreflight(service, { kind: "initial", from: "2026-10-15", asOf: "2026-10-16" }, now);
    expect(check).toMatchObject({ limit: 60, rpm: 48, sessions: 2, cachedDays: 1, minimumRequests: 3, waitSeconds: 60, errors: [] });
    expect(check.warnings.join()).toContain("80営業日");
    vi.stubEnv("JQUANTS_REQUESTS_PER_MINUTE", "61");
    const bad = await hunterPreflight(service, { kind: "initial", from: "2020-01-01", asOf: "2026-10-16" }, now);
    expect(bad.errors.join()).toContain("1〜60");
    expect(bad.errors.join()).toContain("2021-10-17");
    expect((await hunterPreflight(service, { asOf: "2026-10-16" }, now)).minimumRequests).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
