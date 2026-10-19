import { z } from "zod";
import { quantile } from "./index";
import { scoutId,scoutReviewSchema,scoutRowSchema,scoutSimilarSchema } from "./bottom-scout-schema";
const nullable=z.number().finite().nullable();
export const accuracyResultSchema=scoutReviewSchema.shape.rows.element.extend({
  horizon:z.union([z.literal(5),z.literal(10),z.literal(20)]),target:z.string().nullable(),
  up:z.boolean().nullable(),maxRise:nullable,maxDrawdown:nullable,relapse:z.boolean().nullable(),basePrice:nullable,targetPrice:nullable,dataAvailableAt:z.string().nullable(),
  benchmarkRevisionIds:z.array(z.string()),benchmarkCode:z.string().nullable(),evaluationId:scoutId,
}).superRefine((r,ctx)=>{
  if(r.status==="evaluated"&&(r.actualReturn===null||r.up!==(r.actualReturn>0)||r.maxRise===null||r.maxDrawdown===null||r.relapse===null||r.basePrice===null||r.basePrice<=0||r.targetPrice===null||r.targetPrice<=0||!r.target||!r.revisionIds.length))
    ctx.addIssue({code:"custom",message:"確定評価の価格・revision・指標が不足しています"});
});
export const accuracyPredictionSchema=z.object({
  forecastId:scoutId,reportId:scoutId,predictedAt:z.string().datetime(),algorithmVersion:z.literal("bottom-scout-v1"),inputHash:scoutId,
  rank:z.number().int(),referencePrice:nullable,included:z.boolean(),exclusionReason:z.string().nullable(),
  evidence:scoutRowSchema.omit({chart:true,similar:true}).extend({similar:scoutSimilarSchema.pick({sampleCount:true,bestSimilarity:true,horizons:true,lowSample:true}).nullable()}),
  results:z.array(accuracyResultSchema).length(3).refine(rows=>new Set(rows.map(r=>r.horizon)).size===3,"5・10・20営業日後の評価が必要です"),
  reflection:z.object({selection:z.string(),outcomes:z.array(z.object({horizon:z.number(),text:z.string(),evidenceIds:z.array(z.string()),similarSuccesses:z.array(z.object({forecastId:scoutId,reportId:scoutId,code:z.string(),matchedConditions:z.array(z.string())}))})),cautions:z.array(z.string())}).optional(),
});
export type AccuracyPrediction=z.infer<typeof accuracyPredictionSchema>;
export const accuracyMetricSchema=z.object({
  horizon:z.number(),total:z.number(),evaluated:z.number(),pending:z.number(),unavailable:z.number(),hits:z.number(),misses:z.number(),hitRate:nullable,
  meanReturn:nullable,medianReturn:nullable,worstDrawdown:nullable,relapseRate:nullable,lowSample:z.boolean(),
  benchmarkCode:z.string().nullable(),benchmarkPairs:z.number(),pairedPredictionMean:nullable,benchmarkMean:nullable,meanExcessReturn:nullable,outperformanceRate:nullable,comparisonNote:z.string(),
});
export const accuracyConditionSchema=z.object({horizon:z.number(),code:z.string(),label:z.string(),evaluated:z.number(),hits:z.number(),failures:z.number()});
export const scoutAccuracySchema=z.object({
  methodVersion:z.literal("scout-accuracy-v1"),mode:z.enum(["demo","research"]),recordingMode:z.enum(["live","research"]),evaluatedAt:z.string().datetime(),
  page:z.number(),pageSize:z.number(),totalReports:z.number(),selectedReports:z.number(),excludedReports:z.number(),
  predictions:z.array(accuracyPredictionSchema),groups:z.array(accuracyMetricSchema),
  top:z.array(accuracyMetricSchema.extend({top:z.number()})),bands:z.array(accuracyMetricSchema.extend({band:z.string()})),conditions:z.array(accuracyConditionSchema),notes:z.array(z.string()),
});
export type ScoutAccuracy=z.infer<typeof scoutAccuracySchema>;
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
export function accuracyMetrics(cases:AccuracyPrediction[],horizon:number){
  const results=cases.filter(c=>c.included).flatMap(c=>c.results.filter(r=>r.horizon===horizon)),evaluated=results.filter(r=>r.status==="evaluated"&&r.actualReturn!==null),values=evaluated.map(r=>r.actualReturn!);
  const pairs=evaluated.filter(r=>r.benchmarkReturn!==null&&r.benchmarkCode),codes=new Set(pairs.map(r=>r.benchmarkCode)),comparable=codes.size===1;
  const chosen=comparable?pairs:[],excess=chosen.map(r=>r.actualReturn!-r.benchmarkReturn!);
  return accuracyMetricSchema.parse({horizon,total:results.length,evaluated:evaluated.length,pending:results.filter(r=>r.status==="pending").length,unavailable:results.filter(r=>r.status==="unavailable").length,hits:values.filter(v=>v>0).length,misses:values.filter(v=>v<=0).length,hitRate:values.length?values.filter(v=>v>0).length/values.length:null,meanReturn:mean(values),medianReturn:values.length?quantile(values,.5):null,worstDrawdown:evaluated.length?Math.min(...evaluated.map(r=>r.maxDrawdown??0)):null,relapseRate:evaluated.length?evaluated.filter(r=>r.relapse).length/evaluated.length:null,lowSample:values.length<20,benchmarkCode:comparable?chosen[0]?.benchmarkCode??null:null,benchmarkPairs:chosen.length,pairedPredictionMean:mean(chosen.map(r=>r.actualReturn!)),benchmarkMean:mean(chosen.map(r=>r.benchmarkReturn!)),meanExcessReturn:mean(excess),outperformanceRate:excess.length?excess.filter(v=>v>0).length/excess.length:null,comparisonNote:comparable?"同一の評価可能ペアだけを比較。設定銘柄でありTOPIXとは限りません。":codes.size>1?"比較銘柄が混在しているため集計比較不能です。":"保存済み比較データがないため比較不能です。"});
}
export function summarizeAccuracy(predictions:AccuracyPrediction[]){
  const seen=new Set<string>();
  for(const c of [...predictions].sort((a,b)=>a.predictedAt.localeCompare(b.predictedAt)||a.forecastId.localeCompare(b.forecastId))){
    const key=`${c.algorithmVersion}/${c.evidence.code}/${c.evidence.asOf}`;
    c.included=!seen.has(key);c.exclusionReason=c.included?null:"同一銘柄・基準日の重複（このページで最初の予測だけを集計）";seen.add(key);
  }
  const band=(score:number)=>score<40?"0–39":score<60?"40–59":score<80?"60–79":"80–100";
  const groups=[5,10,20].map(h=>accuracyMetrics(predictions,h));
  const top=[5,10,20].flatMap(h=>[3,5,10].map(k=>({...accuracyMetrics(predictions.filter(p=>p.rank<=k),h),top:k})));
  const bands=[5,10,20].flatMap(h=>["0–39","40–59","60–79","80–100"].map(b=>({...accuracyMetrics(predictions.filter(p=>band(p.evidence.score)===b),h),band:b})));
  const conditions:z.infer<typeof accuracyConditionSchema>[]=[];
  for(const h of [5,10,20]){
    const map=new Map<string,z.infer<typeof accuracyConditionSchema>>();
    for(const p of predictions.filter(p=>p.included)){
      const r=p.results.find(r=>r.horizon===h);if(r?.status!=="evaluated"||r.actualReturn===null)continue;
      for(const c of p.evidence.contributions.filter(c=>c.met)){
        const item=map.get(c.code)??{horizon:h,code:c.code,label:c.label,evaluated:0,hits:0,failures:0};item.evaluated++;if(r.actualReturn>0)item.hits++;else item.failures++;map.set(c.code,item);
      }
    }conditions.push(...map.values());
  }
  return {groups,top,bands,conditions};
}
export function reflectAccuracy(predictions:AccuracyPrediction[]){
  const pct=(v:number)=>`${v>0?"+":""}${(v*100).toFixed(2)}%`;
  for(const p of predictions){
    const conditions=p.evidence.contributions.filter(c=>c.met);
    p.reflection={selection:`選定時は${p.evidence.score}点。「${conditions.map(c=>c.label).join("、")||"成立条件の記録なし"}」を根拠に保存した候補だよ。点数は確率ではないよ。`,outcomes:p.results.map(r=>{
      const similarSuccesses=r.status==="evaluated"?predictions.filter(other=>other.included&&(other.evidence.code!==p.evidence.code||other.evidence.asOf!==p.evidence.asOf)).flatMap(other=>{
        const result=other.results.find(x=>x.horizon===r.horizon),matched=other.evidence.contributions.filter(c=>c.met&&conditions.some(x=>x.code===c.code)).map(c=>c.label);
        return result?.status==="evaluated"&&result.actualReturn!==null&&result.actualReturn>0&&matched.length>=2?[{forecastId:other.forecastId,reportId:other.reportId,code:other.evidence.code,matchedConditions:matched}]:[];
      }).slice(0,3):[];
      return {horizon:r.horizon,text:r.status==="evaluated"?`${r.horizon}営業日後は${pct(r.actualReturn!)}で、${r.actualReturn!>0?"定義上の的中":"不的中"}。最大終値ドローダウン${pct(r.maxDrawdown!)}、再下落${r.relapse?"あり":"なし"}。`:r.status==="pending"?`${r.horizon}営業日後は評価待ち。まだ成績に数えないよ。`:`${r.horizon}営業日後は評価不能：${r.reason}。成功にも失敗にも数えないよ。`,evidenceIds:[p.forecastId,p.reportId,r.evaluationId],similarSuccesses};
    }),cautions:[...p.evidence.risks,"似た条件の成功例があっても、次回の成功や因果関係を保証しません。再下落・流動性・対象範囲を確認してください。"]};
  }
}
