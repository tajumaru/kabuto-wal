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
    await dialog.getByRole("button",{name:"Lightの決算・予定を取得する"}).first().click();
    await expect(dialog.getByRole("status").filter({hasText:"DEMOでは外部通信しません"})).toBeVisible();
    await expect(check).toContainText("ニュース未確認");expect(external).toEqual([]);
    await page.setViewportSize({width:320,height:568});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await check.scrollIntoViewIfNeeded();
    await check.screenshot({path:"test-results/earnings-materials-mobile.png"});
  } finally {await page.request.post("/__test__/scout",{data:{reset:true}});}
});
