import { test, expect } from "@playwright/test";

test("価格更新の通信切断を案内し、再試行できる", async ({ page }) => {
  let fail = true;
  await page.route("**/api/crypto/watch", async (route) => {
    if (route.request().method() === "POST" && fail) return route.abort("failed");
    return route.fulfill({ json: { assets: [], fetchedAt: null } });
  });
  await page.goto("/");
  const panel = page.locator(".crypto-watch");
  await panel.getByRole("button", { name: "価格を取得" }).click();
  await expect(panel.getByRole("alert")).toContainText("アプリのサーバーに接続できません");
  fail = false;
  await panel.getByRole("button", { name: "価格を取得" }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("価格更新の認証切れを案内する", async ({ page }) => {
  await page.route("**/api/crypto/watch", (route) => route.fulfill(
    route.request().method() === "POST"
      ? { status: 401, json: { error: "セッション期限切れ" } }
      : { json: { assets: [], fetchedAt: null } },
  ));
  await page.goto("/");
  const panel = page.locator(".crypto-watch");
  await panel.getByRole("button", { name: "価格を取得" }).click();
  await expect(panel.getByRole("alert")).toContainText("設定画面で本人確認をやり直してください");
});
