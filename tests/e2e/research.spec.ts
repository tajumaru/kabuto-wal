import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test("ハンターから研究し、根拠付きの質問・ローカル保存・iPhone幅表示を確認", async ({ page }) => {
  const launched = await page.request.post("/api/bottom/hunter/jobs", { data: { asOf: "2026-10-09", cutoff: "2026-10-09T14:59:59.999Z" } });
  expect(launched.ok()).toBe(true);
  const job = await launched.json();
  await expect.poll(async () => (await (await page.request.get(`/api/bottom/hunter/jobs/${job.id}`)).json()).status).toBe("completed");
  await page.goto(`/bottom/hunter?asOf=2026-10-09&jobId=${job.id}`);
  await page.locator(".hunter-desktop tbody tr").filter({ hasText: "架空モビリティ" }).getByText("その他", { exact: true }).click();
  await page.locator(".hunter-desktop tbody tr").filter({ hasText: "架空モビリティ" }).getByRole("link", { name: "かぶまるに研究してもらう" }).click();
  await expect(page).toHaveURL(/\/research\?.*code=72030/);
  await expect(page.getByRole("heading", { name: "かぶまるAI研究員", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "研究サマリー", exact: true })).toBeVisible();
  await expect(page.locator(".kabumaru-bubble")).toBeHidden();
  await expect(page.locator(".research-evidence")).toHaveCount(0);
  await page.getByRole("button",{name:"根拠一覧を表示",exact:true}).click();
  await expect(page.locator(".research-evidence > details")).not.toHaveCount(0);
  const source = page.locator(".research-evidence > details").first(); await source.locator("summary").first().click();
  await expect(source).toContainText("取得締切：2026-10-09");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "この銘柄のリスクは？", exact: true }).click();
  await expect(page.getByRole("heading", { name: "この銘柄のリスクは？", exact: true })).toBeVisible();
  await expect(page.getByText("説明方式：deterministic", { exact: false })).toBeVisible();
  expect((await (await page.request.get("/api/research/chats")).json()).records).toHaveLength(0);
  await page.getByLabel("質問と回答をこの端末のJSONに保存").check();
  await page.getByRole("button", { name: "過去の予測は当たった？", exact: true }).click();
  await expect(page.getByRole("heading", { name: "過去の予測は当たった？", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/research/chats")).json()).records.length).toBe(1);
  await page.getByText("保存・関連記憶・任意の外部説明", { exact: true }).click();
  await expect(page.getByRole("button", { name: "設定済みLLMで根拠文を構成", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "研究要約をローカル保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "ローカルに要約を保存" })).toBeVisible();
  await page.screenshot({ path: "test-results/kabumaru-research-mobile.png", fullPage: true });
  await page.goto("/research?code=99990&asOf=2026-10-08");
  await expect(page.getByText("根拠不足", { exact: true })).toBeVisible();
  await expect(page.getByText("対象銘柄の走査済み根拠がなく、確認できません。", { exact: false })).toBeVisible();
});

test("研究画面の反復表示・狭幅・質問の通信抑止を測定する",async({page})=>{
  await page.setViewportSize({width:375,height:667});
  const samples:number[]=[];
  for(let i=0;i<5;i++){
    const start=performance.now();await page.goto("/research?code=72030&asOf=2026-10-09");
    await expect(page.getByRole("heading",{name:"研究サマリー",exact:true})).toBeVisible();
    samples.push(+(performance.now()-start).toFixed(2));
  }
  let calls=0;page.on("request",r=>{if(/\/api\/research(?:\/chat)?$/.test(r.url()))calls++;});
  await page.getByRole("button",{name:"この銘柄のリスクは？",exact:true}).click();
  await expect(page.getByRole("heading",{name:"この銘柄のリスクは？",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"どの条件が変わったら評価が変わる？",exact:true}).click();
  expect(calls).toBe(0);
  await page.setViewportSize({width:320,height:568});
  await page.getByLabel("研究の基準日").focus();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const start=performance.now();await page.getByRole("button",{name:"根拠一覧を表示",exact:true}).click();
  await expect(page.getByRole("heading",{name:"根拠一覧",exact:true})).toBeVisible();
  const evidenceMs=+(performance.now()-start).toFixed(2),sorted=[...samples].sort((a,b)=>a-b);
  const result={viewport:"375x667 / 320x568",samplesMs:samples,medianMs:sorted[2],minMs:sorted[0],maxMs:sorted[4],evidenceMs};
  console.log(`research performance ${JSON.stringify(result)}`);
  await writeFile("test-results/research-performance.json",JSON.stringify(result,null,2));
});
