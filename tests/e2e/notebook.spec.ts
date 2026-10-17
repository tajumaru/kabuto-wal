import { test,expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
test("固定コホートを評価し、研究ノート・記憶・過去締切・320px操作を維持する",async({page})=>{
  const launched=await page.request.post("/api/bottom/hunter/jobs",{data:{asOf:"2026-08-10",cutoff:"2026-08-10T14:59:59.999Z"}});expect(launched.ok()).toBe(true);const job=await launched.json();
  await expect.poll(async()=>(await(await page.request.get(`/api/bottom/hunter/jobs/${job.id}`)).json()).status).toBe("completed");
  await page.goto("/research/notebook");await expect(page.getByRole("heading",{name:"かぶまる研究ノート",exact:true})).toBeVisible();
  await page.getByLabel("完了済み分析ジョブ").selectOption(job.id);await page.getByRole("button",{name:"固定コホートを作成",exact:true}).click();
  await expect(page.getByLabel("保存済みコホート")).not.toHaveValue("");
  await page.getByRole("button",{name:"期限後評価を実行",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"保存済み価格で評価：completed"})).toBeVisible();
  await page.getByLabel("テーマ",{exact:true}).selectOption("false-rebound");await page.getByLabel("研究時点の仮説（観測事実とは別）").fill("反発後の再下落を検証する仮説");
  await page.getByRole("button",{name:"研究ノートを作成",exact:true}).click();await expect(page.getByRole("heading",{name:"候補・非候補の比較",exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"スコア帯別実績",exact:true}).first()).toBeVisible();
  await expect(page.getByRole("button",{name:"保存済み研究記憶を同期",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"研究記憶をローカル保存",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"ローカルにコンパクトな研究記憶"})).toBeVisible();
  const url=page.url(),id=new URL(url).searchParams.get("id")!,before=(await(await page.request.get(`/api/research/notebook/${id}`)).json()).original;
  await page.setViewportSize({width:320,height:568});await page.getByLabel("研究時点の仮説（観測事実とは別）").focus();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const samples:number[]=[];for(let i=0;i<5;i++){const start=performance.now();await page.goto(url);await expect(page.getByRole("heading",{name:"候補・非候補の比較",exact:true})).toBeVisible();samples.push(+(performance.now()-start).toFixed(2));}
  const sorted=[...samples].sort((a,b)=>a-b),performanceReport={viewport:"320x568 Chromium",samplesMs:samples,medianMs:sorted[2],minMs:sorted[0],maxMs:sorted[4]};console.log(`notebook performance ${JSON.stringify(performanceReport)}`);await writeFile("test-results/notebook-performance.json",JSON.stringify(performanceReport,null,2));
  await page.screenshot({path:"test-results/notebook-mobile.png",fullPage:true});
  expect((await(await page.request.get(`/api/research/notebook/${id}`)).json()).original).toEqual(before);
  await page.goto("/research?code=72030&asOf=2026-10-09");await page.getByText("研究ノートに質問する",{exact:true}).click();
  await page.getByRole("button",{name:"候補と非候補ではどちらの成績が良い？",exact:true}).click();await expect(page.getByText("この時点で参照できる十分な比較データがなく、まだ判断できません。",{exact:false})).toBeVisible();
});
