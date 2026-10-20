import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/storage/index";
import { preserveEarnings, readEarningsAt } from "../packages/integrations/earnings-evidence";
import { analyzeEarnings } from "../packages/core/earnings-analysis";
import { Service } from "../apps/api/src/service";
import { acquireEarnings } from "../apps/api/src/earnings";
import { JQuants } from "../packages/integrations/jquants";

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
