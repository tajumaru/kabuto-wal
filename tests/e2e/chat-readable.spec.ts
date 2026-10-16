import { test, expect } from "@playwright/test";

test("参照資料と記録IDを開いても横に広がらず、保存済みJSONを日本語で読める", async ({ page }) => {
  await page.route("**/api/chat", (route) => route.fulfill({ json: {
    recordId: "chat-fixture", question: "この銘柄について前に何を心配していた？",
    model: "local-grounded", search: "memwal-semantic",
    answer: "関連する記録が見つかりました。下の参照資料を確認してください。現在はローカル応答のため、記録をもとに自由な文章で分析する外部AIは使用していません。",
    evidence: [{ recordId: "a".repeat(500), text: `予測（仮説） 2026-10-14→2026-10-15 : ${JSON.stringify({ predictedReturn: -0.00065, sampleCount: 45, evaluation: { actualReturn: 0.00463, directionMatch: true, revisionIds: ["b".repeat(1000)] } })}` }],
  } }));
  await page.goto("/chat");
  await page.getByRole("button", { name: "質問する" }).click();
  const message = page.locator(".chatmessage");
  await expect(message).toContainText("当時の心配事や方針を書いた記録は見つかりませんでした");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await message.locator("details").first().evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await message.getByText("記録ID", { exact: true }).click();
    await expect(message).toContainText("予測した値動き：-0.07%");
    await expect(message).toContainText("実際の値動き：+0.46%");
    await expect(message).not.toContainText("predictedReturn");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await message.getByText("記録ID", { exact: true }).click();
  }
});
