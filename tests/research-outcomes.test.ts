import { it,expect } from "vitest";
import { independentScoreOutcomes,type OutcomeObservation } from "../packages/core/research-outcomes";
const row=(id:string,score:number,asOf="2026-10-01",mode="research"):OutcomeObservation=>({id,score,asOf,target:"2026-10-08",mode,experiment:mode==="live"?"prospective":"retrospective",code:"72030",horizon:5,classification:"底固め観察",methodVersion:"v1",eligible:true,evaluation:{actualReturn:-0.1,predictedReturn:0.1,maxDrawdown:-0.2,relapse:true}});
it("4スコア帯・実験を分離し、悪い結果と少数標本を隠さず、連続日の重複を除く",()=>{
  const input=[row("a",85),row("b",90,"2026-10-02"),row("c",20),row("d",50),row("e",70),row("f",85,"2026-10-01","live")];
  input[2].code="67580";input[3].code="83060";input[4].code="99840";
  const before=JSON.stringify(input),groups=independentScoreOutcomes(input);
  expect(new Set(groups.map(g=>g.band)).size).toBe(4);
  const high=groups.find(g=>g.band==="80-100"&&g.mode==="research")!;
  expect(high).toMatchObject({count:1,evaluated:1,eligible:1,excludedOverlap:1,lowSample:true,meanReturn:-0.1,upRatio:0,meanAbsoluteError:0.2,relapseRatio:1});
  expect(groups.filter(g=>g.band==="80-100")).toHaveLength(2);
  expect(JSON.stringify(input)).toBe(before);
});
it("未評価と旧評価の未記録指標を捏造しない",()=>{
  const a=row("a",85);a.evaluation=undefined;a.eligible=false;
  expect(independentScoreOutcomes([a])[0]).toMatchObject({eligible:0,evaluated:0,meanReturn:null,relapseRatio:null});
  const b=row("b",85);delete b.evaluation!.relapse;
  expect(independentScoreOutcomes([b])[0].relapseRatio).toBeNull();
});
