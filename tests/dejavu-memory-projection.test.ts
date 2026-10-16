import { expect, it } from "vitest";
import { projectDejavuMemory } from "../packages/core/dejavu-memory";
import { dejavuMemorySchema, dejavuMemoriesSchema, dejavuResultSchema } from "../packages/core/dejavu-api-schema";

it("旧記憶を読める投影を作り、ローカル原本を変更せず冗長な系列を送信しない", () => {
  const original = { kind: "dejavu_memory", active: true, recordId: "a".repeat(64), mode: "research", providerCode: "72030", namespace: "kabutowal:dejavu:v1:research:72030", createdAt: "2026-10-01T00:00:00.000Z", dataAsOf: "2026-10-01", text: "x".repeat(20000), payload: { recordId: "a".repeat(64), asOf: "2026-10-01", mode: "research", providerCode: "72030", featureVersion: "ohlcv-20-v1", examples: [{ start: "2020-01-01", end: "2020-01-31", score: 90, shape: Array(20).fill(100) }] } };
  const before = JSON.stringify(original);
  const projected = projectDejavuMemory(original);
  expect(dejavuMemorySchema.parse(projected)).toMatchObject({ recordId: original.recordId, payload: { examples: [{ score: 90 }] } });
  expect(dejavuMemorySchema.safeParse(original).success).toBe(true);
  expect(JSON.stringify(projected).length).toBeLessThan(before.length / 5);
  expect(JSON.stringify(original)).toBe(before);
  expect(projectDejavuMemory({ kind: "user_memory", text: "hello" })).toEqual({ kind: "user_memory", text: "hello" });
});
it("API境界は空配列を許可し、不正な値・null応答を拒否する", () => {
  expect(dejavuMemoriesSchema.parse({ search: "local-demo", memories: [] }).memories).toEqual([]);
  expect(dejavuMemoriesSchema.safeParse(null).success).toBe(false);
  expect(dejavuResultSchema.safeParse({ consensus: null, dna: [] }).success).toBe(false);
});
