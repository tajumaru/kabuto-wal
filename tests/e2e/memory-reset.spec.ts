import { test, expect } from "@playwright/test";

test("全区分と原本が残る説明を確認し、確認文入力後だけ実行できる", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: { mode: "live" } }));
  const plan = { id: "11111111-1111-4111-8111-111111111111", state: "prepared", namespaces: [{ name: "kabutowal:v1:profile", memory_count: 2, state: "pending" }, { name: "other-app", memory_count: 3, state: "pending" }] };
  let executions = 0;
  await page.route("**/api/memory-reset/preview", (route) => route.fulfill({ json: plan }));
  await page.route("**/api/memory-reset/execute", (route) => {
    executions++;
    expect(route.request().postDataJSON()).toEqual({ planId: plan.id, confirmation: "検索リセット" });
    return route.fulfill({ json: { ...plan, state: "completed", namespaces: plan.namespaces.map((ns) => ({ ...ns, state: "completed", deleted: ns.memory_count })) } });
  });
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "MemWal検索リセット" });
  await expect(panel).toContainText("暗号化された原本は残ります");
  await expect(panel).toContainText("他のアプリから保存した記憶も対象");
  await panel.getByRole("button", { name: "対象を確認", exact: true }).click();
  await expect(panel).toContainText("other-app");
  await expect(panel).toContainText("検索用データ：5件");
  const execute = panel.getByRole("button", { name: "確認した全区分の検索用データをリセット" });
  await expect(execute).toBeDisabled();
  await panel.getByLabel("検索リセットの確認").fill("検索リセット");
  await expect(execute).toBeEnabled();
  expect(executions).toBe(0);
  await execute.click();
  await expect(panel.getByRole("status")).toContainText("全区分の検索リセットが完了");
  expect(executions).toBe(1);
  await expect(execute).toHaveCount(0);
});

test("デモでは検索リセットの対象確認を実行できない", async ({ page }) => {
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "MemWal検索リセット" });
  await expect(panel.getByRole("button", { name: "対象を確認", exact: true })).toBeDisabled();
  await expect(panel).toContainText("本人確認を完了すると利用できます");
});
