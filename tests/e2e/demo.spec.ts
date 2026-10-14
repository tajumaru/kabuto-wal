import { test, expect } from "@playwright/test";
test("監視追加→詳細→類似→予測→期限後検証→記憶とチャット根拠", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("KABUTO WAL");
  const logo = page.getByRole("img", { name: "KABUTO WAL 正式ブランドロゴ" });
  await expect(logo).toBeVisible();
  await expect(logo).toHaveJSProperty("complete", true);
  expect(
    await logo.evaluate(
      (img: HTMLImageElement) =>
        img.complete && img.naturalWidth === 1254 && img.naturalHeight === 1254,
    ),
  ).toBe(true);
  const manifest = await (
    await page.request.get("/manifest.webmanifest")
  ).json();
  expect(manifest.name).toBe("KABUTO WAL");
  for (const icon of manifest.icons) {
    expect((await page.request.get(icon.src)).ok()).toBe(true);
  }
  expect((await page.request.get("/brand/favicon.ico")).ok()).toBe(true);
  expect((await page.request.get("/brand/icon-180.png")).ok()).toBe(true);
  await expect(page.getByText("DEMO · 架空データ")).toBeVisible();
  await page.getByRole("combobox", { name: "銘柄", exact: true }).fill("130A");
  await page
    .getByRole("option", { name: "130A 架空テクノロジー", exact: true })
    .click();
  await page.getByRole("button", { name: "＋ 監視に追加" }).click();
  await expect(
    page.getByRole("heading", { name: "架空テクノロジー" }),
  ).toBeVisible({ timeout: 120000 });
  await page.getByRole("heading", { name: "架空テクノロジー" }).click();
  await expect(page.getByText("調整済み終値", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "類似相場を探す" }).click();
  await expect(page.getByText(/走査候補/)).toBeVisible();
  await page.goto("/predictions");
  await page.getByLabel("予測基準日").fill("2026-08-03");
  await page.getByRole("button", { name: "予測を生成" }).click();
  await expect(page.getByText("72030 · 5営業日先")).toBeVisible();
  await page.getByRole("button", { name: "期限後の検証" }).click();
  await expect(page.getByText(/ゼロ予測誤差/).first()).toBeVisible();
  await page.goto("/memories");
  const memoryText = "E2E方針：出来高が減るときは慎重に判断する " + Date.now();
  await page.getByLabel("新しい記憶").fill(memoryText);
  await page.getByRole("button", { name: "記憶を保存" }).click();
  await expect(
    page.getByText(memoryText, {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/chat");
  await page.getByLabel("質問").fill("前の方針を振り返りたい");
  await page.getByRole("button", { name: "質問する →" }).click();
  await expect(page.getByText(/recordId:/).first()).toBeVisible();
  await page.goto("/settings");
  await expect(
    page.getByText("暗号化バックアップ", { exact: true }),
  ).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "架空テクノロジー" }),
  ).toBeVisible();
  await expect(page.getByText("DEMO · 架空データ")).toBeVisible();
  await page.screenshot({
    path: "test-results/home-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(logo).toBeVisible();
  await expect(page.locator(".header-brand")).toBeVisible();
  const logoBox = await logo.boundingBox();
  expect(logoBox!.width).toBeCloseTo(logoBox!.height, 0);
  await page.screenshot({
    path: "test-results/home-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
