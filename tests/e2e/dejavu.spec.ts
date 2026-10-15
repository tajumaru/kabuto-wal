import { test, expect } from "@playwright/test";
test("デジャヴ相場の比較・明示記憶・通知・モバイル表示", async ({ page }) => {
  await page.goto("/similar?code=72030");
  await expect(
    page.getByRole("heading", { name: "カブまるのデジャヴ相場" }),
  ).toBeVisible();
  await expect(page.getByText("DEMO · 架空OHLCV")).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "類似度 / 内訳" }),
  ).toBeVisible();
  for (const heading of [
    "デジャヴ未来シナリオ",
    "かぶまるの解説",
    "デジャヴDNA",
    "過去の予測と答え合わせ",
    "MemWal反省ノート",
  ]) {
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "20営業日", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "20営業日", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("基準日", { exact: true }).fill("2026-08-03");
  await page
    .getByRole("button", { name: "このデジャヴから予測を記録" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "1・5・20営業日の仮説を記録しました" }),
  ).toBeVisible({ timeout: 120000 });
  await expect(page.locator(".dejavu-journal article")).toHaveCount(3);
  await page
    .getByRole("button", { name: "期限後の答え合わせ", exact: true })
    .click();
  await expect(page.locator(".dejavu-journal")).toContainText("方向", {
    timeout: 120000,
  });
  // Reflections created today are excluded from the historical as-of view.
  await page.getByLabel("基準日", { exact: true }).fill("");
  await expect(page.locator(".dejavu-reflection")).toHaveCount(3);
  await expect(page.locator(".recharts-line-curve").first()).toHaveAttribute(
    "d",
    /^M/,
  );
  await page.screenshot({
    path: "test-results/dejavu-desktop.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: "このデジャヴ相場を記憶する" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "このデジャヴ相場を記憶する" })
    .click();
  await expect(
    page.getByText("デモの記憶をローカル保存しました。外部送信しません。"),
  ).toBeVisible();
  await page.getByText("保存したデジャヴ相場を検索", { exact: true }).click();
  await expect(page.getByText("デモのローカル記憶")).toBeVisible();
  await page.getByRole("button", { name: "カブまるAIチャットを開く" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("カブまるのデジャヴ相場を見つけたよ")
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "カブまるを閉じる", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/dejavu-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "ナイトモードに切り替える" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/dejavu-mobile-theme.png",
    fullPage: true,
  });
  await page.getByLabel("基準日", { exact: true }).fill("2019-01-04");
  await expect(
    page.getByRole("heading", { name: "日足データの準備が必要です" }),
  ).toBeVisible();
});
