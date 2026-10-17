import { z } from "zod";
import type { Service } from "./service";
import { researchInputSchema } from "../../../packages/core/kabumaru-research-schema";
import { notebookQuestion,notebookAnswerSchema } from "../../../packages/core/notebook-answer-schema";
import { buildKabumaruResearch } from "./kabumaru-research";
import { readNotebook } from "./kabumaru-notebook";
import { notebookInsights } from "./kabumaru-notebook-insights";
import { notebookCatalog } from "./kabumaru-notebook-index";
export async function notebookAnswer(service:Service,raw:unknown){
  const input=z.object({research:researchInputSchema,question:notebookQuestion}).strict().parse(raw),research=await buildKabumaruResearch(service,{...input.research,provider:"deterministic",allowExternalLlm:false,recallRemote:false}),bottom=research.evidence.find(e=>e.kind==="bottom"),conditions=bottom?.kind==="bottom"?bottom.facts.metConditions:[];
  const candidates=(await notebookCatalog(service)).filter(n=>n.createdAt<=research.cutoff&&n.period.to<=research.asOf&&n.mode===research.mode),statements: z.infer<typeof notebookAnswerSchema>["statements"]=[],references:z.infer<typeof notebookAnswerSchema>["references"]=[];
  for(const entry of candidates.slice(0,100)){
    if(references.length>=5)break;
    const id=entry.notebookId;const note=await readNotebook(service,id);
    if(note.createdAt>research.cutoff||note.period.to>research.asOf||note.mode!==research.mode)continue;
    const same=note.successes.concat(note.failures).some(c=>c.conditions.some(code=>conditions.includes(code as typeof conditions[number])));
    if(["same-pattern","failures","notes"].includes(input.question)&&!same)continue;
    const selected=input.question==="high-score"?note.report.groups.map(g=>{const band=g.bands["80-100"],e=note.evidence.find(e=>e.groupKey===g.key)!;return {text:`${g.mode}・${g.experiment}・${g.horizon}営業日：80〜100点の評価${band.evaluated}件、平均${band.meanReturn===null?"未評価":`${(band.meanReturn*100).toFixed(2)}%`}。優位性はまだ判断できません。`,evidenceIds:[e.evidenceId],sampleCount:band.evaluated};})
      :input.question==="failures"?note.failures.filter(c=>c.conditions.some(code=>conditions.includes(code as typeof conditions[number]))).map(c=>({text:`記録された失敗例 ${c.code}・${c.horizon}営業日：${(c.actualReturn*100).toFixed(2)}%。共通条件は原因の証明ではありません。`,evidenceIds:note.evidence.filter(e=>e.evaluationIds.includes(c.evaluationId)).map(e=>e.evidenceId),sampleCount:1}))
      :notebookInsights(note).statements;
    statements.push(...selected);references.push({notebookId:id,createdAt:note.createdAt,evidenceIds:note.evidence.map(e=>e.evidenceId),cohortIds:note.cohortIds,evaluationIds:note.evaluationIds.slice(0,20),evaluationCount:note.evaluationIds.length});
  }
  if(!statements.length)statements.push({text:"この時点で参照できる十分な比較データがなく、まだ判断できません。",evidenceIds:[],sampleCount:0});
  return notebookAnswerSchema.parse({question:input.question,cutoff:research.cutoff,statements:statements.slice(0,20),references,warnings:["研究基準日の取得締切より後に作られたノート・評価は利用しません。","検索は保存済みノート直近100件、回答参照は最大5件・20文、評価参照IDはノートごと先頭20件です。全原本はノート画面から確認できます。全履歴の集計ではありません。","同じ条件の照合は保存済み事例の条件コードの一致です。パターンの同一性や因果関係は断定しません。"]});
}
