import { demoBars, calendar } from "./demo";
import { adjustedSeries, hash, type RawObservation } from "../packages/integrations/adjusted-series";

export const scenarioNames = ["v-recovery", "base-building", "false-rebound", "volume-reversal", "rsi-only", "split", "consolidation", "halt", "short", "missing", "revision"] as const;
export type Scenario = typeof scenarioNames[number];
export function hunterScenario(name: Scenario) {
  const template = demoBars("72030").slice(-80);
  const observations: RawObservation[] = template.map((b, i) => {
    let close = i < 74 ? 180 - 1.5*i : 70.5 + (i-73)*0.3;
    if (name === "v-recovery") close = i < 70 ? 180-i*1.5 : 75+(i-69)*3;
    if (name === "base-building") close = i < 60 ? 180-i*1.5 : 90+Math.sin(i)*0.2;
    if (name === "rsi-only") close = 180-i*1.2+(i%4 === 0 ? 0.2 : 0);
    const scale = name === "split" && i < 40 ? 2 : name === "consolidation" && i < 40 ? 0.5 : 1;
    const row = { Code: "72030", Date: b.sessionDate, O: (close-0.2)*scale, H: (close+0.5)*scale, L: (close-0.6)*scale, C: close*scale,
      Vo: name === "halt" && i === 79 ? 0 : name === "volume-reversal" && i === 79 ? 3000000 : 1000000,
      Va: 200000000, AdjFactor: i === 40 ? name === "split" ? 0.5 : name === "consolidation" ? 2 : 1 : 1, ExRT: "1" as const };
    return { row, observedAt: b.availableAt, revisionId: hash(row) };
  });
  if (name === "short") observations.splice(0, 20);
  if (name === "missing") observations.splice(60, 1);
  if (name === "revision") observations.push({ ...observations[79], row: { ...observations[79].row, C: 999, H: 1000 }, revisionId: "future-revision", observedAt: "2026-10-11T00:00:00.000Z" });
  const asOf = template[79].sessionDate, cutoff = `${asOf}T14:59:59.999Z`;
  return { asOf, cutoff, series: adjustedSeries(observations, "72030", asOf, cutoff, calendar()),
    // Identical observed prefixes can end in success or failure; outcome is not an input.
    futureReturn20: name === "false-rebound" ? -0.25 : 0.15 };
}
