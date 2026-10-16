import type { BottomAnalysis } from "./bottom-schema";
import { BOTTOM_CONFIG } from "./bottom-score";
import type { HunterRow } from "./hunter-schema";

// Classification supplements the unchanged ten-condition score; risks never add points.
export const HUNTER_CONFIG = { version: "hunter-classification-v1", reversalConditions: 3,
  advancedReturn5: 0.1, warningRisks: ["new_low", "high_volatility", "low_liquidity", "no_trading_volume"] } as const;
export function classifyBottom(a: BottomAnalysis) {
  if (a.status !== "ready") return { category: "判定不能", candidate: false } as const;
  if (a.riskCodes.some(r => (HUNTER_CONFIG.warningRisks as readonly string[]).includes(r))) return { category: "警戒", candidate: false } as const;
  const reversal = a.conditions.slice(2).filter(c => c.met).length;
  if ((a.indicators?.return5 ?? 0) >= HUNTER_CONFIG.advancedReturn5 || (a.indicators?.supportDistance ?? 0) > BOTTOM_CONFIG.farSupport)
    return { category: "反発進行中", candidate: false } as const;
  if (!a.candidatePrerequisite) return { category: reversal >= HUNTER_CONFIG.reversalConditions ? "反発進行中" : "底固め観察", candidate: false } as const;
  return { category: reversal >= HUNTER_CONFIG.reversalConditions ? "反転兆候あり" : "底固め観察", candidate: true } as const;
}
export function compareHunterRows(a: HunterRow, b: HunterRow) {
  return Number(b.candidate) - Number(a.candidate) || Number(b.category === "反転兆候あり") - Number(a.category === "反転兆候あり") || (b.score ?? -1) - (a.score ?? -1) || a.code.localeCompare(b.code);
}
export function explainBottom(a: BottomAnalysis) {
  if (a.status !== "ready") return `解析に必要なデータが不足しているよ（${a.reasonCodes.join("、")}）。推測では補わないよ。`;
  const met = a.conditions.filter(c => c.met).map(c => c.label);
  return `${a.score}点。${met.length ? met.slice(0, 3).join("、") : "反転条件の一致なし"}を確認したよ。${a.riskCodes.includes("long_trend_down") ? "まだ60日平均線の下で、長期平均も下降中だから注意してね。" : "リスクと少数事例も確認してね。"}スコアは的中確率ではないよ。`;
}
