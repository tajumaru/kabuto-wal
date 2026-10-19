import type { Service } from "./service";
import { targetDate,type Calendar } from "../../../packages/core/index";
import type { ScoutReport } from "../../../packages/core/bottom-scout-schema";
import { scoutForecastSchema,type ScoutForecast } from "../../../packages/core/scout-forecast-schema";
import { hash } from "../../../packages/integrations/adjusted-series";
import { readScoutReport } from "./bottom-scout";
export const forecastBase=(mode:string,recordingMode:string)=>`research/scout/forecasts/${mode}/${recordingMode}`;
const stamp=(date:string)=>date.replace(/[-:.TZ]/g,"");
export const forecastKey=(p:Pick<ScoutForecast,"mode"|"recordingMode"|"createdAt"|"reportId">)=>`${forecastBase(p.mode,p.recordingMode)}/${stamp(p.createdAt)}/${p.reportId}/original.json`;
const ranked=(report:ScoutReport)=>report.rows.filter(r=>r.candidate).slice(0,10).map((r,i)=>({code:r.code,rank:i+1,referencePrice:r.chart.find(b=>b.date===report.asOf)?.close??null,evidenceHash:hash(r)}));
export async function saveScoutForecast(s:Service,report:ScoutReport,calendar:Calendar){
  if(report.cutoff>report.createdAt||report.rows.some(r=>r.asOf!==report.asOf||(r.observedAt&&r.observedAt>report.cutoff)))throw Error("予測時点の取得締切が不整合です");
  const dates=calendar.filter(d=>d.open&&d.date>=report.asOf).sort((a,b)=>a.date.localeCompare(b.date)),end=dates[20]?.date??dates.at(-1)?.date??report.asOf;
  const fixed=calendar.filter(d=>d.date>=report.asOf&&d.date<=end).sort((a,b)=>a.date.localeCompare(b.date));
  const target=(h:number)=>{try{if(new Set(fixed.map(d=>d.date)).size!==fixed.length||!fixed.find(d=>d.date===report.asOf&&d.open))return null;return targetDate(fixed,report.asOf,h);}catch{return null;}};
  const configured=process.env.SCOUT_BENCHMARK_CODE;
  const p=scoutForecastSchema.parse({schemaVersion:1,forecastId:"0".repeat(64),reportId:report.reportId,methodVersion:"scout-forecast-v1",algorithmVersion:report.methodVersion,createdAt:report.createdAt,asOf:report.asOf,cutoff:report.cutoff,mode:report.mode,recordingMode:report.recordingMode,inputHash:report.inputHash,calendar:fixed,calendarHash:hash(fixed),targets:{"5":target(5),"10":target(10),"20":target(20)},benchmarkCode:configured&&/^[0-9A-Z]{5}$/.test(configured)?configured:null,rows:ranked(report)});
  const {forecastId:unused,...body}=p;void unused;p.forecastId=hash(body);
  const key=forecastKey(p),old=await s.store.read(key,null);
  if(old){if(hash(old)!==hash(p))throw Error("予測スナップショットは上書きできません");return p;}
  await s.store.write(key,p,true);return p;
}
export async function readScoutForecast(s:Service,key:string){
  const p=scoutForecastSchema.parse(await s.store.read(key)),{forecastId,...body}=p,report=await readScoutReport(s,p.reportId);
  if(forecastId!==hash(body)||key!==forecastKey(p)||p.calendarHash!==hash(p.calendar)||p.mode!==report.mode||p.recordingMode!==report.recordingMode||p.asOf!==report.asOf||p.createdAt!==report.createdAt||p.cutoff!==report.cutoff||p.inputHash!==report.inputHash||hash(p.rows)!==hash(ranked(report)))throw Error("予測原本と根拠hashが一致しません");
  return {forecast:p,report};
}
