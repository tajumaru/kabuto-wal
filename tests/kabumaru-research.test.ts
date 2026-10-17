import { predictionSchema } from "../packages/core/index";
import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { seedHunterRaw } from "./hunter-fixture";
import { recordHunterForecast, evaluateHunterDue, hunterId } from "../apps/api/src/hunter-journal";
import { buildKabumaruResearch, registerKabumaruResearch } from "../apps/api/src/kabumaru-research";
import { researchEvidence, verifyEvidence } from "../apps/api/src/kabumaru-evidence";
import { deterministicResearch, validateResearchExplanation } from "../apps/api/src/kabumaru-explanation";
import { explainWithResearchLlm, externalResearchPayload, ConfiguredResearchLlm } from "../apps/api/src/kabumaru-llm";
import { researchEvidenceSchema, researchResultSchema } from "../packages/core/kabumaru-research-schema";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const bottom = () => researchEvidence({ kind: "bottom", sourceId: "private-source-marker", asOf: "2026-10-09", cutoff: "2026-10-09T14:59:59.999Z",
  methodVersion: "bottom-rule-v1", revisionIds: ["private-revision-marker"], limitations: ["private-limitation-marker"], facts: {
    score: 85, category: "反転兆候あり", status: "ready", metConditions: ["rsi_recovery", "volume_rebound"], unmetConditions: ["above_sma20"],
    risks: ["long_trend_down"], rsi: 35, drawdown: -0.3, volumeRatio: 2, continuousSessions: 80 } });

it("Evidenceを厳格に検証し、存在しないID・勝手な数値・断定を拒否する", () => {
  const e = bottom(), catalog = deterministicResearch([e]);
  expect(verifyEvidence(e)).toBe(true);
  expect(researchEvidenceSchema.safeParse({ ...e, wallet: "private" }).success).toBe(false);
  const altered = structuredClone(e); if (altered.kind === "bottom") altered.facts.score = 99;
  expect(verifyEvidence(altered)).toBe(false);
  expect(() => deterministicResearch([altered])).toThrow("Evidence ID");
  const wrong = structuredClone(catalog); wrong.statements[0].text = "99点なので必ず上がる";
  expect(() => validateResearchExplanation(wrong, catalog)).toThrow("未検証");
  const ids = structuredClone(catalog); ids.statements[0].evidenceIds = ["f".repeat(64)];
  expect(() => validateResearchExplanation(ids, catalog)).toThrow("未検証");
  expect(() => validateResearchExplanation({ statements: catalog.statements.filter(s => s.section !== "uncertainty") }, catalog)).toThrow("注意事項");
  const payload = JSON.stringify(externalResearchPayload([e], "why"));
  expect(payload).not.toContain("private-");
  expect(payload).not.toContain("revisionIds");
  expect(payload).toContain("85");
  expect(() => new ConfiguredResearchLlm("http://bad.invalid")).toThrow("HTTPS");
});

it("送信許可なしではプロバイダーを呼ばず、タイムアウト・捏造をローカルへ戻す", async () => {
  const e = bottom(), explanation = deterministicResearch([e]);
  const result = researchResultSchema.parse({ schemaVersion: 1, researchId: "b".repeat(64), code: "72030", asOf: e.asOf, cutoff: e.cutoff,
    analysisId: "fixture", jobId: null, evidenceIds: [e.evidenceId], inputRevisionIds: e.revisionIds, explanationMethodVersion: "kabumaru-grounded-v1",
    generatedAt: "2026-10-09T15:00:00.000Z", mode: "demo", dataCoverage: null, evidence: [e], explanation,
    reliability: "データ取得不完全", warnings: [], question: "why", provider: "deterministic", memorySearch: "local" });
  const input = { code: "72030", provider: "configured-llm", question: "why", allowExternalLlm: true };
  const generateExplanation = vi.fn().mockResolvedValue(explanation), provider = { generateExplanation };
  vi.stubEnv("RESEARCH_LLM_PROVIDER", "configured-llm");
  vi.stubEnv("ALLOW_MARKET_DATA_TO_LLM", "false"); vi.stubEnv("ALLOW_RESEARCH_DATA_TO_LLM", "true");
  expect((await explainWithResearchLlm(result, input, provider)).provider).toBe("deterministic");
  vi.stubEnv("ALLOW_MARKET_DATA_TO_LLM", "true"); vi.stubEnv("ALLOW_RESEARCH_DATA_TO_LLM", "false");
  await explainWithResearchLlm(result, input, provider);
  vi.stubEnv("ALLOW_RESEARCH_DATA_TO_LLM", "true");
  await explainWithResearchLlm(result, { ...input, allowExternalLlm: false }, provider);
  expect(generateExplanation).not.toHaveBeenCalled();
  expect((await explainWithResearchLlm(result, input, provider)).provider).toBe("configured-llm");
  const timed = await explainWithResearchLlm(result, input, { generateExplanation: () => new Promise(() => {}) }, 15);
  expect(timed.provider).toBe("deterministic"); expect(timed.warnings.join()).toContain("戻しました");
  const wrong = structuredClone(explanation); wrong.statements[0].text = "99%で上がる";
  generateExplanation.mockResolvedValue(wrong);
  expect((await explainWithResearchLlm(result, input, provider)).provider).toBe("deterministic");
});

