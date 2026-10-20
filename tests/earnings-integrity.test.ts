import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/storage/index";
import { preserveEarnings, readEarningsAt } from "../packages/integrations/earnings-evidence";
import { analyzeEarnings } from "../packages/core/earnings-analysis";
import { Service } from "../apps/api/src/service";
import { acquireEarnings, companyMaterials } from "../apps/api/src/earnings";
import { JQuants } from "../packages/integrations/jquants";
import { earningsAcquisitionSchema, earningsDateSchema } from "../packages/core/earnings-schema";

const roots: string[] = [];
async function store() { const root = await mkdtemp(path.join(os.tmpdir(), "earnings-integrity-")); roots.push(root); return new Store(root); }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
const row = (more: Record<string,string> = {}) => ({Code:"10000",DiscDate:"2025-11-01",DiscTime:"15:00:00",DiscNo:"202511010001",DocType:"2QFinancialStatements_Consolidated_JP",CurPerType:"2Q",CurPerSt:"2025-04-01",CurPerEn:"2025-09-30",CurFYSt:"2025-04-01",CurFYEn:"2026-03-31",Sales:"110",OP:"15",NP:"-2",...more});
const date = (more: Record<string,string> = {}) => ({Code:"10000",PubDate:"2025-11-01",SchDate:"2025-11-20",FQName:"2Q",FYE:"0331",CoName:"人工銘柄",CoNameEn:"Fixture",...more});
const empty = {evidence:[],attempt:null};
const cutoff = "2025-11-10T00:00:00.000Z";

