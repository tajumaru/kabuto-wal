import { test, expect } from "@playwright/test";

for (const route of ["bottom", "similar"]) {
  test(`${route}: 直接URL・銘柄変更・履歴・不正パラメータ`, async ({ page }) => {
    await page.goto(`/${route}?code=72030&asOf=2026-10-09`);
    const picker = page.getByRole("combobox", { name: "銘柄", exact: true });
    await expect(page.getByLabel("基準日", { exact: true })).toHaveValue("2026-10-09");
    await picker.fill("6758");
    await picker.press("Enter");
    await expect(page).toHaveURL(url => url.pathname === `/${route}` && url.searchParams.get("code") === "67580" && url.searchParams.get("asOf") === "2026-10-09");
    await page.getByLabel("基準日", { exact: true }).fill("2026-08-03");
    await page.goBack();
    await expect(page.getByLabel("基準日", { exact: true })).toHaveValue("2026-10-09");
    await page.goForward();
    await expect(page.getByLabel("基準日", { exact: true })).toHaveValue("2026-08-03");
    let analyses = 0;
    page.on("request", request => {
      if (request.url().includes("/api/similar?") || request.url().includes("/api/bottom/analysis?")) analyses++;
    });
    await page.goto(`/${route}?code=../invalid&asOf=2026-02-30`);
    await expect(page.getByRole("alert")).toContainText("URLの銘柄コードまたは基準日が不正");
    expect(analyses).toBe(0);
  });
}
