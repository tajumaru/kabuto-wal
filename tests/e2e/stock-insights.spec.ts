import { test, expect } from "@playwright/test";

test("銘柄の記憶を共通メモと分け、期限別の最新予測と検証結果を表示する", async ({
  page,
}) => {
  const note = "決算前の出来高を確認する。".repeat(30);
  const memories = [
    {
      recordId: "own-note",
      kind: "user_memory",
      providerCode: "94320",
      active: true,
      text: note,
      createdAt: "2026-10-09T09:00:00Z",
    },
    {
      recordId: "pattern",
      kind: "dejavu_memory",
      providerCode: "94320",
      active: true,
      text: JSON.stringify({ examples: [{ score: 82 }] }),
      createdAt: "2026-10-10T09:00:00Z",
    },
    {
      recordId: "shared",
      kind: "user_memory",
      active: true,
      text: "全銘柄共通の投資メモ",
      createdAt: "2026-10-11T09:00:00Z",
    },
    {
      recordId: "other",
      kind: "user_memory",
      providerCode: "72030",
      active: true,
      text: "別銘柄の記憶",
      createdAt: "2026-10-12T09:00:00Z",
    },
    {
      recordId: "inactive",
      kind: "user_memory",
      providerCode: "94320",
      active: false,
      text: "利用停止の記憶",
      createdAt: "2026-10-13T09:00:00Z",
    },
  ];
  const base = {
    providerCode: "94320",
    dataAsOf: "2026-10-09",
    targetSessionDate: "2026-10-19",
    horizonSessions: 5,
    sampleCount: 25,
    reason: "過去の類似サンプルに基づく推定",
    evaluations: [],
  };
  const predictions = [
    {
      ...base,
      predictionId: "new",
      createdAt: "2026-10-10T09:00:00Z",
      predictedReturn: 0.025,
      evaluations: [{ actualReturn: -0.01 }],
    },
    {
      ...base,
      predictionId: "old",
      createdAt: "2026-10-09T09:00:00Z",
      predictedReturn: 0.8,
    },
    {
      ...base,
      predictionId: "one",
      horizonSessions: 1,
      createdAt: "2026-10-09T09:00:00Z",
      predictedReturn: 0.001,
    },
    {
      ...base,
      predictionId: "other",
      providerCode: "72030",
      createdAt: "2026-10-11T09:00:00Z",
      predictedReturn: 0.9,
    },
  ];
  await page.route("**/api/memories", (route) =>
    route.fulfill({ json: memories }),
  );
  await page.route("**/api/predictions", (route) =>
    route.fulfill({ json: predictions }),
  );
  await page.goto("/stocks/94320");
  const panel = page.getByRole("region", {
    name: "この銘柄の記憶と予測",
    exact: true,
  });
  await expect(
    panel.getByText("似た値動きの過去事例を1件保存", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(note, { exact: true })).not.toBeVisible();
  await expect(panel.getByText("別銘柄の記憶", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("利用停止の記憶", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByText("全銘柄共通の投資メモ", { exact: true }).first(),
  ).not.toBeVisible();
  await panel.getByText("全銘柄に共通するメモ（1件）", { exact: true }).click();
  await expect(
    panel.getByText("全銘柄共通の投資メモ", { exact: true }).first(),
  ).toBeVisible();
  await panel.getByText("全銘柄に共通するメモ（1件）", { exact: true }).click();
  await expect(panel.getByText("+2.50%", { exact: true })).toBeVisible();
  await expect(panel.getByText("実績 -1.00%", { exact: true })).toBeVisible();
  await expect(panel.getByText("+80.00%", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("未検証", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("予測はまだありません", { exact: true }),
  ).toBeVisible();
  await panel.screenshot({ path: "test-results/stock-insights-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await panel.screenshot({ path: "test-results/stock-insights-mobile.png" });
  await page.route("**/api/memories", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/predictions", (route) =>
    route.fulfill({ status: 500, json: { error: "fixture failure" } }),
  );
  await page.reload();
  await expect(
    panel.getByText("この銘柄だけに紐づく記憶はまだありません。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveText(
    "予測を読み込めませんでした。",
    { timeout: 30000 },
  );
  await expect(
    panel.getByText("予測はまだありません", { exact: true }),
  ).toHaveCount(0);
});