it("同日時の開示は番号で決定的に選び、入力順を反転しても同じコメント", async () => {
  const s=await store(); await s.lock(()=>preserveEarnings(s,"summary","10000",[row({DiscNo:"202511010002",Sales:"120"}),row()],"2025-11-02T00:00:00.000Z"));
  const input=await readEarningsAt(s,"10000","summary",cutoff), first=analyzeEarnings(input,empty,cutoff);
  const reversed={...input,evidence:input.evidence.map(e=>({...e,raw:[...e.raw].reverse()})).reverse()};
  expect(analyzeEarnings(reversed,empty,cutoff)).toEqual(first);
  expect(first.latestDisclosure?.number).toBe("202511010002");
});
it("同じ開示番号は取得日時が新しいrevision、同順位の矛盾は拒否", async () => {
  const s=await store(); await s.lock(()=>preserveEarnings(s,"summary","10000",[row()],"2025-11-02T00:00:00.000Z"));
  await s.lock(()=>preserveEarnings(s,"summary","10000",[row({Sales:"125"})],"2025-11-03T00:00:00.000Z"));
  const input=await readEarningsAt(s,"10000","summary",cutoff);
  expect(analyzeEarnings({...input,evidence:[...input.evidence].reverse()},empty,cutoff).comments.join(" ")).toContain("125円");
  const tied={...input,evidence:input.evidence.map(e=>({...e,fetchedAt:"2025-11-03T00:00:00.000Z"}))};
  expect(()=>analyzeEarnings(tied,empty,cutoff)).toThrow();
  await expect(s.lock(()=>preserveEarnings(s,"summary","10000",[row(),row({Sales:"150"})],"2025-11-04T00:00:00.000Z"))).rejects.toThrow();
});
it("最新の予定snapshotが空なら旧予定を復活させず、過去cutoffでは旧予定を維持", async () => {
  const s=await store(); await s.lock(()=>preserveEarnings(s,"earnings-date","10000",[date()],"2025-11-02T00:00:00.000Z"));
  const old=await readEarningsAt(s,"10000","earnings-date","2025-11-02T12:00:00.000Z");
  await s.lock(()=>preserveEarnings(s,"earnings-date","10000",[],"2025-11-03T00:00:00.000Z"));
  const current=analyzeEarnings(empty,await readEarningsAt(s,"10000","earnings-date",cutoff),cutoff);
  expect(current.nextEarningsDate).toBeNull(); expect(current.schedule.status).toBe("no-data");
  expect(analyzeEarnings(empty,old,"2025-11-02T12:00:00.000Z").nextEarningsDate).toBe("2025-11-20");
});
it("同じ公表日の訂正は最新取得を使い、同順位の予定矛盾を拒否", async () => {
  const s=await store(); await s.lock(()=>preserveEarnings(s,"earnings-date","10000",[date()],"2025-11-02T00:00:00.000Z"));
  await s.lock(()=>preserveEarnings(s,"earnings-date","10000",[date({SchDate:""})],"2025-11-03T00:00:00.000Z"));
  const input=await readEarningsAt(s,"10000","earnings-date",cutoff);
  expect(analyzeEarnings(empty,{...input,evidence:[...input.evidence].reverse()},cutoff).nextEarningsDate).toBeNull();
  await expect(s.lock(()=>preserveEarnings(s,"earnings-date","10000",[date(),date({SchDate:""})],"2025-11-04T00:00:00.000Z"))).rejects.toThrow();
});
it("既存原本が壊れていれば再保存で成功扱いせず、元ファイルも上書きしない",async()=>{
  const s=await store(), rows=[row()], fetched="2025-11-02T00:00:00.000Z";
  const e=await s.lock(()=>preserveEarnings(s,"summary","10000",rows,fetched));
  const key=`market/earnings/10000/summary/evidence/${e.revision}/original.json`;
  const broken={...e,rawHash:"0".repeat(64)};await s.write(key,broken);
  await expect(s.lock(()=>preserveEarnings(s,"summary","10000",rows,fetched))).rejects.toThrow();
  expect(await s.read(key)).toEqual(broken);
});
it.each([[401,"authentication"],[403,"permission"],[429,"rate-limit"],[500,"network"]] as const)("HTTP %i は安全な分類 %s を返す",async(status,code)=>{
  vi.stubEnv("JQUANTS_PLAN","Light");const st=await store(),s=new Service(st.root,"live",false);await st.write("market/master.json",[{providerCode:"10000"}]);
  const gate={wait:async()=>{},deferUntil:async()=>{}},client=new JQuants("fixture",vi.fn(async()=>new Response("secret must not leak",{status})),{plan:"Light",gate});
  const result=await acquireEarnings(s,"10000",client);
  expect(result.results?.every(r=>r.errorCode===code)).toBe(true);expect(JSON.stringify(result)).not.toContain("secret");
});
it("公式フィールド・文字列数値・4桁英数字コード・空予定・ページングを受け取る",async()=>{
  const payload=row({Code:"130A0",NxFNp:"12.5",SigChgInC:"",ChgAcEst:"true",OdP:""});
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[payload],pagination_key:"next"})))
    .mockResolvedValueOnce(new Response(JSON.stringify({data:[{...payload,DiscNo:"202511010002"}]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({data:[date({Code:"130A0",FYE:"0299",SchDate:""})]})));
  const client=new JQuants("fixture-never-real",fetcher,{plan:"Light",gate:{wait:async()=>{},deferUntil:async()=>{}}});
  const rows=await client.financialSummary({code:"130A"});expect(rows).toHaveLength(2);expect(rows[0].NxFNp).toBe("12.5");expect(rows[0].OdP).toBe("");
  expect(earningsDateSchema.parse((await client.earningsDates({code:"130A"}))[0]).SchDate).toBe("");
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({"x-api-key":"fixture-never-real"});
  expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("pagination_key")).toBe("next");
});
it("取得・保存・hash照合の段階と空結果を返し、実原本を検証する",async()=>{
  vi.stubEnv("JQUANTS_PLAN","Light");const st=await store(),s=new Service(st.root,"live",false);await st.write("market/master.json",[{providerCode:"10000"}]);
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[row()]}))).mockResolvedValueOnce(new Response(JSON.stringify({data:[]})));
  const result=earningsAcquisitionSchema.parse(await acquireEarnings(s,"10000",new JQuants("fixture",fetcher,{plan:"Light",gate:{wait:async()=>{},deferUntil:async()=>{}}}),()=>new Date("2025-11-03T00:00:00.000Z")));
  expect(result.status).toBe("success");expect(result.results?.map(r=>[r.fetched,r.saved,r.hashVerified,r.rowCount])).toEqual([[true,true,true,1],[true,true,true,0]]);
  const materials=await companyMaterials(s,"10000",cutoff);expect(materials.earnings.status).toBe("checked");expect(materials.schedule.status).toBe("no-data");
});
it("保存障害は安全な保存エラーになり、回復後も過去の原本を維持する",async()=>{
  vi.stubEnv("JQUANTS_PLAN","Light");const st=await store(),s=new Service(st.root,"live",false);await st.write("market/master.json",[{providerCode:"10000"}]);
  await st.lock(()=>preserveEarnings(st,"summary","10000",[row()],"2025-11-02T00:00:00.000Z"));
  const original=await st.all("market/earnings/10000/summary/evidence");
  const client=()=>new JQuants("fixture",vi.fn(async()=>new Response(JSON.stringify({data:[]}))),{plan:"Light",gate:{wait:async()=>{},deferUntil:async()=>{}}});
  const fault=vi.spyOn(s.store,"write").mockRejectedValue(Error("private disk details"));
  const failed=await acquireEarnings(s,"10000",client(),()=>new Date("2025-11-03T00:00:00.000Z"));
  expect(failed.results?.every(r=>r.errorCode==="storage"&&!r.hashVerified)).toBe(true);expect(JSON.stringify(failed)).not.toContain("private");
  fault.mockRestore();expect(await st.all("market/earnings/10000/summary/evidence")).toEqual(original);
  expect((await acquireEarnings(s,"10000",client(),()=>new Date("2025-11-04T00:00:00.000Z"))).status).toBe("success");
  expect((await st.all("market/earnings/10000/summary/evidence"))).toEqual(expect.arrayContaining(original));
});
it("不正JSONを認証や保存成功と混同せず、その後の再取得で復旧できる",async()=>{
  vi.stubEnv("JQUANTS_PLAN","Light");const st=await store(),s=new Service(st.root,"live",false);await st.write("market/master.json",[{providerCode:"10000"}]);
  const fetcher=vi.fn().mockResolvedValueOnce(new Response("not-json")).mockResolvedValueOnce(new Response("not-json"))
    .mockResolvedValueOnce(new Response(JSON.stringify({data:[row()]}))).mockResolvedValueOnce(new Response(JSON.stringify({data:[]})));
  const client=new JQuants("fixture",fetcher,{plan:"Light",gate:{wait:async()=>{},deferUntil:async()=>{}}});
  const failed=await acquireEarnings(s,"10000",client,()=>new Date("2025-11-03T00:00:00.000Z"));expect(failed.results?.every(r=>r.errorCode==="invalid-response")).toBe(true);
  const recovered=await acquireEarnings(s,"10000",client,()=>new Date("2025-11-04T00:00:00.000Z"));expect(recovered.status).toBe("success");
  expect((await companyMaterials(s,"10000",cutoff)).earnings.status).toBe("checked");
});
it("同時刻の失敗を成功で隠さず、欠損した成功参照は確認済みにしない",async()=>{
  const st=await store(),s=new Service(st.root,"live",false),fetchedAt="2025-11-02T00:00:00.000Z";
  const e=await st.lock(()=>preserveEarnings(st,"summary","10000",[row()],fetchedAt));
  const {recordEarningsAttempt}=await import("../packages/integrations/earnings-evidence");
  await st.lock(()=>recordEarningsAttempt(st,{endpoint:"summary",code:"10000",fetchedAt,status:"failed",reason:"通信エラー",revision:null}));
  expect((await companyMaterials(s,"10000",cutoff)).earnings.status).toBe("failed");
  await st.lock(()=>recordEarningsAttempt(st,{endpoint:"summary",code:"10000",fetchedAt:"2025-11-03T00:00:00.000Z",status:"success",reason:"取得完了",revision:e.revision}));
  expect((await companyMaterials(s,"10000",cutoff)).earnings.reason).toContain("整合性");
});
it("ミリ秒有無が異なるISO表記でも実時刻でcutoffを比較する",async()=>{
  const st=await store();await st.lock(()=>preserveEarnings(st,"summary","10000",[row()],"2025-11-03T00:00:00.001Z"));
  const before=await readEarningsAt(st,"10000","summary","2025-11-03T00:00:00Z");expect(before.evidence).toHaveLength(0);expect(before.attempt).toBeNull();
  const after=await readEarningsAt(st,"10000","summary","2025-11-03T00:00:01Z");expect(after.evidence).toHaveLength(1);
  expect(analyzeEarnings(after,empty,"2025-11-03T00:00:00Z").latestDisclosure).toBeNull();
});
