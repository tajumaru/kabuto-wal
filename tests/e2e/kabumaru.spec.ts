import { test, expect } from "@playwright/test";
test("6画像・通知・チャットの状態・明示保存・モバイル・動き軽減", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/api/assistant", (route) =>
    route.fulfill({
      json: {
        mode: "demo",
        notices: [
          {
            recordId: "fixture-notice",
            kind: "price_down",
            pose: "warning",
            providerCode: "72030",
            dataAsOf: "2026-10-09",
            mode: "demo",
            title: "テストデータの下落を検出",
            text: "2026-10-09の取得日足、72030、前営業日比-6.00%。fixtureに基づくテスト通知です。",
            metrics: { change: -0.06 },
            evidenceIds: ["fixture"],
            href: "/stocks/72030",
          },
        ],
        note: "取得済みデータによる通知です。",
      },
    }),
  );
  await page.goto("/");
  const launcher = page.getByRole("button", {
    name: "カブまるAIチャットを開く",
    exact: true,
  });
  await expect(launcher).toBeVisible();
  for (const pose of [
    "idle",
    "discover",
    "analyze",
    "thinking",
    "happy",
    "warning",
  ]) {
    const r = await page.request.get(
      `/characters/kabumaru/kabumaru_${pose}.png`,
    );
    expect(r.ok()).toBe(true);
    expect(r.headers()["content-type"]).toContain("image/png");
  }
  await expect(page.locator(".kabumaru")).toHaveAttribute(
    "data-pose",
    "warning",
  );
  await launcher.click();
  const panel = page.getByRole("dialog", { name: "カブまるAIアシスタント" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("DEMO・架空データ · 2026-10-09 · 7203"),
  ).toBeVisible();
  const picker = panel.getByRole("combobox", { name: "銘柄", exact: true });
  await picker.fill("7203");
  await panel
    .getByRole("option", { name: "7203 架空モビリティ", exact: true })
    .click();
  await page.route("**/api/stocks/72030/features", async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.fulfill({ json: { sessionDate: "2026-10-09" } });
  });
  await page.route("**/api/chat", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await panel.getByLabel("カブまるへの質問").fill("過去の分析を比較して");
  await panel
    .getByRole("button", { name: "カブまるに聞く", exact: true })
    .click();
  await expect(page.locator(".kabumaru")).toHaveAttribute(
    "data-pose",
    "analyze",
  );
  await expect(page.locator(".kabumaru")).toHaveAttribute(
    "data-pose",
    "thinking",
  );
  await expect(
    panel.getByText("過去の分析を比較して", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".kabumaru")).toHaveAttribute("data-pose", "idle");
  await panel.getByRole("button", { name: "この会話を記憶に保存" }).click();
  await expect(
    panel.getByText(
      "会話をローカルへ保存しました。MemWal同期は接続・外部送信許可に従います。",
    ),
  ).toBeVisible();
  await panel.getByRole("button", { name: "すべて既読にする" }).click();
  await expect(page.locator(".kabumaru-badge")).toHaveCount(0);
  await expect(panel.locator(".kabumaru-notice")).toHaveCount(0);
  await expect(panel.getByText("未読のお知らせはありません。")).toBeVisible();
  await panel
    .getByRole("button", { name: "カブまるを閉じる", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  const launcherBox = await launcher.boundingBox();
  const nav = await page.locator("aside").boundingBox();
  expect(launcherBox!.y + launcherBox!.height).toBeLessThan(nav!.y);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  expect(
    await launcher
      .locator("img")
      .evaluate((img) => getComputedStyle(img).animationName),
  ).toBe("none");
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".kabumaru-notice")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/kabumaru-mobile-dark.png",
    fullPage: true,
  });
  await panel.press("Escape");
  await expect(panel).not.toBeVisible();
  expect(errors.filter((message) => message.includes("same key"))).toEqual([]);
});
