import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JQuants } from "../packages/integrations/jquants";
import { Store } from "../packages/storage/index";
import { hash } from "../packages/integrations/adjusted-series";
import { preserveEarnings, readEarningsAt } from "../packages/integrations/earnings-evidence";
import { analyzeEarnings, financialNumber } from "../packages/core/earnings-analysis";
import { earningsSummarySchema } from "../packages/core/earnings-schema";
import { Service } from "../apps/api/src/service";
import { acquireEarnings, companyMaterials } from "../apps/api/src/earnings";
import { scoutFixture } from "../fixtures/bottom-scout";
import { scoutResearch, readScoutReport } from "../apps/api/src/bottom-scout";
import { createApp } from "../apps/api/src/server";
const roots: string[]=[];
async function temp() {const dir=await mkdtemp(path.join(os.tmpdir(),"earnings-test-")); roots.push(dir);return dir;}
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const gate = () => ({wait:vi.fn(async()=>{}),deferUntil:vi.fn(async(_time:number)=>{await Promise.resolve(_time);})});
const row = (extra:Record<string,string>={}) => ({Code:"10000",DiscDate:"2025-11-01",DiscTime:"15:00:00",DiscNo:"202511010001",DocType:"2QFinancialStatements_Consolidated_JP",CurPerType:"2Q",CurPerSt:"2025-04-01",CurPerEn:"2025-09-30",CurFYSt:"2025-04-01",CurFYEn:"2026-03-31",Sales:"110",OP:"15",OdP:"",NP:"-2",FSales:"220",FOP:"30",FNP:"20",FDivAnn:"12",...extra});
const prior = (extra:Record<string,string>={}) => row({DiscDate:"2024-11-01",DiscNo:"202411010001",CurPerSt:"2024-04-01",CurPerEn:"2024-09-30",CurFYSt:"2024-04-01",CurFYEn:"2025-03-31",Sales:"100",OP:"20",NP:"10",...extra});
const scheduled = (extra:Record<string,string>={}) => ({Code:"10000",PubDate:"2025-11-01",SchDate:"2025-11-07",FQName:"2Q",FYE:"0331",CoName:"人工銘柄",CoNameEn:"Fixture",...extra});
async function inputs(records:unknown[], dates:unknown[]=[]) {
 const store=new Store(await temp());
 await store.lock(async()=>{await preserveEarnings(store,"summary","10000",records,"2025-11-02T00:00:00.000Z");await preserveEarnings(store,"earnings-date","10000",dates,"2025-11-02T00:00:00.000Z");});
 return {store,summary:await readEarningsAt(store,"10000","summary","2025-11-03T00:00:00.000Z"),schedule:await readEarningsAt(store,"10000","earnings-date","2025-11-03T00:00:00.000Z")};
}
it("Lightのみ・許可パラメータとページングを検証しPremium cursorを送信しない",async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[prior()],pagination_key:"next",cursor:"premium-only"}))).mockResolvedValueOnce(new Response(JSON.stringify({data:[row()]})));
 const budget=gate(),client=new JQuants("fixture",fetcher,{gate:budget,plan:"Light"});
 expect(await client.financialSummary({code:"10000"})).toHaveLength(2);
 expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("pagination_key")).toBe("next");
 expect(fetcher.mock.calls.every(([url])=>!new URL(url).searchParams.has("cursor"))).toBe(true);expect(budget.wait).toHaveBeenCalledTimes(2);
 await expect(client.page("fins/summary",{cursor:"forbidden"})).rejects.toThrow();
 await expect(client.earningsDates({code:"10000",date:"2025-11-01"})).rejects.toThrow();
 await expect(client.financialSummary({})).rejects.toThrow();
 for(const plan of ["Free","Premium","Standard"]) await expect(new JQuants("fixture",fetcher,{gate:gate(),plan}).financialSummary({code:"10000"})).rejects.toThrow("Light");
 expect(fetcher).toHaveBeenCalledTimes(2);
});
it("対象外銘柄、不正な数値・日付、循環ページを拒否",async()=>{
 for (const data of [[row({Code:"99990"})],[row({Sales:"not-a-number"})],[row({DiscDate:"2025-99-99"})]]) {
   const c=new JQuants("fixture",vi.fn(async()=>new Response(JSON.stringify({data}))),{gate:gate(),plan:"Light"});await expect(c.financialSummary({code:"10000"})).rejects.toThrow();
 }
 const c=new JQuants("fixture",vi.fn(async()=>new Response(JSON.stringify({data:[row()],pagination_key:"same"}))),{gate:gate(),plan:"Light"});await expect(c.financialSummary({code:"10000"})).rejects.toThrow("循環");
 expect(earningsSummarySchema.parse(row({Sales:"",OdP:""})).Sales).toBe("");expect(financialNumber("")).toBeNull();expect(financialNumber("0")).toBe(0);
});
it("401/403を再試行せず429は既存gateで1分以上待機",async()=>{
 for(const status of [401,403]){const fetcher=vi.fn(async()=>new Response("",{status}));await expect(new JQuants("fixture",fetcher,{gate:gate(),plan:"Light"}).financialSummary({code:"10000"})).rejects.toThrow(`HTTP ${status}`);expect(fetcher).toHaveBeenCalledTimes(1);}
 const budget=gate();budget.deferUntil.mockRejectedValue(Error("deferred"));const start=Date.now();
 await expect(new JQuants("fixture",vi.fn(async()=>new Response("",{status:429})),{gate:budget,plan:"Light"}).financialSummary({code:"10000"})).rejects.toThrow("deferred");
 expect(budget.deferUntil.mock.calls[0][0]).toBeGreaterThanOrEqual(start+60000);
});
it("訂正開示と同一開示番号の提供側訂正を追記し、取得前の時点に混ぜない",async()=>{
 const {store}=await inputs([row()]);const first=await readEarningsAt(store,"10000","summary","2025-11-03T00:00:00.000Z");const original=JSON.stringify(first.evidence[0]);
 await store.lock(()=>preserveEarnings(store,"summary","10000",[row(),row({DiscNo:"202511040001",DiscDate:"2025-11-04",Sales:"120"})],"2025-11-04T12:00:00.000Z"));
 await store.lock(()=>preserveEarnings(store,"summary","10000",[row({Sales:"105"})],"2025-11-05T12:00:00.000Z"));
 expect((await readEarningsAt(store,"10000","summary","2025-11-01T23:59:59.000Z")).evidence).toHaveLength(0);
 const old=await readEarningsAt(store,"10000","summary","2025-11-03T00:00:00.000Z");expect(old.evidence).toHaveLength(1);expect(JSON.stringify(old.evidence[0])).toBe(original);
 const all=await readEarningsAt(store,"10000","summary","2025-11-06T00:00:00.000Z");expect(all.evidence).toHaveLength(3);expect(all.evidence[0].rawHash).toBe(hash(all.evidence[0].raw));
});
it("売上・利益を前年同期比較し赤字転落と減益、決算接近を説明",async()=>{
 const input=await inputs([prior(),row()],[scheduled()]);const result=analyzeEarnings(input.summary,input.schedule,"2025-11-03T00:00:00.000Z"),text=result.comments.join(" ");
 expect(text).toContain("前年同期比10.0%");expect(text).toContain("減益");expect(text).toContain("赤字転落");expect(text).toContain("7日以内");expect(result.nextEarningsDate).toBe("2025-11-07");expect(result.news.status).toBe("unchecked");
});
it.each<Record<string,string>>([{DocType:"2QFinancialStatements_Consolidated_IFRS"},{DocType:"2QFinancialStatements_NonConsolidated_JP"},{CurPerSt:"2025-05-01"},{CurFYEn:"2026-12-31"},{RetroRst:"true"},{Sales:""}])("不整合・欠損では売上成長率を作らない %j",async extra=>{
 const input=await inputs([prior(),row(extra)]);const result=analyzeEarnings(input.summary,input.schedule,"2025-11-03T00:00:00.000Z");expect(result.comments.find(c=>c.startsWith("売上高は"))).not.toContain("前年同期比");
});
it("IFRS同士は比較でき、経常利益の空欄をゼロ化しない",async()=>{
 const input=await inputs([prior({DocType:"2QFinancialStatements_Consolidated_IFRS"}),row({DocType:"2QFinancialStatements_Consolidated_IFRS"})]);expect(analyzeEarnings(input.summary,input.schedule,"2025-11-03T00:00:00.000Z").comments.join(" ")).toContain("前年同期比10.0%");expect(financialNumber(input.summary.evidence[0].raw.map(r=>earningsSummarySchema.parse(r))[1].OdP)).toBeNull();
});
it("同一年度の予想と配当を比較し年度が異なる予想を比較しない",async()=>{
 const first=row({DiscDate:"2025-10-01",DiscNo:"202510010001",FSales:"200",FDivAnn:"10"});
 const input=await inputs([first,row()]);const comments=analyzeEarnings(input.summary,input.schedule,"2025-11-03T00:00:00.000Z").comments.join(" ");expect(comments).toContain("200 → 220");expect(comments).toContain("10 → 12");
 const changed=await inputs([first,row({CurFYEn:"2026-12-31"})]);expect(analyzeEarnings(changed.summary,changed.schedule,"2025-11-03T00:00:00.000Z").comments.join(" ")).not.toContain("200 → 220");
});
it("予定日の変更と未定で旧日程へ戻らず、公表が未来の情報を使わない",async()=>{
 const input=await inputs([row()],[scheduled(),scheduled({PubDate:"2025-11-02",SchDate:"",FYE:"1231"}),scheduled({PubDate:"2025-11-10",SchDate:"2025-11-12"})]);
 const result=analyzeEarnings(input.summary,input.schedule,"2025-11-03T00:00:00.000Z");expect(result.nextEarningsDate).toBeNull();expect(result.comments.join(" ")).toContain("未定へ変更");
 const future=await inputs([row({DiscDate:"2025-11-10"})]);expect(analyzeEarnings(future.summary,future.schedule,"2025-11-03T00:00:00.000Z").latestDisclosure).toBeNull();
});
it("DEMOはボタン/API/チャットから実通信せず、予測原本・スコアは決算取得後も不変",async()=>{
 const s=new Service(await temp(),"demo",false),network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("forbidden")),f=await scoutFixture(s,1);
 const before=await scoutResearch(s,"底打ち候補を教えて",undefined,f.now),original=JSON.stringify(await readScoutReport(s,before.reportId!)),forecastOriginal=JSON.stringify(await s.store.all("research/scout/forecasts"));
 expect(await acquireEarnings(s,"10000")).toMatchObject({status:"disabled"});
 await s.store.lock(()=>preserveEarnings(s.store,"summary","10000",[row()],"2025-11-17T00:00:00.000Z"));
 const after=await scoutResearch(s,"底打ち候補を教えて",undefined,f.now);expect(after.reportId).toBe(before.reportId);expect(after.rows.map(r=>r.score)).toEqual(before.rows.map(r=>r.score));expect(JSON.stringify(await readScoutReport(s,before.reportId!))).toBe(original);expect(after.rows[0].companyMaterials?.earnings.status).toBe("not-fetched");expect(JSON.stringify(await s.store.all("research/scout/forecasts"))).toBe(forecastOriginal);
 const app=await createApp(s);try{const r=await app.inject({method:"POST",url:"/api/research/earnings/10000/acquire",payload:{confirmFetch:true}});expect(r.json().status).toBe("disabled");}finally{await app.close();}
 expect(network).not.toHaveBeenCalled();
});
it("片方の取得失敗を隠さず表示し、成功原本を保持する",async()=>{
 vi.stubEnv("JQUANTS_PLAN","Light");const s=new Service(await temp(),"live",false);await s.store.write("market/master.json",[{providerCode:"10000"}]);
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[row()]}))).mockResolvedValueOnce(new Response("",{status:403}));
 const result=await acquireEarnings(s,"10000",new JQuants("fixture",fetcher,{gate:gate(),plan:"Light"}),()=>new Date("2025-11-03T00:00:00.000Z"));expect(result.status).toBe("failed");
 const check=await companyMaterials(s,"10000","2025-11-04T00:00:00.000Z");expect(check.earnings.status).toBe("checked");expect(check.schedule.status).toBe("failed");expect(check.schedule.reason).toContain("権限");expect(check.news.status).toBe("unchecked");
});
it("予定日延期は最新履歴を選び、未取得・空配列・原本破損を区別する",async()=>{
 const input=await inputs([],[scheduled(),scheduled({PubDate:"2025-11-02",SchDate:"2025-11-20"})]);
 const result=analyzeEarnings(input.summary,input.schedule,"2025-11-03T00:00:00.000Z");expect(result.earnings.status).toBe("no-data");expect(result.nextEarningsDate).toBe("2025-11-20");
 expect(result.comments.join(" ")).not.toContain("7日以内");
 const evidence=input.summary.evidence[0];await input.store.write(`market/earnings/10000/summary/evidence/${evidence.revision}/original.json`,{...evidence,rawHash:"0".repeat(64)});
 const s=new Service(input.store.root,"demo",false),failed=await companyMaterials(s,"10000","2025-11-03T00:00:00.000Z");expect(failed.earnings.status).toBe("failed");expect(failed.schedule.status).toBe("checked");
 const empty=new Service(await temp(),"demo",false);expect((await companyMaterials(empty,"10000","2025-11-03T00:00:00.000Z")).earnings.status).toBe("not-fetched");
});
it("新しいAPIも既存本人認証とOrigin検査を必須にする",async()=>{
 vi.stubEnv("OWNER_ADDRESS","0x"+"1".repeat(64));vi.stubEnv("SESSION_SECRET","fixture-session-"+"1".repeat(32));
 const s=new Service(await temp(),"live",false),app=await createApp(s),network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("forbidden"));
 try{
  expect((await app.inject({method:"GET",url:"/api/research/earnings/10000"})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:"/api/research/earnings/10000/acquire",payload:{confirmFetch:true}})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:"/api/research/earnings/10000/acquire",headers:{origin:"https://untrusted.example"},payload:{confirmFetch:true}})).statusCode).toBe(403);
  expect(network).not.toHaveBeenCalled();
 }finally{await app.close();}
});
it("Lightの既存共有制限はsummaryと予定日の合計でも60回/分を超えない",async()=>{
 vi.stubEnv("JQUANTS_REQUESTS_PER_MINUTE","60");vi.stubEnv("JQUANTS_REQUESTS_PER_DAY","100");
 const dir=await temp(),fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[row()]}))).mockResolvedValueOnce(new Response(JSON.stringify({data:[scheduled()]})));
 const client=new JQuants("fixture-rate-key",fetcher,{root:dir,plan:"Light"});const started=Date.now();
 await client.financialSummary({code:"10000"});await client.earningsDates({code:"10000"});expect(Date.now()-started).toBeGreaterThanOrEqual(1000);
 const stateFiles=await new Store(dir).files("market/request-budgets");expect(stateFiles).toHaveLength(1);expect((await new Store(dir).read(stateFiles[0])).requests).toBe(2);
});
it("翌年度純利益の公式キーNxFNpを当年度FNPと対象年度で照合する",async()=>{
 const annual=row({DiscDate:"2025-05-01",DiscNo:"202505010001",DocType:"FYFinancialStatements_Consolidated_JP",CurPerType:"FY",CurPerSt:"2024-04-01",CurPerEn:"2025-03-31",CurFYSt:"2024-04-01",CurFYEn:"2025-03-31",NxtFYSt:"2025-04-01",NxtFYEn:"2026-03-31",FNP:"",NxFNp:"20"});
 const input=await inputs([annual,row({FNP:"30"})]);const result=analyzeEarnings(input.summary,input.schedule,"2025-11-03T00:00:00.000Z");
 expect(result.comments.find(c=>c.startsWith("純利益予想："))).toContain("20 → 30");
});
it("予定日公表当日でも実取得がcutoff以前なら利用可能、実取得前には利用不可",async()=>{
 const store=new Store(await temp());await store.lock(()=>preserveEarnings(store,"earnings-date","10000",[scheduled()],"2025-11-01T02:00:00.000Z"));
 const before=await readEarningsAt(store,"10000","earnings-date","2025-11-01T01:00:00.000Z"),after=await readEarningsAt(store,"10000","earnings-date","2025-11-01T03:00:00.000Z");
 const noSummary={evidence:[],attempt:null};expect(analyzeEarnings(noSummary,before,"2025-11-01T01:00:00.000Z").nextEarningsDate).toBeNull();
 expect(analyzeEarnings(noSummary,after,"2025-11-01T03:00:00.000Z").nextEarningsDate).toBe("2025-11-07");
});
