import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { notebookAnswerSchema,notebookQuestions,type notebookQuestion } from "../../../packages/core/notebook-answer-schema";
import type { z } from "zod";
export function NotebookQuestions({request,research}:{request:(url:string,body?:unknown)=>Promise<unknown>;research:{code:string;asOf:string;jobId?:string;researchId:string}}){
  const client=useQueryClient(),[answer,setAnswer]=useState<z.infer<typeof notebookAnswerSchema>|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function ask(question:z.infer<typeof notebookQuestion>){setBusy(true);setError("");try{setAnswer(await client.fetchQuery({queryKey:["notebook-answer",research.researchId,question],staleTime:30000,queryFn:async()=>notebookAnswerSchema.parse(await request("/research/notebook/answer",{research:{code:research.code,asOf:research.asOf,...(research.jobId?{jobId:research.jobId}:{})},question}))}));}catch(e){setError(e instanceof Error?e.message:"回答できませんでした。");}finally{setBusy(false);}}
  return <details className="card"><summary>研究ノートに質問する</summary><Link to="/research/notebook">かぶまる研究ノートを開く</Link><div className="research-questions">{Object.entries(notebookQuestions).map(([key,label])=><button key={key} disabled={busy} onClick={()=>void ask(key as z.infer<typeof notebookQuestion>)}>{label}</button>)}</div>{busy&&<p role="status">ノート原本と評価を照合中…</p>}{error&&<p role="alert">{error}</p>}{answer&&<div aria-live="polite"><p>参照締切 {answer.cutoff}</p>{answer.statements.map((s,i)=><p key={i}>{s.text}（標本{s.sampleCount}件）</p>)}{answer.references.map(r=><p key={r.notebookId}><Link to={`/research/notebook?id=${r.notebookId}`}>研究ノート原本 · 作成{r.createdAt}</Link> ／ 根拠ID {r.evidenceIds.join("、")||"比較根拠なし"}</p>)}{answer.warnings.map(w=><p key={w}>{w}</p>)}</div>}</details>;
}
