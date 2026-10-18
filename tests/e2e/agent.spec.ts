import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
test("エージェントの見出し・フォームが共通シェルと重ならない", async ({
  page,
}) => {
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/research/agent");
    await expect(
      page.getByRole("heading", {
        name: "かぶまる自律研究エージェント",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    const layout = await page.evaluate(() => {
      const hero = document
          .querySelector(".agent-header")!
          .getBoundingClientRect(),
        title = document
          .querySelector(".agent-header h1")!
          .getBoundingClientRect(),
        card = document
          .querySelector(".agent-page > section:nth-child(2)")!
          .getBoundingClientRect(),
        root = document.querySelector(".agent-page")!.getBoundingClientRect(),
        content = document.querySelector(".content")!.getBoundingClientRect();
      return {
        contained: title.top >= hero.top && title.bottom <= hero.bottom,
        below: card.top >= hero.bottom,
        wide: root.width >= content.width - 100,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(layout).toEqual({
      contained: true,
      below: true,
      wide: true,
      overflow: false,
    });
    await page.screenshot({
      path: `test-results/agent-layout-${width}.png`,
      fullPage: true,
    });
  }
});
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
  await page.getByRole("textbox", { name: "研究目的", exact: true }).click();
  await page
    .getByRole("button", { name: "このテーマで研究を作る", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "今回の研究", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "1. 何を調べたいですか？", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("region", { name: "操作ガイド" })).toContainText(
    "下の「研究の進め方」を選び",
  );
  await expect(
    page.getByLabel("研究所の判定ルールID", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("radio", { name: /^別の時期でも成績がよいか比べる/ })
    .check();
  await expect(
    page.getByRole("button", { name: "この内容で計画を作る", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "保存済みの設定から選ぶ", exact: true }),
  ).toBeVisible();
  await page
    .getByText("IDを直接入力する・研究ノートを指定する（任意）", {
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("研究所の判定ルールID", { exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /^保存した研究を読み返す/ }).check();
  await page
    .getByText("処理の上限を変更する（通常は変更不要）", { exact: true })
    .click();
  await expect(
    page.getByRole("spinbutton", {
      name: "調べるデータのまとまり（上限）",
      exact: true,
    }),
  ).toHaveValue("100");
  await expect(
    page.getByText("同じ基準日・取得条件で固定した銘柄群を1組と数えます。", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("コホート上限", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "この内容で計画を作る", exact: true })
    .click();
  const approve = page.getByRole("button", {
    name: "内容を確認して承認する",
    exact: true,
  });
  await expect(approve).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "研究計画と処理の上限", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/最大100組 ／ この計画では0組/)).toBeVisible();
  await page.screenshot({
    path: "test-results/agent-plan-320.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: "この計画で研究を始める", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel(
      "目的・固定データ・回数・時間上限・失敗時の処理を確認し、表示した計画だけを承認します",
    )
    .check();
  await approve.click();
  await page
    .getByRole("button", { name: "この計画で研究を始める", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "研究結果と振り返り", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  expect(evidenceReads).toBe(0);
  await page
    .getByText("研究記憶の保存・MemWal同期（任意）", { exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "研究記憶をMemWal同期", exact: true }),
  ).toBeDisabled();
  await page
    .getByText("研究証跡のhashを確認する（任意）", { exact: true })
    .click();
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
