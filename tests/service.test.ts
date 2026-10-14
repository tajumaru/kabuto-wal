import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
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
  await rm(root, { recursive: true, force: true });
});
it("訂正revision、再実行と価格値が元へ戻る場合でも原本を保持", async () => {
  const bars = demoBars("72030").slice(-2);
  await service.saveBars(bars);
  const first = await service.history("72030");
  await service.saveBars(bars);
  expect(await service.history("72030")).toEqual(first);
  await service.saveBars([{ ...bars[0], close: 999, adjClose: 999 }]);
  expect(
    await service.store.files(`revisions/72030/${bars[0].sessionDate}`),
  ).toHaveLength(2);
  await service.saveBars([bars[0]]);
  expect((await service.history("72030"))[0].close).toBe(bars[0].close);
  expect(
    await service.store.files(`revisions/72030/${bars[0].sessionDate}`),
  ).toHaveLength(2);
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
