import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import type { Bar } from "../../../packages/core/index";
import { accuracyPredictionSchema,scoutAccuracySchema,accuracyMetrics,summarizeAccuracy,reflectAccuracy,type AccuracyPrediction } from "../../../packages/core/scout-accuracy";
import { scoutId,scoutReviewSchema } from "../../../packages/core/bottom-scout-schema";
import { forecastBase,readScoutForecast } from "./bottom-scout-forecast";
import { hash } from "../../../packages/integrations/adjusted-series";
import { scoutMarketRegime } from "./scout-market-regime";
import { cachedScoutAccuracy } from "./scout-accuracy-cache";
import { scoutAccuracyBatch } from "./scout-accuracy-io";
import { evaluateScout,currentScoutSeries } from "./bottom-scout-journal";
export const accuracyQuerySchema=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(5).default(5),recordingMode:z.enum(["live","research"]).default("live"),reportId:scoutId.optional()}).strict();
export async function scoutAccuracy(s:Service,raw:unknown={},now=new Date(),options:{persist?:boolean}={}){
  const query=accuracyQuerySchema.parse(raw);
  const key=hash({query,persist:options.persist!==false,mode:s.mode,index:process.env.SCOUT_MARKET_REGIME_INDEX_CODE??null});
  return cachedScoutAccuracy(s,key,now,view=>computeScoutAccuracy(view,query,now,options),v=>v,options.persist!==false);
}
async function computeScoutAccuracy(s:Service,raw:unknown,now:Date,options:{persist?:boolean}){
  const q=accuracyQuerySchema.parse(raw),mode=s.mode==="demo"?"demo":"research",files=(await s.store.files(forecastBase(mode,q.recordingMode))).filter(f=>/\/\d{17}\/[a-f0-9]{64}\/original.json$/.test(f)).sort().reverse();
  const predictions:AccuracyPrediction[]=[],cache=new Map<string,Promise<Bar[]>>();let excludedReports=0,selectedReports=0;
  const load=(code:string)=>{let p=cache.get(code);if(!p){p=currentScoutSeries(s,code,now);cache.set(code,p);}return p;};
  const detailFiles=files.filter(f=>!q.reportId||f.endsWith(`/${q.reportId}/original.json`)),selected=new Set(detailFiles.slice((q.page-1)*q.pageSize,q.page*q.pageSize));
  const calendar=await s.store.read("market/calendar.json",[]);
  await scoutAccuracyBatch(files,async file=>{
    const {forecast:p,report}=await readScoutForecast(s,file);
    if(p.createdAt>now.toISOString()){excludedReports++;return;}if(selected.has(file))selectedReports++;
        // Verify every saved evaluation original for this report, not just the newly computed ID.
    for(const key of (await s.store.files(`research/scout/evaluations/${p.reportId}`)).filter(f=>f.endsWith("/original.json"))){
      const saved=scoutReviewSchema.parse(await s.store.read(key));
      const {evaluationId,evaluatedAt,...body}=saved;void evaluatedAt;
      if(!evaluationId||hash(body)!==evaluationId||!key.endsWith(`/${evaluationId}/original.json`)||saved.reportId!==p.reportId||saved.asOf!==p.asOf||(saved.forecastId&&saved.forecastId!==p.forecastId))throw Error("保存済み評価原本hashまたは予測参照が一致しません");
    }
    const indexCode=process.env.SCOUT_MARKET_REGIME_INDEX_CODE;
    const benchmarkCode=indexCode&&indexCode===p.benchmarkCode?indexCode:null;
    const regime=scoutMarketRegime(benchmarkCode?await currentScoutSeries(s,benchmarkCode,new Date(p.cutoff)).catch(()=>[]):[],calendar,p.asOf,p.cutoff,benchmarkCode);
    const review=await evaluateScout(s,report,now,{persist:options.persist,loadSeries:load,evaluationCodes:p.rows.map(r=>r.code)});
    if(!review.evaluationId||review.forecastId!==p.forecastId)throw Error("評価原本と予測IDが一致しません");
    for(const row of p.rows){
      const e=report.rows.find(r=>r.code===row.code)!;
      const results=review.rows.filter(r=>r.code===row.code).map(r=>({...r,...(row.referencePrice===null?{status:"unavailable",actualReturn:null,up:null,maxRise:null,maxDrawdown:null,relapse:null,basePrice:null,targetPrice:null,revisionIds:[],benchmarkReturn:null,benchmarkRevisionIds:[],reason:"予測時点の基準価格がありません"}:{}),evaluationId:review.evaluationId,benchmarkCode:p.benchmarkCode}));
      predictions.push(accuracyPredictionSchema.parse({...regime,forecastId:p.forecastId,reportId:p.reportId,predictedAt:p.createdAt,algorithmVersion:p.algorithmVersion,inputHash:p.inputHash,rank:row.rank,referencePrice:row.referencePrice,included:true,exclusionReason:null,evidence:{...e,similar:e.similar?{sampleCount:e.similar.sampleCount,bestSimilarity:e.similar.bestSimilarity,horizons:e.similar.horizons,lowSample:e.similar.lowSample}:null},results}));
    }
  });
  // Concurrent I/O must not change accumulation order, tie-breaking or page order.
  predictions.sort((a,b)=>b.predictedAt.localeCompare(a.predictedAt)||b.reportId.localeCompare(a.reportId)||a.rank-b.rank);
    const summary=summarizeAccuracy(predictions);
  const regimes=(["up","down","flat","unknown"] as const).flatMap(regime=>[5,10,20].map(h=>({...accuracyMetrics(predictions.filter(p=>p.regime===regime),h),regime})));
  const cumulative={predictions:predictions.length,included:predictions.filter(p=>p.included).length,duplicates:predictions.filter(p=>!p.included).length};
  const detailIds=new Set([...selected].map(file=>file.split("/").at(-2)));
  const details=predictions.filter(p=>detailIds.has(p.reportId));reflectAccuracy(details);
  const explanation=`保存済み${files.length}分析原本に${cumulative.predictions}予測があるよ。重複${cumulative.duplicates}件を除いた${cumulative.included}件が対象。`+summary.groups.map(g=>`${g.horizon}営業日後は評価済み${g.evaluated}件中${g.hits}件的中、待ち${g.pending}件・不能${g.unavailable}件。`).join("")+"原本IDは個別の根拠で確認してね。相関や少数標本があるので、将来の成功確率とは言えないよ。";
  return scoutAccuracySchema.parse({methodVersion:"scout-accuracy-v2",mode,evaluatedAt:now.toISOString(),...q,totalReports:detailFiles.length,selectedReports,excludedReports,predictions:details,cumulative,regimes,explanation,...summary,notes:[
    "的中＝5・10・20営業日後の調整終値リターンが0%超。横ばいは不的中。評価待ち・評価不能を分母に含めません。",
    "集計は選択した記録区分の全履歴に保存された分析の上位10候補です。明細のページ・分析IDによる絞り込みでは累積成績は変わりません。TOP10でも候補不足なら実際の件数だけを集計します。質問で表示した件数とは異なる場合があります。",
    "同一方式・銘柄・基準日の重複は全履歴で最初の予測だけを集計します。期間の重複や銘柄間の相関があり、独立標本や将来の成功確率ではありません。",
    "最大上昇・最大ドローダウン・再下落は調整終値ベースです。分割等は評価時点の同一調整系列でリベースし、当初の基準価格は書き換えません。売買コスト・配当・約定は未考慮です。",
    "95%信頼区間は独立な二項標本を仮定したWilson区間です。銘柄間・連続日・重複期間の相関は補正しておらず、将来の上昇確率を表しません。",
    "予測manifestがない過去の分析原本は自動補完・集計しません。追加取得・外部送信・重みの自動変更は行いません。",
    mode==="demo"?"DEMO：架空の価格・人工カレンダーです。実市場の成績ではありません。":"実データの保存済み市場カレンダー・価格だけを使用しています。未取得分は推測しません。",
  ]});
}
export function registerScoutAccuracy(app:FastifyInstance,s:Service){
  app.get("/api/research/scout/accuracy",async req=>scoutAccuracy(s,req.query));
}
