import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
test("研究エージェントは明示承認・復元・遅延Evidence・320px画面を維持する", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  let evidenceReads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/agent/sessions/") && r.url().includes("/evidence?"))
      evidenceReads++;
  });
  await page.goto("/research/agent");
  await page
    .getByRole("button", { name: "研究セッションを作成", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "研究セッション", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "研究計画を提案", exact: true })
    .click();
  const approve = page.getByRole("button", {
    name: "この計画を承認する",
    exact: true,
  });
  await expect(approve).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "承認済み研究を開始", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel(
      "目的・固定データ・回数・時間上限・失敗時の処理を確認し、表示した計画だけを承認します",
    )
    .check();
  await approve.click();
  await page
    .getByRole("button", { name: "承認済み研究を開始", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "研究結果と振り返り", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  expect(evidenceReads).toBe(0);
  await expect(
    page.getByRole("button", { name: "研究記憶をMemWal同期", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "研究manifest hashを生成", exact: true })
    .click();
  await page
    .getByRole("button", { name: "ローカル原本と照合", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "ローカル原本のhashと対象が一致" }),
  ).toBeVisible();
  await page
    .getByText("計画のEvidence（必要時に読み込み）", { exact: true })
    .click();
  await expect.poll(() => evidenceReads).toBeGreaterThan(0);
  const url = page.url(),
    samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "研究結果と振り返り", exact: true }),
    ).toBeVisible();
    samples.push(+(performance.now() - start).toFixed(2));
  }
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.getByRole("textbox", { name: "研究目的", exact: true }).click();
  await page.screenshot({
    path: "test-results/agent-mobile.png",
    fullPage: true,
  });
  const sorted = [...samples].sort((a, b) => a - b);
  await writeFile(
    "test-results/agent-mobile-performance.json",
    JSON.stringify(
      {
        viewport: "320x568 Chromium; synthetic/demo; warm local server",
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
