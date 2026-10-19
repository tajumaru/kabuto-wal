import { test, expect } from "@playwright/test";
import { labMethodSchema } from "../../packages/core/hunter-experiment-schema";
import { labDefaultWeights } from "../../packages/core/hunter-experiment-method";
test("旧形式を履歴として表示し、実行・再開・Test選択を無効にする",async({page})=>{
  const planId="a".repeat(64),runId="b".repeat(64),experimentId="c".repeat(64);
  const plan={planId,legacy:true,executable:false,training:{from:"2024-01-01",to:"2024-03-01"},validation:{from:"2024-04-01",to:"2024-06-01"},test:{from:"2024-07-01",to:"2024-09-01"},partitions:{},purgeReasons:{}};
  const method={...labMethodSchema.parse({schemaVersion:1,experimentId,name:"保存済み方式",hypothesis:"人工データ",parameters:labDefaultWeights,candidateThreshold:60,parentMethodVersion:"bottom-rule-v1",featureVersion:"bottom-80-v1",methodVersion:"hunter-experiment-v1",createdAt:"2025-01-01T00:00:00Z"}),status:"testing"};
  const run={schemaVersion:undefined,experimentId,planId,stage:"validation",confirm:true,runId,inputHash:"d".repeat(64),createdAt:"2025-01-01T00:00:00Z",status:"paused",processed:0,total:1,failed:0,legacy:true,executable:false};
  await page.route("**/api/research/lab/plans?*",r=>r.fulfill({json:{records:[plan],total:1}}));
  await page.route("**/api/research/lab/methods?*",r=>r.fulfill({json:{records:[method],total:1}}));
  await page.route("**/api/research/lab/runs?*",r=>r.fulfill({json:{records:[run],total:1}}));
  await page.route(`**/api/research/lab/runs/${runId}`,r=>r.fulfill({json:run}));
  const writes:string[]=[];page.on("request",r=>{if(r.method()==="POST"&&r.url().includes("/research/lab/"))writes.push(r.url());});
  await page.goto(`/research/lab?run=${runId}`);
  await page.getByRole("combobox",{name:"保存済み検証計画",exact:true}).selectOption(planId);
  await page.getByRole("combobox",{name:"保存済み方式",exact:true}).selectOption(experimentId);
  await page.getByLabel("設定・分割・過学習の注意を確認し、実験を開始します").check();
  await expect(page.getByRole("note").filter({hasText:"旧形式・再実行不可"})).toBeVisible();
  for(const name of ["確認した設定で実験開始","Validation後にTest方式を固定","Trainingから仮説を生成","再開"])
    await expect(page.getByRole("button",{name,exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"検証計画を固定する",exact:true})).toBeEnabled();
  await page.setViewportSize({width:320,height:568});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(writes).toEqual([]);
});
