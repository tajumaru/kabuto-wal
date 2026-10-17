import { z } from "zod";
export const HUNTER_METHOD = "bottom-hunter-v1";
export const HUNTER_FORECAST_METHOD = "bottom-hunter-hypothesis-v1";
export const hunterCategory = z.enum(["反転兆候あり", "底固め観察", "反発進行中", "警戒", "判定不能"]);

// Reporting bands only. Never change the historical scoring thresholds.
export function hunterScoreBand(score: number | null) {
  return score === null ? "unknown" : score < 40 ? "0-39" : score < 60 ? "40-59" : score < 80 ? "60-79" : "80-100";
}
export function hunterDistribution(values: number[]) {
  const sorted = [...values].sort((a,b) => a-b);
  const quantile = (q: number) => {
    if (!sorted.length) return null;
    const pos = (sorted.length-1)*q, i = Math.floor(pos);
    return sorted[i]+(sorted[Math.ceil(pos)]-sorted[i])*(pos-i);
  };
  return { min: sorted[0] ?? null, p25: quantile(0.25), median: quantile(0.5), p75: quantile(0.75), max: sorted.at(-1) ?? null };
}
