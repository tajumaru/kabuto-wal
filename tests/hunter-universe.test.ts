import { expect, it } from "vitest";
import { classifyMaster } from "../apps/api/src/hunter-universe";
import { classifyBottom, compareHunterRows } from "../packages/core/hunter";
import type { BottomAnalysis } from "../packages/core/bottom-schema";
import type { HunterRow } from "../packages/core/hunter-schema";
it("公式商品区分と予備コードだけで普通株を採用し、分類不明を推測しない", () => {
  const row = { Code: "130A0", CoName: "test", Date: "2026-10-09", Mkt: "0111", ProdCat: "011" };
  expect(classifyMaster(row, row.Date).included).toBe(true);
  for (const extra of [{ ProdCat: undefined }, { ProdCat: "014" }, { ProdCat: "013" }, { ProdCat: "021" }, { ProdCat: "012" }, { Code: "130A1" }, { Mkt: "0109" }]) expect(classifyMaster({ ...row, ...extra }, row.Date).included).toBe(false);
});
it("前提なしの高得点を候補にせず、警戒とスコアを分離する", () => {
  const a = { status: "ready", riskCodes: [], candidatePrerequisite: false, indicators: { return5: 0 }, conditions: Array.from({ length: 10 }, () => ({ met: true })) } as unknown as BottomAnalysis;
  expect(classifyBottom(a).candidate).toBe(false);
  expect(classifyBottom({ ...a, candidatePrerequisite: true })).toEqual({ category: "反転兆候あり", candidate: true });
  expect(classifyBottom({ ...a, candidatePrerequisite: true, riskCodes: ["high_volatility"] }).category).toBe("警戒");
  expect(compareHunterRows({ candidate: true, category: "底固め観察", score: 60, code: "10000" } as HunterRow, { candidate: false, category: "反発進行中", score: 100, code: "10010" } as HunterRow)).toBeLessThan(0);
});
