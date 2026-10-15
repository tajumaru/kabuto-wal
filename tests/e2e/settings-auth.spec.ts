import { test, expect } from "@playwright/test";

test("本人確認済みでは認証の案内と開始ボタンを表示しない", async ({ page }) => {
  let expired = false;
  await page.route("**/api/status", (route) => route.fulfill(expired
    ? { status: 401, json: { error: "セッション期限切れ" } }
    : { json: { mode: "live" } }));
  await page.goto("/settings");
  const panel = page.locator("#owner-wallet");
  await expect(panel.getByText("本人確認済み", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "本人確認を始める" })).toHaveCount(0);
  await expect(panel.getByText("MemWalの連携設定は「接続状態」で確認できます。", { exact: false })).toBeVisible();

  expired = true;
  await page.reload();
  await expect(panel.getByRole("button", { name: "本人確認を始める" })).toBeVisible();
  await expect(panel.getByText("本人確認済み", { exact: true })).toHaveCount(0);
});

test("デモでのAPIアクセス成功を本人確認済みと表示しない", async ({ page }) => {
  await page.goto("/settings");
  const panel = page.locator("#owner-wallet");
  await expect(panel.getByRole("button", { name: "本人確認を始める" })).toBeVisible();
  await expect(panel.getByText("本人確認済み", { exact: true })).toHaveCount(0);
});

test("接続解除でログアウトし、本人確認の画面に戻る", async ({ page }) => {
  let loggedOut = false;
  await page.route("**/api/status", (route) => route.fulfill(loggedOut
    ? { status: 401, json: { error: "本人確認が必要です" } }
    : { json: { mode: "live" } }));
  await page.route("**/api/auth/logout", async (route) => {
    expect(route.request().method()).toBe("POST");
    loggedOut = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings");
  const panel = page.locator("#owner-wallet");
  await panel.getByRole("button", { name: "ウォレット接続解除" }).click();
  await expect(panel.getByRole("button", { name: "本人確認を始める" })).toBeVisible();
  await expect(panel.getByText("本人確認済み", { exact: true })).toHaveCount(0);
  expect(loggedOut).toBe(true);
});
