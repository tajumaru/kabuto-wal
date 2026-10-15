import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { JQuants } from "../packages/integrations/index";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { snapshot } from "../apps/api/src/dejavu";
import { demoBars } from "../fixtures/demo";
import { assertMemwalAccount } from "../packages/integrations/sui";
import { OpenAiLlm } from "../packages/integrations/llm";
import { aggregate, walkForward } from "../packages/core/analysis";
let root: string, service: Service;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "stock-service-"));
  service = new Service(root, "live");
  await service.init();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it("手動取得は外部同期を待たず、同日の参照情報を共有しプラン変更時に更新する", async () => {
  vi.stubEnv("JQUANTS_API_KEY", "test-only");
  vi.stubEnv("JQUANTS_PLAN", "Light");
  const master = vi.spyOn(JQuants.prototype, "master").mockResolvedValue([{ Code: "72030", CoName: "test" }]);
  const calendar = vi.spyOn(JQuants.prototype, "calendar").mockResolvedValue([{ date: "2026-01-01", open: true }]);
  const daily = vi.spyOn(JQuants.prototype, "daily").mockResolvedValue([]);
  await service.store.write("settings/watchlist.json", { codes: ["72030"] });
  const memory = vi.spyOn(service, "memoryProvider").mockResolvedValue(null);
  for (let i = 0; i < 2; i++) {
    const job = await service.job({ syncMemory: false });
    expect(job.status).toBe("done");
    expect(job.steps).toContainEqual({ step: "memwal", status: "deferred" });
    expect(job.steps.find((s) => s.step === "prices")).toMatchObject({ fetchMs: expect.any(Number), saveMs: expect.any(Number) });
  }
  expect(master).toHaveBeenCalledTimes(1);
  expect(calendar).toHaveBeenCalledTimes(1);
  expect(daily).toHaveBeenCalledTimes(2);
  expect(memory).not.toHaveBeenCalled();
  vi.stubEnv("JQUANTS_PLAN", "Standard");
  expect((await service.job()).status).toBe("done");
  expect(master).toHaveBeenCalledTimes(2);
  expect(memory).toHaveBeenCalledTimes(1);
});
it("訂正revision、再実行と価格値が元へ戻る場合でも原本を保持", async () => {
  const bars = demoBars("72030").slice(-2);
  await service.saveBars(bars);
  const first = await service.history("72030");
  await service.saveBars(bars);
  expect(await service.history("72030")).toEqual(first);
  await service.saveBars([{ ...bars[0], close: 999, adjClose: 999 }]);
  expect(
    await service.store.files("revisions/72030/content"),
  ).toHaveLength(2);
  await service.saveBars([bars[0]]);
  expect((await service.history("72030"))[0].close).toBe(bars[0].close);
  expect(
    await service.store.files("revisions/72030/content"),
  ).toHaveLength(3);
});
it("同じ価格の再取得は本体を共有し、取得日時と調整系列は保持する", async () => {
  const first = demoBars("72030").slice(-100).map((b) => ({
    ...b, availableAt: "2026-09-01T00:00:00Z", seriesId: "first",
  }));
  await service.saveBars(first);
  const second = first.map((b) => ({ ...b, availableAt: "2026-09-02T00:00:00Z", seriesId: "second" }));
  await service.saveBars(second);
  await service.saveBars(second);
  expect(await service.store.files("revisions/72030/content")).toHaveLength(1);
  expect(await service.store.files("revisions/72030/observations")).toHaveLength(2);
  expect(await snapshot(service, "72030", first[0].availableAt)).toEqual(
    (await service.history("72030")).map((b) => ({ ...b, availableAt: first[0].availableAt, seriesId: "first" })),
  );
  expect(await snapshot(service, "72030", second[0].availableAt)).toEqual(await service.history("72030"));
  await service.store.write("revisions/72030/legacy.json", {
    ...first[0], adjClose: 999, availableAt: "2026-08-01T00:00:00Z",
  });
  expect((await snapshot(service, "72030", "2026-08-02T00:00:00Z"))[0].adjClose).toBe(999);
  const backup = await service.store.export("test-password-long-enough");
  const restored = new Service(path.join(root, "restored"), "live");
  await restored.store.import(backup, "test-password-long-enough");
  expect(await snapshot(restored, "72030", second[0].availableAt)).toEqual(await service.history("72030"));
});
it("元予測の重複生成防止・評価追記・訂正評価・再起動保持", async () => {
  const bars = demoBars("72030");
  await service.store.write("prices/72030/fixture.json", bars);
  await service.store.write(
    "market/calendar.json",
    bars.map((b) => ({ date: b.sessionDate, open: true })),
  );
  const p = await service.forecast("72030", 5, "2026-08-03");
  expect((await service.forecast("72030", 5, "2026-08-03")).predictionId).toBe(
    p.predictionId,
  );
  expect(await service.evaluateDue()).toBe(1);
  expect(await service.evaluateDue()).toBe(0);
  const target = bars.find((b) => b.sessionDate === p.targetSessionDate)!;
  target.adjClose = target.adjClose! * 1.1;
  target.revisionId = "correction";
  await service.store.write("prices/72030/fixture.json", bars);
  expect(await service.evaluateDue()).toBe(1);
  expect(await service.store.all(`evaluations/${p.predictionId}`)).toHaveLength(
    2,
  );
  expect(
    await service.store.read(`predictions/${p.predictionId}/original.json`),
  ).toEqual(p);
  const restart = new Service(root, "live");
  await restart.init();
  expect(await restart.predictions()).toHaveLength(1);
});
it("MemWal owner/delegate/type/activeを確認して不一致を拒否", () => {
  const object = {
    type: "0x1::account::MemWalAccount",
    json: {
      owner: "0x2",
      active: true,
      delegate_keys: [{ sui_address: "0x3" }],
    },
  };
  expect(assertMemwalAccount(object, "0x2", "0x3", "0x1").delegate).toBe("0x3");
  expect(() => assertMemwalAccount(object, "0x4", "0x3", "0x1")).toThrow();
  expect(() => assertMemwalAccount(object, "0x2", "0x4", "0x1")).toThrow();
  expect(() =>
    assertMemwalAccount(
      { ...object, json: { ...object.json, active: false } },
      "0x2",
      "0x3",
      "0x1",
    ),
  ).toThrow();
});
it("LLMの未検証参照IDを拒否", async () => {
  const mock = async () =>
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  answer: "根拠",
                  references: ["missing"],
                  numericClaims: [],
                }),
              },
            ],
          },
        ],
      }),
    );
  await expect(
    new OpenAiLlm("fake", "configured", mock).answer("質問", [
      { recordId: "known", text: "価格100" },
    ]),
  ).rejects.toThrow("参照ID");
});
it("期限・モード別集計とwalk-forwardは未来入力を除外", () => {
  const bars = demoBars("72030");
  const results = walkForward(bars, 5, 1000, 100);
  expect(results.rows.length).toBeGreaterThan(0);
  expect(results.rows.every((r) => r.sampleCount >= 20)).toBe(true);
  const groups = aggregate([
    {
      horizonSessions: 5,
      mode: "demo",
      methodVersion: "v1",
      state: { status: "pending" },
      evaluations: [],
    },
    {
      horizonSessions: 5,
      mode: "research",
      methodVersion: "v1",
      state: { status: "evaluated" },
      evaluations: [
        {
          returnError: 0.1,
          baselineError: -0.2,
          brier: 0.25,
          directionMatch: true,
          inRange: false,
        },
      ],
    },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[1].mae).toBe(0.1);
  expect(groups[1].baselineMae).toBe(0.2);
});
