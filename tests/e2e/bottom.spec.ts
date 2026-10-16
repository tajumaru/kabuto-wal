import { test, expect } from "@playwright/test";

test("個別底打ち解析の根拠・過去基準日・既存デジャヴ導線", async ({ page }) => {
  await page.goto("/bottom?code=72030&asOf=2026-10-09");
  await expect(
    page.getByRole("heading", { name: "底打ち研究", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "条件ごとの得点" }),
  ).toBeVisible();
  await expect(page.locator(".bottom-table tbody tr")).toHaveCount(10);
  await expect(
    page
      .locator(".bottom-research")
      .getByText("DEMO · 架空データ", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/bottom-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("基準日", { exact: true }).fill("2026-08-03");
  await page.goBack();
  await expect(page.getByLabel("基準日", { exact: true })).toHaveValue("2026-10-09");
  await page.goForward();
  await expect(page.getByLabel("基準日", { exact: true })).toHaveValue("2026-08-03");
  await expect(
    page.getByRole("link", { name: "この銘柄のデジャヴ相場を見る" }),
  ).toHaveAttribute("href", "/similar?code=72030&asOf=2026-08-03");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "条件ごとの得点" }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  await page.getByRole("button", { name: "ナイトモードに切り替える" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "test-results/bottom-mobile-dark.png",
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "この銘柄のデジャヴ相場を見る" })
    .click();
  await expect(page.getByLabel("基準日", { exact: true })).toHaveValue(
    "2026-08-03",
  );
  await expect(
    page.getByRole("heading", { name: "デジャヴ未来シナリオ", exact: true }),
  ).toBeVisible();
});
