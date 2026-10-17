import type { Service } from "./service";
import { researchResultSchema, type ResearchResult } from "../../../packages/core/kabumaru-research-schema";
import { deterministicResearch } from "./kabumaru-explanation";
import { verifyEvidence } from "./kabumaru-evidence";

export async function cachedResearch(service: Service, key: string): Promise<ResearchResult | null> {
  try {
    const saved = researchResultSchema.safeParse(await service.store.read(`research/cache/${key}.json`, null));
    if (!saved.success || !saved.data.evidence.every(verifyEvidence) || JSON.stringify(saved.data.explanation) !== JSON.stringify(deterministicResearch(saved.data.evidence))) return null;
    // Deletion wins even if a tombstone was written just after the index fingerprint.
    for (const e of saved.data.evidence) if (e.kind === "memory") {
      const m = await service.store.read<{ active?: boolean; remoteDeletedAt?: unknown }>(`memories/${e.sourceId}.json`,{});
      const s = await service.store.read<Record<string,unknown>>(`sync/${e.sourceId}.json`,{});
      if (!m.active || m.remoteDeletedAt || ["deleted","disabled"].includes(String(s.status)) || s.searchResetAt || s.blobDeletedAt || s.remoteDeletion || s.directWalrusDeletion) return null;
    }
    return saved.data;
  } catch { return null; } // Derived cache corruption never invalidates originals.
}
export async function cacheResearch(service: Service, key: string, result: ResearchResult) {
  await service.store.lock(() => service.store.write(`research/cache/${key}.json`, researchResultSchema.parse(result)));
}

const running = new WeakMap<Service, Map<string, Promise<ResearchResult>>>();
export async function singleResearch(service: Service, key: string, build: () => Promise<ResearchResult>) {
  let jobs = running.get(service); if (!jobs) { jobs = new Map(); running.set(service,jobs); }
  const existing = jobs.get(key); if (existing) return structuredClone(await existing);
  if (jobs.size >= 16) throw Error("研究処理が混み合っています。少し待って再実行してください。");
  const task = build(); jobs.set(key,task);
  try { return structuredClone(await task); } finally { jobs.delete(key); }
}
