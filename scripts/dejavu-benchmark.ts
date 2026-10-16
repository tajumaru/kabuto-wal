import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { demoBars, calendar } from "../fixtures/demo";
import { Service } from "../apps/api/src/service";
import { searchDejavu, snapshot } from "../apps/api/src/dejavu";
import { projectDejavuMemory } from "../packages/core/dejavu-memory";

// Fixtures only: never initialize an external provider or touch personal data.
const dir = await mkdtemp(path.join(os.tmpdir(), "kabuto-benchmark-"));
const service = new Service(dir, "demo", false);
try {
  const bars = demoBars("72030");
  await service.store.write("prices/72030/fixture.json", bars);
  await service.store.write("market/calendar.json", calendar());
  // Model repeated content observations without thousands of fsyncs.
  const { createHash } = await import("node:crypto");
  const contentId = createHash("sha256").update(JSON.stringify(bars)).digest("hex");
  await service.store.write("revisions/72030/content.json", { kind: "price_content", bars });
  for (let i = 0; i < 20; i++) await service.store.write(`revisions/72030/observation-${i}.json`, {
    kind: "price_observation", contentId, availableAt: bars.at(-1)!.availableAt,
    entries: bars.map(b => ({ sessionDate: b.sessionDate, availableAt: b.availableAt, seriesId: b.seriesId })),
  });
  const cutoff = bars.at(-1)!.availableAt;
  const samples: Record<string, number[]> = { snapshot: [], analysis: [] };
  for (let i = 0; i < 7; i++) {
    let start = performance.now();
    await snapshot(service, "72030", cutoff);
    samples.snapshot.push(performance.now() - start);
    start = performance.now();
    await searchDejavu(service, "72030", bars.at(-1)!.sessionDate);
    samples.analysis.push(performance.now() - start);
  }
  const result = await searchDejavu(service, "72030", bars.at(-1)!.sessionDate);
  console.log(JSON.stringify({ bars: bars.length, revisionRecords: 21, expandedRows: bars.length * 20,
    medianMs: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, [...v].sort((a,b) => a-b)[3]])),
    heapUsedBytes: process.memoryUsage().heapUsed,
    payloadBytes: Buffer.byteLength(JSON.stringify(result)),
    duplicatedPayloadAndTextBytes: Buffer.byteLength(JSON.stringify({ payload: result, text: JSON.stringify(result) })),
    projectedRemoteBytes: Buffer.byteLength(JSON.stringify(projectDejavuMemory({ kind: "dejavu_memory", active: true, createdAt: new Date().toISOString(), recordId: result.recordId, mode: result.mode, providerCode: result.providerCode, namespace: result.namespace, dataAsOf: result.asOf, text: JSON.stringify(result), payload: result }))),
  }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