it("過去時点の原本と評価を照合し、後日記憶・削除記憶・未来の評価を除外する", async () => {
  vi.stubEnv("JQUANTS_PLAN", "Light");
  const root = await mkdtemp(path.join(os.tmpdir(), "kabumaru-research-"));
  const service = new Service(root, "live", false);
  try {
    await service.init(); const f = await seedHunterRaw(service, 160);
    const engine = new HunterJobs(service), prior = await engine.create({ asOf: f.asOf, from: f.from, cutoff: f.cutoff }); await engine.run(prior.id);
    const original = await recordHunterForecast(service, { code: "72030", jobId: prior.id }, new Date(`${f.asOf}T10:00:00.000Z`));
    const originals = await Promise.all(original.records.map(p => service.store.read(`predictions/${p.predictionId}/original.json`)));
    await service.store.lock(() => evaluateHunterDue(service, new Date("2026-10-09T13:00:00.000Z")));
    const job = await engine.create({ asOf: "2026-10-09", from: f.from, cutoff: "2026-10-09T14:59:59.999Z" }); await engine.run(job.id);
    const input = { code: "72030", jobId: job.id, asOf: "2026-10-09" };
    const scan=vi.spyOn(service,"predictions");
    const [first,simultaneous] = await Promise.all([buildKabumaruResearch(service, input),buildKabumaruResearch(service, input)]);
    expect(simultaneous.researchId).toBe(first.researchId);expect(scan).not.toHaveBeenCalled();scan.mockRestore();
    expect(first.evidence.filter(e => e.kind === "forecast")).toHaveLength(3);
    expect(first.evidence.filter(e => e.kind === "evaluation")).toHaveLength(3);
    expect(first.evidence.filter(e => e.kind === "memory")).toHaveLength(0); // Actual memory creation was later.
    expect(first.explanation.statements.some(s => s.text.includes("少数") || s.text.includes("標本数"))).toBe(true);
    expect(first.evidence.every(verifyEvidence)).toBe(true);
    const cached = await buildKabumaruResearch(service, input); expect(cached.generatedAt).toBe(first.generatedAt);
    const cacheFiles=await service.store.files("research/cache");
    for(const file of cacheFiles)await service.store.write(file,{invalid:"fixture"});
    expect((await buildKabumaruResearch(service,input)).researchId).toBe(first.researchId);
    const memory = (await service.store.all("memories")).find(m => m.kind === "hunter_reflection");
    await service.store.write(`memories/${memory.recordId}.json`, { ...memory, createdAt: "2026-10-09T13:01:00.000Z" });
    expect((await buildKabumaruResearch(service, input)).evidence.filter(e => e.kind === "memory")).toHaveLength(1);
    await service.store.write(`sync/${memory.recordId}.json`, { status: "deleted" });
    const recall = vi.fn().mockResolvedValue({ results: [{ text: JSON.stringify(memory), distance: 0 }] });
    vi.spyOn(service, "memoryProvider").mockResolvedValue({ recall, remember: vi.fn(), waitForRememberJob: vi.fn() });
    vi.stubEnv("ALLOW_MARKET_DATA_TO_MEMWAL", "false");
    await buildKabumaruResearch(service, { ...input, recallRemote: true }); expect(recall).not.toHaveBeenCalled();
    vi.stubEnv("ALLOW_MARKET_DATA_TO_MEMWAL", "true"); vi.stubEnv("JQUANTS_MEMWAL_RIGHTS_CONFIRMED", "true");
    expect((await buildKabumaruResearch(service, { ...input, recallRemote: true })).evidence.filter(e => e.kind === "memory")).toHaveLength(0);
    expect(recall).toHaveBeenCalledTimes(2);
    // A later evaluation cannot travel back with an earlier target date.
    const records = await service.predictions(), e = records[0].evaluations[0];
    await service.store.write(`evaluations/${records[0].predictionId}/${e.evaluationId}.json`, { ...e, createdAt: "2026-10-10T00:00:00.000Z" });
    expect((await buildKabumaruResearch(service, input)).evidence.filter(e => e.kind === "evaluation")).toHaveLength(2);
    await service.store.write(`evaluations/${records[0].predictionId}/${e.evaluationId}.json`, { ...e, predictionId: "wrong-original" });
    expect((await buildKabumaruResearch(service, input)).evidence.filter(e => e.kind === "evaluation")).toHaveLength(2);
    await service.store.write(`evaluations/${records[0].predictionId}/${e.evaluationId}.json`, { ...e, methodVersion: "different-method" });
    expect((await buildKabumaruResearch(service, input)).evidence.filter(e => e.kind === "evaluation")).toHaveLength(2);

    expect(await Promise.all(original.records.map(p => service.store.read(`predictions/${p.predictionId}/original.json`)))).toEqual(originals);
    const none = await buildKabumaruResearch(service, { code: "99990", asOf: "2026-10-08" });
    expect(none.reliability).toBe("根拠不足"); expect(none.explanation.statements[0].text).toContain("確認できません");
    await expect(buildKabumaruResearch(service, { ...input, asOf: "2026-10-08" })).rejects.toThrow("基準日");
    const app = Fastify(); registerKabumaruResearch(app, service);
    try {
      const diagnostic = (await app.inject({ method: "POST", url: "/api/research/diagnostics", payload: input })).json();
      expect(diagnostic.externalCalls).toBe(0); expect(diagnostic.inputRevisionIds.length).toBeGreaterThan(0);
      expect(diagnostic.seriesConsistent).toBe(true); expect(diagnostic.adjustmentVersion).toBe("raw-factor-asof-v1");
      expect(Object.values(diagnostic.scoreBands).reduce((n: number,v) => n+Number(v),0)).toBe(2);
      const reportResponse=await app.inject({method:"GET",url:`/api/research/outcomes?jobId=${job.id}`});
      expect(reportResponse.statusCode).toBe(200);
      const report=reportResponse.json();expect(report.control.ready).toBe(report.control.candidates+report.control.nonCandidates);
      expect(report.groups.reduce((n:number,g:{evaluated:number})=>n+g.evaluated,0)).toBe(2);
      const saved = (await app.inject({ method: "POST", url: "/api/research/save", payload: input })).json();
      await service.store.write(`sync/${saved.recordId}.json`, { status: "deleted" });
      await service.store.write(`memories/${saved.recordId}.json`, { ...(await service.store.read(`memories/${saved.recordId}.json`)), active: false });
      expect((await app.inject({ method: "POST", url: "/api/research/save", payload: input })).json().recordId).toBe(saved.recordId);
      expect((await service.store.read(`sync/${saved.recordId}.json`)).status).toBe("deleted");
      expect((await service.store.read(`memories/${saved.recordId}.json`)).active).toBe(false);
    } finally { await app.close(); }
    const legacyId = hunterId(["legacy-dejavu"]), base = original.records.find(p => p.predictionId === records[0].predictionId)!;
    const legacy = predictionSchema.parse({ ...base, predictionId: legacyId, recordId: legacyId, hunter: undefined, methodVersion: "dejavu-consensus-v1",
      dejavu: { schemaVersion: 1, compareCode: base.providerCode, asOf: base.dataAsOf, evaluationStatus: "pending", sourceDejavuRecordId: "legacy-fixture",
        dataCutoff: base.hunter!.cutoff, consensusScore: null, weightedReturn: null, medianReturn: base.predictedReturn, upRatio: base.pUp,
        percentileRange: base.returnQuantiles, exampleIds: base.candidateIds, selection: "fixture", dnaSummary: "fixture" } });
    await service.store.write(`predictions/${legacyId}/original.json`, legacy, true);
    await service.store.write(`predictions/${legacyId}/state.json`, { status: "evaluated" });
    await service.store.write(`evaluations/${legacyId}/${e.evaluationId}.json`, { ...e, predictionId: legacyId, methodVersion: "dejavu-consensus-v1" }, true);
    const legacyResearch = await buildKabumaruResearch(service, input);
    expect(legacyResearch.evidence.some(e => e.kind === "forecast" && e.methodVersion === "dejavu-consensus-v1" && e.facts.score === null)).toBe(true);
    expect(legacyResearch.evidence.some(e => e.kind === "evaluation" && e.methodVersion === "dejavu-consensus-v1")).toBe(true);
    expect(legacyResearch.explanation.statements.some(s => s.text.includes("底打ち条件の記録がなく"))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
