import { test, expect } from "@playwright/test";
test("コード検索・銘柄名検索・未知コード・キーボード選択", async ({ page }) => {
  await page.goto("/");
  const input = page.getByRole("combobox", { name: "銘柄", exact: true });
  await input.fill("７２０３");
  await expect(
    page.getByRole("option", { name: "7203 架空モビリティ", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "＋ 監視に追加" }),
  ).toBeDisabled();
  await input.press("Enter");
  await expect(
    page.getByText("選択中：7203 架空モビリティ", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "＋ 監視に追加" }),
  ).toBeEnabled();
  await input.fill("not-a-stock");
  await expect(
    page.getByText(
      "該当する銘柄がありません。コードや銘柄名を確認してください。",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "＋ 監視に追加" }),
  ).toBeDisabled();
  await input.fill("エンターテインメント");
  await input.press("Enter");
  await expect(
    page.getByText("選択中：6758 架空エンターテインメント", { exact: true }),
  ).toBeVisible();
  await input.fill("130a");
  await input.press("Enter");
  await expect(
    page.getByText("選択中：130A 架空テクノロジー", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill("7203");
  await expect(
    page.getByRole("option", { name: "7203 架空モビリティ", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
