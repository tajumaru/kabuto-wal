import { cohortBase,readCohort } from "./hunter-cohort";
import { cohortEvaluations } from "./hunter-cohort-evaluation";
import { cohortManifestSchema,type CohortMember,type CohortManifest,type CohortEvaluation } from "../../../packages/core/hunter-cohort-schema";
import { cohortReportSchema } from "../../../packages/core/hunter-cohort-report-schema";
import { hunterDistribution,hunterScoreBand } from "../../../packages/core/hunter-method";
import { hash } from "../../../packages/integrations/adjusted-series";
import type { Service } from "./service";
export type CohortObservation={cohort:CohortManifest;member:CohortMember;horizon:1|5|20;evaluation?:CohortEvaluation};
export async function cohortObservations(service:Service,ids:string[],cutoff:string){
  const rows:CohortObservation[]=[];
  for(const id of ids){const {manifest:cohort,members}=await readCohort(service,id);if(cohort.createdAt>cutoff||cohort.cutoff>cutoff)continue;
    const evaluations=await cohortEvaluations(service,id,cutoff),latest=new Map<string,CohortEvaluation>();
    for(const e of evaluations.sort((a,b)=>a.evaluationCutoff.localeCompare(b.evaluationCutoff)||a.evaluatedAt.localeCompare(b.evaluatedAt)||a.evaluationId.localeCompare(b.evaluationId)))latest.set(`${e.code}/${e.horizon}`,e);
    for(const member of members)for(const horizon of [1,5,20] as const)rows.push({cohort,member,horizon,evaluation:latest.get(`${member.code}/${horizon}`)});
  }return rows;
}
export function cohortMetrics(rows:CohortObservation[]){
  const ev=rows.flatMap(r=>r.evaluation?.status==="evaluated"?[r.evaluation]:[]),returns=ev.map(e=>e.actualReturn!);
  return {count:rows.length,evaluated:ev.length,missing:rows.filter(r=>r.evaluation?.status!=="evaluated").length,pending:rows.filter(r=>!r.evaluation||r.evaluation.status==="pending").length,unavailable:rows.filter(r=>r.evaluation?.status==="missing").length,upRatio:ev.length?ev.filter(e=>e.up).length/ev.length:null,meanReturn:ev.length?returns.reduce((a,b)=>a+b,0)/ev.length:null,medianReturn:hunterDistribution(returns).median,maxDrawdown:ev.length?ev.reduce((minimum,e)=>Math.min(minimum,e.maxDrawdown!),0):null,relapseRatio:ev.length?ev.filter(e=>e.relapse).length/ev.length:null};
}
export function pairedCohortDifference(rows:CohortObservation[],codeWeights?:Map<string,number>,dateWeights?:Map<string,number>){
  const strata=new Map<string,{date:string;a:number;b:number;an:number;bn:number}>();
  for(const r of rows){if(r.evaluation?.status!=="evaluated")continue;const key=JSON.stringify([r.cohort.cohortId,r.cohort.asOf,r.cohort.cutoff]),s=strata.get(key)??{date:r.cohort.asOf,a:0,b:0,an:0,bn:0},w=codeWeights?codeWeights.get(r.member.code)??0:1;
    if(r.member.candidate){s.a+=w*r.evaluation.actualReturn!;s.an+=w;}else{s.b+=w*r.evaluation.actualReturn!;s.bn+=w;}strata.set(key,s);
  }
  const dates=new Map<string,number[]>();for(const s of strata.values())if(s.an&&s.bn)dates.set(s.date,[...(dates.get(s.date)??[]),s.a/s.an-s.b/s.bn]);
  let sum=0,total=0;for(const [date,values] of dates){const w=dateWeights?dateWeights.get(date)??0:1;sum+=w*values.reduce((a,b)=>a+b,0)/values.length;total+=w;}
  return {value:total?sum/total:null,dates:dates.size};
}
function interval(rows:CohortObservation[],seed:string,paired:boolean):[number,number]|null{
  const ev=rows.filter(r=>r.evaluation?.status==="evaluated"),codes=[...new Set(ev.map(r=>r.member.code))],dates=[...new Set(ev.map(r=>r.cohort.asOf))].sort();
  if(codes.length<20||dates.length<10||(paired&&pairedCohortDifference(ev).dates<10)||[true,false].some(candidate=>ev.filter(r=>r.member.candidate===candidate).length<20))return null;
  let state=parseInt(seed.slice(0,8),16);const random=(n:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;},samples:number[]=[];
  for(let i=0;i<400;i++){
    const cw=new Map<string,number>(),dw=new Map<string,number>();for(let j=0;j<codes.length;j++){const c=codes[random(codes.length)];cw.set(c,(cw.get(c)??0)+1);}
    for(let j=0;j<dates.length;j+=5){const start=random(dates.length);for(let k=0;k<Math.min(5,dates.length-j);k++){const d=dates[(start+k)%dates.length];dw.set(d,(dw.get(d)??0)+1);}}
    let a=0,b=0,an=0,bn=0;for(const r of ev){const w=(cw.get(r.member.code)??0)*(dw.get(r.cohort.asOf)??0);if(r.member.candidate){a+=w*r.evaluation!.actualReturn!;an+=w;}else{b+=w*r.evaluation!.actualReturn!;bn+=w;}}
    if(paired){const sample=pairedCohortDifference(ev,cw,dw).value;if(sample!==null)samples.push(sample);}else if(an&&bn)samples.push(a/an-b/bn);
  }
  if(samples.length<300)return null;samples.sort((a,b)=>a-b);return [samples[Math.floor(samples.length*.025)],samples[Math.floor(samples.length*.975)]];
}
export function comparativeCohortReport(observations:CohortObservation[],cohortIds:string[],now=new Date(),comparison:"paired-v2"|"pooled-v1"="paired-v2"){
  const groups=new Map<string,{rows:CohortObservation[];excludedOverlap:number;excludedMembers:number}>(),ends=new Map<string,string>();
  for(const r of [...observations].sort((a,b)=>a.cohort.asOf.localeCompare(b.cohort.asOf)||a.cohort.createdAt.localeCompare(b.cohort.createdAt)||a.cohort.cohortId.localeCompare(b.cohort.cohortId))){
    const key=JSON.stringify([r.cohort.mode,r.cohort.experiment,JSON.stringify([r.cohort.methodVersion,r.cohort.scoringVersions]),r.cohort.plan,r.horizon]),g=groups.get(key)??{rows:[],excludedOverlap:0,excludedMembers:0};groups.set(key,g);
    if(!r.member.eligible){g.excludedMembers++;continue;}
    const series=key+r.member.code,last=ends.get(series);if(last&&last>=r.cohort.asOf){g.excludedOverlap++;continue;}
    // Use planned result windows, not realized outcomes, for overlap exclusion.
    const target=r.cohort.targets[String(r.horizon) as "1"|"5"|"20"];if(target)ends.set(series,target);else ends.set(series,"9999-12-31");g.rows.push(r);
  }
  const evaluationIds=[...new Set(observations.flatMap(r=>r.evaluation?[r.evaluation.evaluationId]:[]))].sort();
  const reportId=hash([comparison==="paired-v2"?"cohort-comparison-v2":"cohort-comparison-v1",cohortIds,evaluationIds,observations.map(r=>[r.cohort.cohortId,r.member.code,r.horizon])]);
  const report=[...groups].map(([key,g])=>{const [mode,experiment,methodVersion,plan,horizon]=JSON.parse(key) as [string,string,string,string,number],candidate=cohortMetrics(g.rows.filter(r=>r.member.candidate)),control=cohortMetrics(g.rows.filter(r=>!r.member.candidate)),codes=new Set(g.rows.map(r=>r.member.code)).size,dates=new Set(g.rows.map(r=>r.cohort.asOf)).size;
    const pooled=candidate.meanReturn!==null&&control.meanReturn!==null?candidate.meanReturn-control.meanReturn:null,paired=pairedCohortDifference(g.rows);
    return {key,mode,experiment,methodVersion,plan,horizon,candidate,control,difference:comparison==="paired-v2"?paired.value:pooled,interval:interval(g.rows,reportId,comparison==="paired-v2"),intervalMethod:"exploratory-code-date-block-bootstrap-v1" as const,uniqueCodes:codes,dates,excludedOverlap:g.excludedOverlap,excludedMembers:g.excludedMembers,lowSample:candidate.evaluated<20||control.evaluated<20||codes<20||dates<10||(comparison==="paired-v2"&&paired.dates<10),...(comparison==="paired-v2"?{pooledDifference:pooled,matchedDates:paired.dates}:{}),bands:Object.fromEntries(["0-39","40-59","60-79","80-100"].map(band=>[band,cohortMetrics(g.rows.filter(r=>hunterScoreBand(r.member.score)===band))]))};});
  return cohortReportSchema.parse({reportId,generatedAt:now.toISOString(),cohortIds,evaluationIds,groups:report,...(comparison==="paired-v2"?{comparisonMethod:comparison}:{}),notes:[...(comparison==="paired-v2"?["主比較は同一コホート内の差を計算し、同一時点内・時点間を均等に平均します。銘柄数で重み付けした群平均差とは異なる場合があります。"]:[]),"候補と非候補は同一コホート・取得締切・営業日・調整基準で比較。判定不能は非候補へ含めません。","同一銘柄の重複結果窓を日付順に除外。未評価も除外選択の基準にはしません。","区間は銘柄クラスタと5時点の連続ブロックの再標本化による探索的区間。選別能力の証明ではありません。","市場全体・業種・時価総額の偏り、上場廃止を含む生存者バイアス、未取得銘柄の影響は未調整。取引コスト控除前。契約遅延にも注意してください。","80点以上の優位性は仮定しません。スコアは上昇確率ではありません。"]});
}
export async function listCohortIds(service:Service){return (await service.store.files("market/hunter/cohorts")).filter(f=>f.endsWith("/manifest.json")).map(f=>f.split("/").at(-2)!);}
export async function cohortReport(service:Service,ids:string[],now=new Date()){
  if(ids.length>100)throw Error("1回の比較は100コホートまでです");
  for(const id of ids){const m=cohortManifestSchema.parse(await service.store.read(`${cohortBase(id)}/manifest.json`));if(m.mode!==(service.mode==="demo"?"demo":"research"))throw Error("比較区分不一致");}
  return comparativeCohortReport(await cohortObservations(service,[...new Set(ids)],now.toISOString()),[...new Set(ids)],now);
}
