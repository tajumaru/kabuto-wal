import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { scoutFixture } from "./bottom-scout";
import { scoutChat } from "../apps/api/src/bottom-scout-chat";
import { readScoutReport,scoutReportKey } from "../apps/api/src/bottom-scout";
import { saveScoutForecast,forecastKey } from "../apps/api/src/bottom-scout-forecast";
import { evaluateScout } from "../apps/api/src/bottom-scout-journal";
import { hash } from "../packages/integrations/adjusted-series";
import type { ScoutReport } from "../packages/core/bottom-scout-schema";

/** Storage workload, not an accuracy/backtest fixture. 1 candidate/report,
 * 25 synthetic symbols, 4 overlapping as-of dates; intentional repeated forecasts. */
export async function scoutScaleFixture(count:number){
 if(!Number.isInteger(count)||count<2||count>10_001)throw Error("fixture size out of range");
 const root=await mkdtemp(path.join(os.tmpdir(),"scout-bench-")),s=new Service(root,"demo",false);
 const json=async(key:string,value:unknown)=>{const dest=s.store.path(key);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,JSON.stringify(value));};
 const seed=await scoutFixture(s,1),reply=await scoutChat(s,"底打ち候補を探して",undefined,seed.now),template=await readScoutReport(s,reply.scout.reportId!);
 const calendar=seed.dates.map(date=>({date,open:true})),now=new Date(`${seed.dates[345]}T12:00:00Z`),baseBars=await s.history("10000");
 await evaluateScout(s,template,now,{evaluationCodes:template.rows.map(r=>r.code)});
 const series=new Map(Array.from({length:25},(_,i)=>{const code=`${1000+i}0`;return [code,baseBars.map((b,j)=>({...b,providerCode:code,seriesId:`fixture-${code}`,revisionId:`fixture-${code}-${j}`}))] as const;}));
 for(const [code,bars] of series)await json(`prices/${code}/fixture.json`,bars);
 // Fast fixture-only writer; production Store/immutability behavior is untouched.
 const writer=new Service(root,"demo",false);writer.store.write=async(key,value)=>json(key,value);
 const reviews=new Map<string,Awaited<ReturnType<typeof evaluateScout>>>();
 let lastReport=template,lastForecast=forecastKey(template),lastEvaluation="";
 const append=async(i:number)=>{
  const code=`${1000+Math.floor(i/4)%25}0`,asOf=seed.dates[316+i%4],bars=series.get(code)!,timestamp=new Date(`${asOf}T14:00:00.000Z`);
  timestamp.setTime(timestamp.getTime()+(1+Math.floor(i/100))*1000);
  const row={...template.rows[0],code,name:`人工負荷試験${code}`,asOf,observedAt:`${asOf}T09:00:00.000Z`,inputRevisionIds:bars.filter(b=>b.sessionDate<=asOf).slice(-80).map(b=>b.revisionId),seriesId:`fixture-${code}`,similar:null,chart:bars.filter(b=>b.sessionDate<=asOf).slice(-20).map(b=>({date:b.sessionDate,close:b.adjClose!}))};
  const {reportId:unused,...base}=template;void unused;
  const body={...base,asOf,createdAt:timestamp.toISOString(),cutoff:`${asOf}T14:00:00.000Z`,inputHash:hash(["synthetic-scale-v1",i]),rows:[row]};
  const report:ScoutReport={...body,reportId:hash(body)};
  await json(scoutReportKey(report.reportId),report);
  const forecast=await saveScoutForecast(writer,report,calendar),key=`${code}/${asOf}`;
  let review=reviews.get(key);
  if(!review){review=await evaluateScout(writer,report,now,{persist:false,forecastId:forecast.forecastId,calendar,benchmarkCode:null,evaluationCodes:[code],loadSeries:async()=>bars});reviews.set(key,review);}
  const {evaluationId:ignored,...raw}=review;void ignored;
  const evaluation={...raw,reportId:report.reportId,forecastId:forecast.forecastId}, {evaluatedAt,...identity}=evaluation;void evaluatedAt;
  const evaluationId=hash(identity),evaluationKey=`research/scout/evaluations/${report.reportId}/${evaluationId}/original.json`;
  await json(evaluationKey,{...evaluation,evaluationId});
  lastReport=report;lastForecast=forecastKey(forecast);lastEvaluation=evaluationKey;
 };
 for(let i=1;i<count;i++)await append(i);
 return {root,s,now,json,append,get lastReport(){return lastReport;},get lastForecast(){return lastForecast;},get lastEvaluation(){return lastEvaluation;},cleanup:async()=>{
  const resolved=path.resolve(root);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith("scout-bench-"))throw Error("unsafe fixture cleanup");
  await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }};
}
