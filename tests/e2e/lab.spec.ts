import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
test("研究所は明示確認・独立方式・固定分割・Test封印・320px表示を維持する", async ({
  page,
}) => {
  const response = await page.request.get(
      "/api/bottom/hunter/cohorts?pageSize=100",
    ),
    cohorts = (await response.json()).records.filter(
      (r: { datasetId: string }) => r.datasetId.startsWith("fixture-"),
    );
  expect(cohorts).toHaveLength(3);
  await page.goto("/research/lab");
  await expect(
    page.getByRole("heading", { name: "かぶまるAI研究所", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "確認した設定で実験開始", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("固定コホートID（空白区切り）")
    .fill(cohorts.map((c: { cohortId: string }) => c.cohortId).join("\n"));
  for (const [k, from, to] of [
    ["training", "2024-01-01", "2024-03-01"],
    ["validation", "2024-04-01", "2024-06-01"],
    ["test", "2024-07-01", "2024-09-01"],
  ]) {
    await page.getByLabel(`${k} from`, { exact: true }).fill(from);
    await page.getByLabel(`${k} to`, { exact: true }).fill(to);
  }
  const planResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/research/lab/plans") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "検証計画を固定する", exact: true })
    .click();
  const saved = await planResponse;
  expect(saved.ok(), await saved.text()).toBe(true);
  await expect(page.getByLabel("保存済み検証計画")).not.toHaveValue("");
  await page.getByLabel("方式名", { exact: true }).fill("E2E実験");
  await page
    .getByRole("button", { name: "実験方式を保存", exact: true })
    .click();
  await expect(page.getByLabel("保存済み方式")).not.toHaveValue("");
  await page
    .getByLabel("設定・分割・過学習の注意を確認し、実験を開始します")
    .check();
  await page
    .getByRole("button", { name: "確認した設定で実験開始", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "かぶまる実験レポート", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("標本不足のため優劣は判断できません。", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "実験記憶をローカル保存", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "ローカル記憶：pending" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "実験記憶をMemWal同期", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "manifest hashを確認", exact: true })
    .click();
  await expect(page.getByText("SHA-256：", { exact: false })).toBeVisible();
  await page.getByLabel("検証区間", { exact: true }).selectOption("test");
  await page
    .getByRole("button", { name: "確認した設定で実験開始", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "封印" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 568 });
  const url = page.url(),
    samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "かぶまる実験レポート", exact: true }),
    ).toBeVisible();
    samples.push(+(performance.now() - start).toFixed(2));
  }
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.getByLabel("方式名", { exact: true }).focus();
  await page.screenshot({
    path: "test-results/lab-mobile.png",
    fullPage: true,
  });
  const sorted = [...samples].sort((a, b) => a - b);
  await writeFile(
    "test-results/lab-mobile-performance.json",
    JSON.stringify(
      {
        viewport: "320x568 Chromium",
        samplesMs: samples,
        medianMs: sorted[2],
        minMs: sorted[0],
        maxMs: sorted[4],
      },
      null,
      2,
    ),
  );
});
