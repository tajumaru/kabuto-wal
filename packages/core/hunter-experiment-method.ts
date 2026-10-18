import { BOTTOM_CONFIG } from "./bottom-score";
import { labFeatures, type LabMethod } from "./hunter-experiment-schema";
import type { CohortMember } from "./hunter-cohort-schema";
export const labDefaultWeights = Object.fromEntries(
  labFeatures.map((k, i) => [k, BOTTOM_CONFIG.weights[i]]),
) as LabMethod["parameters"];
// Conditions are the frozen boolean features produced by bottom-rule-v1, not future returns.
export function rescoreLabMember(member: CohortMember, method: LabMethod) {
  if (!member.eligible || member.score === null)
    return {
      status: "excluded" as const,
      reason: "not-analyzable",
      score: null,
      candidate: false,
    };
  if (
    member.featureVersion !== method.featureVersion ||
    member.scoringMethodVersion !== method.parentMethodVersion ||
    !member.inputRevisionIds.length ||
    new Set(member.conditions).size !== member.conditions.length ||
    member.conditions.some(
      (c) => !(labFeatures as readonly string[]).includes(c),
    )
  )
    return {
      status: "excluded" as const,
      reason: "features-not-reproducible",
      score: null,
      candidate: false,
    };
  const original = labFeatures.reduce(
    (n, k, i) =>
      n + (member.conditions.includes(k) ? BOTTOM_CONFIG.weights[i] : 0),
    0,
  );
  if (original !== member.score)
    return {
      status: "excluded" as const,
      reason: "baseline-score-mismatch",
      score: null,
      candidate: false,
    };
  const total = Object.values(method.parameters).reduce((a, b) => a + b, 0),
    score =
      (100 *
        labFeatures.reduce(
          (n, k) =>
            n + (member.conditions.includes(k) ? method.parameters[k] : 0),
          0,
        )) /
      total;
  // Baseline candidate safety gates stay fixed. Experiments can only narrow this population.
  return {
    status: "ready" as const,
    reason: null,
    score,
    candidate: member.candidate && score >= method.candidateThreshold,
  };
}
