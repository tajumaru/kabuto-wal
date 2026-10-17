import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { analyzeBottom } from "../apps/api/src/bottom";
import { classifyBottom } from "../packages/core/hunter";
import { hunterScenario, scenarioNames } from "../fixtures/hunter-scenarios";
it("人工相場の判定時点の分類・点数・リスクを固定し、将来の成功失敗を分離する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hunter-patterns-"));
  const service = new Service(root, "demo", false);
  try {
    await service.init();
    const results = {} as Record<string, { score: number | null; category: string; risks: string[] }>;
    for (const name of scenarioNames) {
      if (name === "missing") { expect(() => hunterScenario(name)).toThrow("連続営業日"); continue; }
      const f = hunterScenario(name);
      const a = await analyzeBottom(service, "72030", f.asOf, new Date("2026-10-10"), { cutoff: f.cutoff, series: f.series });
      results[name] = { score: a.score, category: classifyBottom(a).category, risks: a.riskCodes };
      expect(a.inputRevisionIds).not.toContain("future-revision");
    }
    expect(results).toMatchSnapshot();
    expect(results["false-rebound"]).toEqual(results.revision);
    expect(hunterScenario("false-rebound").futureReturn20).toBeLessThan(0);
    expect(hunterScenario("revision").futureReturn20).toBeGreaterThan(0);
    expect(results.short.category).toBe("判定不能");
    
    expect(results.halt.risks).toContain("no_trading_volume");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
