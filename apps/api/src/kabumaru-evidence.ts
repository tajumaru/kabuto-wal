import { researchEvidenceSchema, type ResearchEvidence } from "../../../packages/core/kabumaru-research-schema";
import { hash } from "../../../packages/integrations/adjusted-series";

export function researchEvidence(input: Omit<ResearchEvidence, "evidenceId">): ResearchEvidence {
  // ID binds the complete validated facts and limitations, not an LLM-generated label.
  const normalized = researchEvidenceSchema.parse({ ...input, evidenceId: "0".repeat(64) });
  const body = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== "evidenceId"));
  return researchEvidenceSchema.parse({ ...body, evidenceId: hash(body) });
}
export function verifyEvidence(e: ResearchEvidence) {
  return researchEvidence(e).evidenceId === e.evidenceId;
}
