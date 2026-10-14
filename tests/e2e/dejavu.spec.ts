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
  await page.getByLabel("基準日", { exact: true }).fill("2019-01-04");
  await expect(page.getByRole("alert")).toContainText("連続20営業日日足が不足");
});
