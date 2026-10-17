import type { Service } from "./service";
import { researchResultSchema, type ResearchResult } from "../../../packages/core/kabumaru-research-schema";
import { deterministicResearch } from "./kabumaru-explanation";
import { verifyEvidence } from "./kabumaru-evidence";

export async function cachedResearch(service: Service, key: string): Promise<ResearchResult | null> {
  const saved = researchResultSchema.safeParse(await service.store.read(`research/cache/${key}.json`, null));
  return saved.success && saved.data.evidence.every(verifyEvidence) && JSON.stringify(saved.data.explanation) === JSON.stringify(deterministicResearch(saved.data.evidence)) ? saved.data : null;
}
export async function cacheResearch(service: Service, key: string, result: ResearchResult) {
  await service.store.lock(() => service.store.write(`research/cache/${key}.json`, researchResultSchema.parse(result)));
}
