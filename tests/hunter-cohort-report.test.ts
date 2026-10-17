import { it,expect } from "vitest";
import { comparativeCohortReport,type CohortObservation } from "../apps/api/src/hunter-cohort-report";
import { cohortManifestSchema,cohortMemberSchema,cohortEvaluationSchema } from "../packages/core/hunter-cohort-schema";
export function observation(candidate:boolean,code="72030",asOf="2026-08-10"):CohortObservation{
  const target=new Date(Date.parse(asOf)+86400000).toISOString().slice(0,10),id="a".repeat(64);
  return {horizon:1,cohort:cohortManifestSchema.parse({schemaVersion:1,cohortId:id,jobId:"11111111-1111-4111-8111-111111111111",datasetId:"dataset",analysisId:"analysis",asOf,cutoff:`${asOf}T09:00:00.000Z`,methodVersion:"bottom-hunter-v1",scoringVersions:["fixture-score-v1"],cohortMethod:"hunter-cohort-v1",universeId:"universe",createdAt:`${asOf}T10:00:00.000Z`,mode:"research",experiment:"retrospective",plan:"Light",delayDays:0,targets:{1:target,5:target,20:target},memberCount:1,shards:[]}),
    member:cohortMemberSchema.parse({code,score:candidate?85:35,candidate,classification:"底固め観察",referencePrice:100,inputRevisionIds:["r"],eligible:true,exclusionReasons:[],conditions:["rsi_recovery"],risks:[],indicators:{},adjustmentVersion:"raw-factor-asof-v1"}),
    evaluation:cohortEvaluationSchema.parse({schemaVersion:1,evaluationId:"b".repeat(64),cohortId:id,code,horizon:1,target,status:"evaluated",reasons:[],actualReturn:candidate?-0.2:0.1,up:!candidate,maxDrawdown:candidate?-0.3:0,maxRise:0.1,relapse:candidate,inputRevisionIds:["r"],evaluatedAt:"2026-10-17T00:00:00.000Z",evaluationCutoff:"2026-10-17T00:00:00.000Z",dataAvailableAt:"2026-10-16T00:00:00.000Z",adjustmentVersion:"raw-factor-asof-v1",basePrice:100,targetPrice:candidate?80:110})};
}
it("候補・非候補の負の差、4帯、未取得と標本不足を隠さない",()=>{
  const a=observation(true),b=observation(false,"67580"),missing=observation(false,"99840");missing.evaluation=undefined;
  const excluded=observation(false,"130A0");excluded.member.eligible=false;excluded.member.score=null;
  const report=comparativeCohortReport([a,b,missing,excluded],[a.cohort.cohortId]);
  expect(report.groups[0]).toMatchObject({candidate:{evaluated:1,meanReturn:-0.2},control:{evaluated:1,missing:1},excludedMembers:1,lowSample:true,interval:null});
  expect(report.groups[0].difference).toBeCloseTo(-0.3);expect(Object.keys(report.groups[0].bands)).toHaveLength(4);
});
it("連続日の選択を結果から独立させ、実運用と過去研究を混ぜない",()=>{
  const a=observation(true),b=observation(true,"72030","2026-08-11"),c=observation(true);b.evaluation=undefined;c.cohort.experiment="prospective";
  const r=comparativeCohortReport([a,b,c],[]);expect(r.groups).toHaveLength(2);expect(r.groups.find(g=>g.experiment==="retrospective")!.excludedOverlap).toBe(1);
});
it("十分な銘柄・時点がある場合だけ探索的な二軸区間を決定的に計算する",()=>{
  const rows:CohortObservation[]=[];for(let d=0;d<10;d++)for(let c=0;c<40;c++)rows.push(observation(c<20,String(10000+c),new Date(Date.UTC(2026,0,5+d*7)).toISOString().slice(0,10)));
  const a=comparativeCohortReport(rows,[]),b=comparativeCohortReport(rows,[]);expect(a.groups[0].interval).not.toBeNull();expect(a.groups[0].interval).toEqual(b.groups[0].interval);expect(a.groups[0].interval![1]).toBeLessThan(0);
});
it("時点ごとの銘柄数の偏りで差が逆転しても、同時点比較を主指標にする",()=>{
  const rows:CohortObservation[]=[];
  const add=(candidate:boolean,code:string,date:string,value:number)=>{const r=observation(candidate,code,date);r.evaluation={...r.evaluation!,actualReturn:value,targetPrice:100*(1+value),up:value>0,maxDrawdown:Math.min(value,0),maxRise:Math.max(value,0)};rows.push(r);};
  for(let i=0;i<100;i++){add(true,String(20000+i),"2026-08-10",0.1);add(false,String(30000+i),"2026-09-07",-0.1);}
  add(false,"50000","2026-08-10",0.2);add(true,"40000","2026-09-07",-0.2);
  const report=comparativeCohortReport(rows,[]);expect(report.comparisonMethod).toBe("paired-v2");expect(report.groups[0].difference).toBeCloseTo(-0.1);expect(report.groups[0].pooledDifference).toBeGreaterThan(0);
  const old=comparativeCohortReport(rows,[],new Date(),"pooled-v1");expect(old.comparisonMethod).toBeUndefined();expect(old.groups[0].difference).toBeGreaterThan(0);
});
