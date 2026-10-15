import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { demoBars } from "../fixtures/demo";
import { marketNotices } from "../packages/core/assistant";
import { Service } from "../apps/api/src/service";
import { collectNotices, recordSimilar } from "../apps/api/src/assistant";
import { createApp } from "../apps/api/src/server";
import { similar } from "../packages/core/index";
it("実績の急変・出来高だけを根拠付きで検出し、欠損・異なる調整系列は除外", () => {
  const bars = demoBars("72030")
    .slice(-21)
    .map((b) => ({ ...b, adjClose: 100, volume: 100, seriesId: "same" }));
  bars[20] = { ...bars[20], adjClose: 106, volume: 220 };
  const notifications = marketNotices("72030", "対象株", bars, "live");
  expect(notifications.map((n) => n.kind)).toEqual([
    "price_up",
    "volume_spike",
  ]);
  expect(notifications[0].metrics.change).toBeCloseTo(0.06);
  expect(notifications[0].dataAsOf).toBe(bars[20].sessionDate);
  expect(notifications[1].evidenceIds).toHaveLength(21);
  expect(marketNotices("72030", "対象株", [], "live")).toEqual([]);
  bars[20].adjClose = 94;
  expect(marketNotices("72030", "対象株", bars, "demo")[0]).toMatchObject({
    pose: "warning",
    mode: "demo",
    source: "fixture",
  });
  bars[20].seriesId = "different";
  expect(marketNotices("72030", "対象株", bars, "live")).toEqual([]);
});
it("通知をJSONで永続化し再確認で重複しない・監視変更も記録", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kabumaru-feed-"));
  try {
    const service = new Service(root, "demo", false);
    await service.init();
    expect((await collectNotices(service)).notices).toEqual([]);
    const bars = demoBars("72030")
      .slice(-21)
      .map((b) => ({ ...b, adjClose: 100, volume: 100 }));
    bars[20].adjClose = 110;
    await service.store.write("prices/72030/fixture.json", bars);
    const w = await service.store.read("settings/watchlist.json");
    await service.store.write("settings/watchlist.json", {
      ...w,
      codes: ["72030"],
    });
    const first = await collectNotices(service);
    expect(first.notices.some((n) => n.kind === "watch_added")).toBe(true);
    expect(first.notices.some((n) => n.kind === "price_up")).toBe(true);
    expect(
      (await collectNotices(service)).notices.map((n) => n.recordId),
    ).toEqual(first.notices.map((n) => n.recordId));
    await new Service(root, "demo", false).init();
    expect((await collectNotices(service)).notices).toHaveLength(
      first.notices.length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("過去基準日の類似結果を正しい日付で保存し検索対象にする", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kabumaru-similar-"));
  try {
    const service = new Service(root, "demo", false);
    await service.init();
    const bars = demoBars("72030"),
      date = bars[1400].sessionDate;
    await service.store.write("prices/72030/fixture.json", bars);
    const result = similar(bars, date);
    await recordSimilar(service, "72030", result, date);
    await recordSimilar(service, "72030", result, date);
    const notifications = await service.store.all("notifications");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].dataAsOf).toBe(date);
    expect((await service.memories())[0].namespace).toBe(
      "kabutowal:v1:market:72030",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("会話は明示保存時のみ長期記憶へ追加し、参照IDを維持する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kabumaru-chat-"));
  const service = new Service(root, "demo", false);
  const app = await createApp(service);
  try {
    const event = (
      await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { question: "過去の考えは？" },
      })
    ).json();
    expect(await service.memories()).toEqual([]);
    expect(event.search).toBe("local-demo");
    const result = await app.inject({
      method: "POST",
      url: "/api/assistant/save-chat",
      payload: { eventId: event.recordId },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().kind).toBe("saved_chat");
    expect((await service.memories()).length).toBe(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/assistant/save-chat",
          payload: { eventId: "../outside" },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
