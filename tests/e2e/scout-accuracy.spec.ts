import { test,expect } from "@playwright/test";
test("予測の答え合わせは成功・失敗・不能を分け、期間や表示変更で再取得しない",async({page})=>{
 const seed=await page.request.post("/__test__/scout",{data:{outcomes:"mixed"}});expect(seed.ok(),await seed.text()).toBe(true);const {asOf}=await seed.json();
 try{
   await page.goto("/chat");await page.getByRole("button",{name:"カブまるAIチャットを開く"}).click();
   const dialog=page.getByRole("dialog",{name:"カブまるAIアシスタント"});
   await dialog.getByLabel("カブまるへの質問",{exact:true}).fill(`${asOf}の底打ち候補を5つ教えて`);
   await dialog.getByRole("button",{name:"カブまるに聞く",exact:true}).click();
   const response=page.waitForResponse(r=>r.url().includes("/api/research/scout/accuracy")&&r.ok());
   await dialog.getByRole("link",{name:"予測の答え合わせを見る →",exact:true}).click();
   const accuracy=await (await response).json(),group=accuracy.groups.find((g:{horizon:number})=>g.horizon===5);
   await expect(page.getByRole("heading",{name:"予測の答え合わせ",exact:true})).toBeVisible();
   expect(accuracy.predictions).toHaveLength(6);
   expect(accuracy.predictions.filter((p:{results:{horizon:number;status:string}[]})=>p.results.some(r=>r.horizon===5&&r.status==="unavailable"))).toHaveLength(1);
   await expect(page.locator(".accuracy-scope")).toContainText(`集計対象予測 ${accuracy.cumulative.included}件`);
   await expect(page.locator(".accuracy-kpi").first()).toContainText(`的中${group.hits} / 評価済み${group.evaluated}件`);
   await expect(page.locator(".accuracy-kpi").first()).toContainText("95%信頼区間");
   await expect(page.getByRole("heading",{name:"予測時点の相場環境別",exact:true})).toBeVisible();
   const calls:string[]=[];page.on("request",r=>{if(r.url().includes("/api/research/scout/accuracy"))calls.push(r.url());});
   await page.getByRole("combobox",{name:"評価期間",exact:true}).selectOption("5");
   await page.getByRole("combobox",{name:"結果の表示",exact:true}).selectOption("miss");
   await expect(page.locator(".accuracy-prediction")).toHaveCount(1);
   await page.getByText("予測の根拠・結果・かぶまるの振り返り",{exact:true}).click();
   await expect(page.locator(".accuracy-prediction")).toContainText("不的中");
   await expect(page.locator(".accuracy-prediction")).toContainText("RSI（14日）");
   expect(calls).toEqual([]);
   await page.setViewportSize({width:320,height:800});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:"test-results/scout-accuracy-mobile.png"});
 }finally{await page.request.post("/__test__/scout",{data:{reset:true}});}
});
