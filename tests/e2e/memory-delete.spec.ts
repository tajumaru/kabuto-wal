import { test, expect } from "@playwright/test";

test("直接削除済みの記憶は旧V1の切替と再削除を表示せず、索引確認を残す", async ({ page }) => {
  await page.route("**/api/memories", route => route.fulfill({ json: [{ recordId: "a".repeat(64), text: "削除済みの方針", active: false, kind: "user_memory", createdAt: "2026-10-14T00:00:00Z", sync: { status: "deleted", blobId: "deleted-blob", directWalrusDeletion: { state: "completed", digest: "tx" } } }] }));
  await page.route("**/api/memory-delete/config", route => route.fulfill({ json: { enabled: true, owner: "0x123", network: "mainnet" } }));
  await page.route("**/api/memory-reset/availability", route => route.fulfill({ json: { available: true } }));
  await page.goto("/memories");
  await page.getByRole("button", { name: "blob削除済み・検索索引を確認" }).click();
  const panel = page.getByRole("region", { name: "MemWalから記憶を削除" });
  await expect(panel).toContainText("Walrusのblob削除済みです");
  await expect(page.getByLabel("旧V1のSecurity Delete APIを使用する")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /署名して|対象blobと削除取引/ })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "削除結果を確認" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "保存区分の検索索引削除を開く" })).toBeEnabled();
  await panel.screenshot({ path: "test-results/delete-panel.png" });
});

test("無効化を残し、保存済み記憶だけにMemWal削除の確認画面を開く", async ({ page }) => {
  const memories = [
    { recordId: "11111111-1111-4111-8111-111111111111", text: "保存済みの方針", kind: "user_memory", active: true, createdAt: "2026-10-14T00:00:00Z", sync: { status: "synced", blobId: "selected-blob" } },
    { recordId: "22222222-2222-4222-8222-222222222222", text: "未同期の方針", kind: "user_memory", active: true, createdAt: "2026-10-14T00:00:00Z", sync: { status: "pending" } },
  ];
  const mutations: string[] = [];
  await page.route("**/api/memories", (route) => route.fulfill({ json: memories }));
  await page.route("**/api/memory-delete/config", (route) => route.fulfill({ json: { enabled: true, owner: "0x123", network: "mainnet" } }));
  await page.route("**/remote-delete/**", (route) => { mutations.push(route.request().url()); return route.abort(); });
  await page.goto("/memories");
  const stored = page.locator("article.memory").filter({ hasText: "保存済みの方針" });
  const pending = page.locator("article.memory").filter({ hasText: "未同期の方針" });
  await expect(stored.getByRole("button", { name: "無効化", exact: true })).toBeEnabled();
  await expect(pending.getByRole("button", { name: "MemWalから削除", exact: true })).toBeDisabled();
  await stored.getByRole("button", { name: "MemWalから削除", exact: true }).click();
  const panel = page.getByRole("region", { name: "MemWalから記憶を削除" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".memory-note")).toHaveText("保存済みの方針");
  await expect(panel.getByText("対象blob：selected-blob", { exact: true })).not.toBeVisible();
  await panel.getByText("削除対象の詳細（元データ・ID）", { exact: true }).click();
  await expect(panel.getByText("対象blob：selected-blob", { exact: true })).toBeVisible();
  await expect(panel).toContainText("元に戻せません");
  await expect(panel.getByRole("button", { name: "対象blobと削除取引を確認" })).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await expect(panel.getByRole("button", { name: "対象blobと削除取引を確認" })).toBeDisabled();
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test("分析JSONは銘柄・基準日・件数で要約し、元データは折りたたむ", async ({ page }) => {
  const payload = { providerCode: "94320", asOf: "2026-10-13", examples: [{ start: "2024-06-01", end: "2024-06-30", revisionIds: ["internal-revision-id"] }] };
  await page.route("**/api/master", (route) => route.fulfill({ json: [{ providerCode: "94320", name: "テスト通信" }] }));
  await page.route("**/api/memories", (route) => route.fulfill({ json: [{ recordId: "a".repeat(64), kind: "dejavu_memory", text: JSON.stringify(payload), providerCode: "94320", active: true, createdAt: "2026-10-14T00:00:00Z", sync: { status: "synced", blobId: "analysis-blob" } }] }));
  await page.route("**/api/memory-delete/config", (route) => route.fulfill({ json: { enabled: true, owner: "0x123", network: "mainnet" } }));
  await page.goto("/memories");
  await page.getByRole("button", { name: "MemWalから削除", exact: true }).click();
  const panel = page.getByRole("region", { name: "MemWalから記憶を削除" });
  await expect(panel.getByRole("heading", { name: "テスト通信（9432）" })).toBeVisible();
  await expect(panel.getByText("分析基準日：2026-10-13", { exact: true })).toBeVisible();
  await expect(panel.getByText("過去の似た値動きを1件まとめた分析記憶です。", { exact: true })).toBeVisible();
  await expect(panel.locator("pre")).not.toBeVisible();
  await panel.getByText("削除対象の詳細（元データ・ID）", { exact: true }).click();
  await expect(panel.locator("pre")).toContainText("internal-revision-id");
  await expect(panel.locator("pre")).toBeVisible();
});
