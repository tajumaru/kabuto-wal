import { test, expect } from "@playwright/test";

test("保存の確定失敗を表示し、再試行を次回同期へ予約する", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  let pending = false;
  await page.route("**/api/memories", route => route.fulfill({ json: [{ recordId: id, active: true, text: "再試行する方針", kind: "user_memory", createdAt: "2026-10-16T00:00:00Z", sync: pending ? { status: "pending" } : { status: "failed", terminal: true, error: "保存ジョブが失敗しました。", jobId: "failed-job" } }] }));
  await page.route(`**/api/memories/${id}/sync-retry`, route => {
    expect(route.request().method()).toBe("POST");
    pending = true;
    return route.fulfill({ json: { status: "pending", note: "次回の同期で保存を再試行します。" } });
  });
  await page.goto("/memories");
  const memory = page.locator("article.memory").filter({ hasText: "再試行する方針" });
  await memory.getByText("保存データの詳細", { exact: true }).click();
  await expect(memory).toContainText("保存ジョブが失敗しました。");
  await memory.getByRole("button", { name: "失敗した保存を次回同期で再試行" }).click();
  await expect(memory).toContainText("MemWal同期待ち");
  await expect(memory.getByRole("button", { name: "失敗した保存を次回同期で再試行" })).toHaveCount(0);
});
