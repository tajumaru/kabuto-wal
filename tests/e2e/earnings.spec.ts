import { test, expect } from "@playwright/test";
test("企業材料チェックはニュースと独立し、DEMOの取得操作は外部通信しない", async ({page}) => {
  const seed = await page.request.post("/__test__/scout",{data:{}});expect(seed.ok()).toBe(true);
  const external:string[]=[];
  page.on("request",r=>{if(!new URL(r.url()).hostname.match(/^(localhost|127\.0\.0\.1)$/))external.push(r.url());});
  try {
    await page.goto("/chat");await page.getByRole("button",{name:"カブまるAIチャットを開く"}).click();
    const dialog=page.getByRole("dialog",{name:"カブまるAIアシスタント"});
    await dialog.getByLabel("カブまるへの質問",{exact:true}).fill("1000の底打ちを確認して");
    await dialog.getByRole("button",{name:"カブまるに聞く",exact:true}).click();
    const check=dialog.getByRole("region",{name:"企業材料チェック"}).first();
    await expect(check).toBeVisible();await expect(check).toContainText("ニュース未確認");await expect(check).toContainText("未取得");
    await dialog.getByRole("button",{name:"決算情報を取得",exact:true}).first().click();
    await expect(dialog.getByRole("status").filter({hasText:"DEMOでは外部通信しません"})).toBeVisible();
    await expect(check).toContainText("ニュース未確認");expect(external).toEqual([]);
    await page.setViewportSize({width:320,height:568});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await check.scrollIntoViewIfNeeded();
    await check.screenshot({path:"test-results/earnings-materials-mobile.png"});
  } finally {await page.request.post("/__test__/scout",{data:{reset:true}});}
});

test("決算専用画面は保存済み銘柄を選び、明示操作するまで取得しない",async({page})=>{
  let acquisitions=0;
  page.on("request",r=>{if(r.method()==="POST"&&r.url().includes("/earnings/")&&r.url().endsWith("/acquire"))acquisitions++;});
  await page.goto("/research/earnings");
  await expect(page.getByRole("heading",{name:"かぶまる決算チェック",exact:true})).toBeVisible();
  const picker=page.getByRole("combobox",{name:"銘柄",exact:true});
  await picker.fill("7203");await page.getByRole("option").first().click();
  await expect(page.getByRole("button",{name:"決算情報を取得",exact:true})).toBeEnabled();expect(acquisitions).toBe(0);
  await page.getByRole("button",{name:"決算情報を取得",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"DEMOでは外部通信しません"})).toBeVisible();expect(acquisitions).toBe(1);
  await page.setViewportSize({width:320,height:568});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:"test-results/earnings-check-320.png",fullPage:true});
});

test("モック取得診断はAPI・保存・hash照合と対象データなしを別々に表示",async({page})=>{
  const timestamp="2025-11-03T00:00:00.000Z";
  const check={status:"checked",reason:"保存原本を検証",checkedAt:timestamp,source:"jquants-v2",revisions:[],evidence:[]};
  await page.route("**/api/research/earnings/72030",r=>r.fulfill({json:{cutoff:timestamp,earnings:check,schedule:{...check,status:"no-data",reason:"対象データなし"},news:{status:"unchecked",reason:"ニュース未取得"},latestDisclosure:{date:"2025-11-01",time:"15:00:00",number:"202511010001",period:"2025-04-01〜2025-09-30",revision:"a".repeat(64)},nextEarningsDate:null,comments:["売上高は110円。"]}}));
  await page.route("**/api/research/earnings/72030/acquire",r=>r.fulfill({json:{status:"success",results:["summary","earnings-date"].map((endpoint,i)=>({endpoint,status:"success",reason:i?"対象データなし":"取得完了",errorCode:null,fetched:true,saved:true,hashVerified:true,rowCount:i?0:1,fetchedAt:timestamp,revision:"a".repeat(64)}))}}));
  await page.goto("/research/earnings?code=72030");
  await page.getByRole("button",{name:"決算情報を取得",exact:true}).click();
  const result=page.getByRole("region",{name:"決算取得の診断結果"});await expect(result).toContainText("決算サマリー：取得成功");await expect(result).toContainText("決算発表予定日：対象データなし");await expect(result).toContainText("hash照合：成功");
  await page.getByText("かぶまるの決算メモ",{exact:true}).click();await expect(page.getByText("売上高は110円。",{exact:true})).toBeVisible();
});

test("銘柄切替後に以前の取得回答を表示しない",async({page})=>{
  let finish!:()=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  await page.route("**/api/research/earnings/72030/acquire",async r=>{entered();await gate;await r.fulfill({json:{status:"disabled",reason:"以前の銘柄の回答"}});});
  await page.goto("/research/earnings?code=72030");await page.getByRole("button",{name:"決算情報を取得",exact:true}).click();await started;
  await page.getByRole("combobox",{name:"銘柄",exact:true}).fill("6758");await page.getByRole("option").first().click();
  await expect(page).toHaveURL(/code=67580/);finish();
  await expect(page.getByRole("button",{name:"決算情報を取得",exact:true})).toBeEnabled();
  await expect(page.getByText("以前の銘柄の回答",{exact:true})).toHaveCount(0);
});
