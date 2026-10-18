import type { Service } from "./service";
import type { Calendar } from "../../../packages/core/index";
import type { ScoutIntent } from "../../../packages/core/bottom-scout-intent";
import { JQuants } from "../../../packages/integrations/jquants";
import { JQuantsLimiter,RequestDeferred } from "../../../packages/integrations/jquants-limiter";
import { MarketIngestion } from "../../../packages/integrations/market-ingestion";
import { dataWindow } from "../../../packages/integrations/jquants-plan";
// Owner opt-in only. At most one daily update / three HTTP attempts per question.
// Initial 80+ session backfill stays in the existing explicit acquisition UI.
export async function acquireScoutUpdate(s:Service,intent:ScoutIntent,now:Date){
 if(s.mode==="demo"||process.env.SCOUT_ALLOW_FETCH!=="true"||intent.kind==="review"||intent.date||intent.relative==="yesterday")return {acquired:false,note:"質問からの追加取得はOFFです。取得済みデータだけで調べています。"};
 const key=process.env.JQUANTS_API_KEY;if(!key)return {acquired:false,note:"J-Quants接続が未設定のため追加取得せず、保存済みデータで調べています。"};
 const today=now.toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"}),plan=process.env.JQUANTS_PLAN||"Free",window=dataWindow(plan,today),calendar=await s.store.read<Calendar>("market/calendar.json",[]),asOf=calendar.filter(d=>d.open&&d.date<=window.to&&(d.date<today||now.toISOString()>=`${today}T08:30:00.000Z`)).map(d=>d.date).sort().at(-1);
 if(!asOf)return {acquired:false,note:"取得可能な営業日のカレンダーがありません。日足取得画面で準備してください。"};
 const master=await s.store.read<{providerCode:string;name:string}[]>("market/master.json",[]);if(!master.length)return {acquired:false,note:"銘柄一覧がありません。既存の日足取得画面で最初の取得を行ってください。"};
 const base=new JQuantsLimiter(key,s.store.root,plan,process.env.JQUANTS_REQUESTS_PER_MINUTE?Number(process.env.JQUANTS_REQUESTS_PER_MINUTE):undefined),started=Date.now();let attempts=0;
 const provider=new JQuants(key,fetch,{gate:{wait:async()=>{if(attempts>=3||Date.now()-started>30000)throw new RequestDeferred(new Date(Date.now()+60000).toISOString());await base.wait();attempts++;},deferUntil:async time=>{await base.deferUntil(time);throw new RequestDeferred(new Date(time).toISOString());}}});
 try{const ingestion=new MarketIngestion(s.store,provider,plan),cp=await ingestion.ingestDate(asOf,"scout-update");if(cp.status!=="completed")return {acquired:false,note:"日足取得が未完了です。取得済みのデータで調べます。"};const dates=calendar.filter(d=>d.open&&d.date<=asOf).map(d=>d.date).sort(),from=dates.slice(-Math.min(5500,dates.length))[0]??asOf,limit=Math.max(1,Math.min(200,Math.floor(Number(process.env.SCOUT_MAX_SYMBOLS)||50))),selected=intent.code?master.filter(m=>m.providerCode===intent.code):master.slice().sort((a,b)=>a.providerCode.localeCompare(b.providerCode)).slice(0,limit);for(const m of selected)await ingestion.series(m.providerCode,asOf,new Date().toISOString(),from);return {acquired:true,note:`${asOf}の1日分を既存取得処理で更新しました。HTTP試行${attempts}/3回。全期間の追加取得は行っていません。`};}
 catch(e){return {acquired:false,note:e instanceof RequestDeferred?`追加取得は待機中です。${e.retryAt}以降に再質問または既存取得画面から再開できます。保存済みデータで調べます。`:"追加取得を完了できませんでした。契約・接続・データを取得画面で確認してください。保存済みデータで調べます。"};}
}
