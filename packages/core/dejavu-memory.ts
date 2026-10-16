import { dejavuMemorySchema } from "./dejavu-api-schema";

/** Remote search projection only. Local payload/original and retry text stay intact. */
export function projectDejavuMemory(memory: unknown): unknown {
  const parsed = dejavuMemorySchema.safeParse(memory);
  if (!parsed.success) return memory;
  const m = parsed.data;
  return {
    ...m,
    schemaVersion: 1,
    transportVersion: 2,
    text: `${m.providerCode} デジャヴ相場 OHLCV 類似 ${m.dataAsOf} ${m.payload.featureVersion}。${m.payload.examples.length}事例。原本参照ID ${m.recordId}。上昇確率ではありません。`,
  };
}
