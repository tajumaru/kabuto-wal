import type { CohortObservation } from "./hunter-cohort-report";
import { notebookSummarySchema,type NotebookOriginal,notebookTheme } from "../../../packages/core/kabumaru-notebook-schema";
import { z } from "zod";
import { hash } from "../../../packages/integrations/adjusted-series";
export function notebookPattern(theme:z.infer<typeof notebookTheme>,r:CohortObservation){
  const c=r.member.conditions;
  switch(theme){case "volume-reversal":return c.includes("volume_rebound");case "rsi-recovery":return c.includes("rsi_recovery");case "downtrend-rebound":return r.member.risks.includes("long_trend_down");case "base-building":return r.member.classification==="底固め観察"||c.includes("support");
    case "v-recovery":return c.includes("above_sma5")&&c.includes("sma5_rising")&&c.includes("rsi_recovery");
    case "dejavu-similarity":return false; // Cohorts do not contain frozen similarity features. Never infer them.
    default:return true; // Outcome themes describe the whole fixed cohort; do not select its controls by future returns.
  }
}
export function notebookEvidenceId(body:{groupKey:string;sampleCount:number;reportId:string;cohortIds:string[];evaluationIds:string[]}){return hash([body.groupKey,body.sampleCount,body.reportId,body.cohortIds,body.evaluationIds]);}
export function notebookInsights(note:NotebookOriginal){
  const statements=note.report.groups.map(g=>{
    const e=note.evidence.find(e=>e.groupKey===g.key);if(!e)throw Error("研究ノートの根拠がありません");
    const enough=g.candidate.evaluated>0&&g.control.evaluated>0;
    const text=enough?`${g.mode}・${g.experiment}・${g.horizon}営業日：候補${g.candidate.evaluated}件、非候補${g.control.evaluated}件の平均差は${(g.difference!*100).toFixed(2)}ポイントだよ。${g.lowSample?"少数標本のため、まだ一般化はできないね。":"観測された関連性で、原因や選別能力を証明した結果ではないよ。"}`:`${g.mode}・${g.experiment}・${g.horizon}営業日：候補${g.candidate.evaluated}件、非候補${g.control.evaluated}件。比較データが不足しているため、まだ判断できません。`;
    return {text,evidenceIds:[e.evidenceId],sampleCount:e.sampleCount};
  });
  if(!statements.length)statements.push({text:"このテーマの比較根拠がなく、まだ判断できません。",evidenceIds:[],sampleCount:0});
  return notebookSummarySchema.parse({notebookId:note.notebookId,statements,limitations:note.limitations});
}
