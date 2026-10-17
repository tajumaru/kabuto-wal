import { z } from "zod";
import { hunterDistribution, hunterScoreBand } from "./hunter-method";
export const researchOutcomeGroupSchema = z.object({ mode:z.string(),experiment:z.string(),horizon:z.number(),band:z.string(),classification:z.string(),period:z.string(),methodVersion:z.string(),
  count:z.number(),eligible:z.number(),evaluated:z.number(),excludedOverlap:z.number(),uniqueCodes:z.number(),lowSample:z.boolean(),
  meanReturn:z.number().nullable(),medianReturn:z.number().nullable(),upRatio:z.number().nullable(),maxDrawdown:z.number().nullable(),drawdowns:z.object({min:z.number().nullable(),p25:z.number().nullable(),median:z.number().nullable(),p75:z.number().nullable(),max:z.number().nullable()}),
  relapseCount:z.number(),relapseRatio:z.number().nullable(),meanAbsoluteError:z.number().nullable() });
export const researchOutcomeReportSchema = z.object({ groups:z.array(researchOutcomeGroupSchema),notes:z.array(z.string()),control:z.object({jobId:z.string().nullable(),ready:z.number(),candidates:z.number(),nonCandidates:z.number(),bands:z.record(z.string(),z.number()),outcomes:z.literal("not-recorded")}) });
export type OutcomeObservation = { id:string;code:string;asOf:string;target:string;mode:string;experiment:string;horizon:number;score:number|null;classification:string;methodVersion:string;
  eligible:boolean;evaluation?:{actualReturn:number;predictedReturn:number;maxDrawdown:number|null;relapse?:boolean} };
export function independentScoreOutcomes(observations: OutcomeObservation[]) {
  const groups = new Map<string,{ rows:OutcomeObservation[];excluded:number;prototype:OutcomeObservation }>();
  const ends = new Map<string,string>();
  // Earliest observation wins across bands/classifications; no outcome-dependent selection.
  for (const r of [...observations].sort((a,b)=>a.asOf.localeCompare(b.asOf)||a.id.localeCompare(b.id))) {
    const band=hunterScoreBand(r.score), key=JSON.stringify([r.mode,r.experiment,r.horizon,band,r.classification,r.asOf.slice(0,7),r.methodVersion]);
    const group=groups.get(key)??{rows:[],excluded:0,prototype:r}; groups.set(key,group);
    const series=JSON.stringify([r.mode,r.experiment,r.horizon,r.methodVersion,r.code]);
    if ((ends.get(series)??"") >= r.asOf) { group.excluded++; continue; }
    ends.set(series,r.target); group.rows.push(r);
  }
  return [...groups.values()].map(g=>{
    const p=g.prototype, ev=g.rows.flatMap(r=>r.evaluation?[r.evaluation]:[]), returns=ev.map(e=>e.actualReturn),drawdowns=ev.flatMap(e=>e.maxDrawdown===null?[]:[e.maxDrawdown]),relapses=ev.filter(e=>e.relapse!==undefined);
    return researchOutcomeGroupSchema.parse({mode:p.mode,experiment:p.experiment,horizon:p.horizon,band:hunterScoreBand(p.score),classification:p.classification,period:p.asOf.slice(0,7),methodVersion:p.methodVersion,
      count:g.rows.length,eligible:g.rows.filter(r=>r.eligible).length,evaluated:ev.length,excludedOverlap:g.excluded,uniqueCodes:new Set(g.rows.map(r=>r.code)).size,lowSample:ev.length<20||new Set(g.rows.map(r=>r.code)).size<20,
      meanReturn:ev.length?returns.reduce((a,b)=>a+b,0)/ev.length:null,medianReturn:hunterDistribution(returns).median,upRatio:ev.length?returns.filter(v=>v>0).length/ev.length:null,
      maxDrawdown:drawdowns.length?Math.min(...drawdowns):null,drawdowns:hunterDistribution(drawdowns),relapseCount:relapses.length,relapseRatio:relapses.length?relapses.filter(e=>e.relapse).length/relapses.length:null,
      meanAbsoluteError:ev.length?ev.reduce((a,e)=>a+Math.abs(e.actualReturn-e.predictedReturn),0)/ev.length:null});
  });
}
