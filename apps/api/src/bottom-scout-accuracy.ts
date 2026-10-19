import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Service } from "./service";
import type { Bar,Calendar } from "../../../packages/core/index";
import { accuracyPredictionSchema,scoutAccuracySchema,summarizeAccuracy,type AccuracyPrediction } from "../../../packages/core/scout-accuracy";
import { hash } from "../../../packages/integrations/adjusted-series";
import { forecastBase,readScoutForecast } from "./bottom-scout-forecast";
import { evaluateScout,currentScoutSeries } from "./bottom-scout-journal";
export const accuracyQuerySchema=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(5).default(5),recordingMode:z.enum(["live","research"]).default("live")}).strict();
export async function scoutAccuracy(s:Service,raw:unknown={},now=new Date()){
  const q=accuracyQuerySchema.parse(raw),mode=s.mode==="demo"?"demo":"research",files=(await s.store.files(forecastBase(mode,q.recordingMode))).filter(f=>/\/\d{17}\/[a-f0-9]{64}\/original.json$/.test(f)).sort().reverse();
  const predictions:AccuracyPrediction[]=[],calendar=await s.store.read<Calendar>("market/calendar.json",[]),cache=new Map<string,Promise<Bar[]>>();let excludedReports=0,selectedReports=0;
  const load=(code:string)=>{let p=cache.get(code);if(!p){p=currentScoutSeries(s,code,now);cache.set(code,p);}return p;};
  for(const file of files.slice((q.page-1)*q.pageSize,q.page*q.pageSize)){
    const {forecast:p,report}=await readScoutForecast(s,file);
    if(p.createdAt>now.toISOString()){excludedReports++;continue;}selectedReports++;
    const end=p.calendar.at(-1)?.date??p.asOf,current=calendar.filter(d=>d.date>=p.asOf&&d.date<=end).sort((a,b)=>a.date.localeCompare(b.date));
    const review=await evaluateScout(s,report,now,{calendar:p.calendar,calendarIssue:hash(current)!==p.calendarHash?"予測時点の営業日カレンダーから変更されています":undefined,requiredTargets:p.targets,benchmarkCode:p.benchmarkCode,forecastId:p.forecastId,loadSeries:load});
    if(!review.evaluationId)throw Error("評価原本のIDがありません");
    for(const row of p.rows){
      const e=report.rows.find(r=>r.code===row.code)!;
      const results=review.rows.filter(r=>r.code===row.code).map(r=>({...r,...(row.referencePrice===null?{status:"unavailable",actualReturn:null,reason:"予測時点の基準価格がありません"}:{}),evaluationId:review.evaluationId,benchmarkCode:p.benchmarkCode}));
      predictions.push(accuracyPredictionSchema.parse({forecastId:p.forecastId,reportId:p.reportId,predictedAt:p.createdAt,algorithmVersion:p.algorithmVersion,inputHash:p.inputHash,rank:row.rank,referencePrice:row.referencePrice,included:true,exclusionReason:null,evidence:{...e,similar:e.similar?{sampleCount:e.similar.sampleCount,bestSimilarity:e.similar.bestSimilarity,horizons:e.similar.horizons,lowSample:e.similar.lowSample}:null},results}));
    }
  }
  return scoutAccuracySchema.parse({methodVersion:"scout-accuracy-v1",mode,evaluatedAt:now.toISOString(),...q,totalReports:files.length,selectedReports,excludedReports,predictions,...summarizeAccuracy(predictions),notes:[
    "的中＝5・10・20営業日後の調整終値リターンが0%超。横ばいは不的中。評価待ち・評価不能を分母に含めません。",
    "集計はこのページの保存済み分析の上位10候補です。TOP10でも候補不足なら実際の件数だけを集計します。質問で表示した件数とは異なる場合があります。",
    "同一銘柄・基準日の重複はページ内で最初の予測だけを集計します。異なるページの数字を足し合わせないでください。期間の重複や銘柄間の相関があり、独立標本や将来の成功確率ではありません。",
    "最大上昇・最大ドローダウン・再下落は調整終値ベースです。分割等は評価時点の同一調整系列でリベースし、当初の基準価格は書き換えません。売買コスト・配当・約定は未考慮です。",
    "予測manifestがない過去の分析原本は自動補完・集計しません。追加取得・外部送信・重みの自動変更は行いません。",
    mode==="demo"?"DEMO：架空の価格・人工カレンダーです。実市場の成績ではありません。":"実データの保存済み市場カレンダー・価格だけを使用しています。未取得分は推測しません。",
  ]});
}
export function registerScoutAccuracy(app:FastifyInstance,s:Service){
  app.get("/api/research/scout/accuracy",async req=>scoutAccuracy(s,req.query));
}
