import { PageTitle } from "./PageTitle";
import { useState,useEffect,useRef } from "react";
import { Link,useSearchParams } from "react-router-dom";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { notebookOriginalSchema,notebookSummarySchema,notebookViewSchema,notebookThemes,notebookTheme } from "../../../packages/core/kabumaru-notebook-schema";
import { cohortManifestSchema } from "../../../packages/core/hunter-cohort-schema";
import { hunterStatusSchema } from "../../../packages/core/hunter-schema";
import { cohortEvaluationJobSchema } from "../../../packages/core/cohort-evaluation-job-schema";
import { KabumaruPortrait } from "./Kabumaru";
import { NotebookMemory } from "./NotebookMemory";
import "./KabumaruNotebook.css";
type Request=(url:string,body?:unknown)=>Promise<unknown>;
const pct=(v:number|null)=>v===null?"未評価":`${(v*100).toFixed(2)}%`;
const points=(v:number|null)=>v===null?"未評価":`${(v*100).toFixed(2)}ポイント`;
const historySchema=z.object({records:z.array(notebookOriginalSchema.pick({notebookId:true,theme:true,period:true,createdAt:true,mode:true})),total:z.number()});
export function KabumaruNotebook({request}:{request:Request}){
  const [params,setParams]=useSearchParams(),client=useQueryClient(),[theme,setTheme]=useState<z.infer<typeof notebookTheme>>("volume-reversal"),[hypothesis,setHypothesis]=useState(""),[jobId,setJob]=useState(""),[experiment,setExperiment]=useState("retrospective"),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const page=Math.max(1,Number(params.get("page"))||1),id=params.get("id")??"",cohortId=params.get("cohort")??"";
  const evaluationJobId=params.get("evaluationJob")??"";
  const evaluationJob=useQuery({queryKey:["cohort-evaluation-job",evaluationJobId],enabled:/^[a-f0-9]{64}$/.test(evaluationJobId),queryFn:async()=>z.object({job:cohortEvaluationJobSchema,completedSymbols:z.number(),evaluated:z.number(),pending:z.number(),missing:z.number(),excluded:z.number()}).parse(await request(`/bottom/hunter/cohort-evaluation-jobs/${evaluationJobId}`)),refetchInterval:q=>["queued","running"].includes(q.state.data?.job.status??"")?1000:false});
  const status=useQuery({queryKey:["hunter-status"],queryFn:async()=>hunterStatusSchema.parse(await request("/bottom/hunter/status"))});
  const cohorts=useQuery({queryKey:["notebook-cohorts",page],queryFn:async()=>z.object({records:z.array(cohortManifestSchema),total:z.number()}).parse(await request(`/bottom/hunter/cohorts?page=${page}`))});
  const history=useQuery({queryKey:["notebook-history",page],queryFn:async()=>historySchema.parse(await request(`/research/notebook?page=${page}`))});
  const note=useQuery({queryKey:["notebook-view",id],enabled:/^[a-f0-9]{64}$/.test(id),queryFn:async()=>z.object({view:notebookViewSchema,summary:notebookSummarySchema}).parse(await request(`/research/notebook/${id}/view`))});
  const selected=useRef(id);selected.current=id;
  function update(key:string,value:string){setParams(current=>{const next=new URLSearchParams(current);if(value)next.set(key,value);else next.delete(key);return next;});}
  useEffect(()=>{const key=`notebook-scroll:${params}`;try{window.scrollTo(0,Number(sessionStorage.getItem(key)??0));}catch{/* Optional preference. */}const save=()=>{try{sessionStorage.setItem(key,String(scrollY));}catch{/* Optional preference. */}};window.addEventListener("scroll",save,{passive:true});return()=>window.removeEventListener("scroll",save);},[params]);
  async function act(kind:"cohort"|"evaluate"|"note"){
    setBusy(true);setMessage("");try{
      if(kind==="cohort"){const c=cohortManifestSchema.parse(await request("/bottom/hunter/cohorts",{jobId,experiment}));update("cohort",c.cohortId);setMessage("候補と非候補を同時に固定しました。");}
      else if(kind==="evaluate"){const job=cohortEvaluationJobSchema.parse(await request(`/bottom/hunter/cohorts/${cohortId}/evaluation-jobs`,{}));update("evaluationJob",job.runId);setMessage("保存済み価格で評価するジョブを開始しました。未取得の価格は確定しません。");}
      else{const n=z.object({notebookId:z.string()}).parse(await request("/research/notebook?view=compact",{theme,cohortIds:[cohortId],hypothesis}));update("id",n.notebookId);setMessage("研究ノート原本を保存しました。");}
      await Promise.all([client.invalidateQueries({queryKey:["notebook-cohorts"]}),client.invalidateQueries({queryKey:["notebook-history"]})]);
    }catch(e){setMessage(e instanceof Error?e.message:"処理できませんでした。");}finally{setBusy(false);}
  }
  const original=note.data?.view;
  return <section className="kabumaru-notebook" onClick={event=>{const anchor=(event.target as Element).closest('a[href^="#notebook-evidence-"]');if(!anchor)return;const target=document.getElementById(anchor.getAttribute("href")!.slice(1));if(!target)return;event.preventDefault();let parent:HTMLElement|null=target;while(parent){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}target.scrollIntoView({block:"start"});}}><PageTitle as="header" className="notebook-heading" eyebrow="RESEARCH NOTEBOOK" title="かぶまる研究ノート" description="候補と非候補を同じ時点で固定し、事実と仮説を分けて振り返るよ。" portrait={<KabumaruPortrait pose="analyze" />} />
    <Link to="/research">かぶまるAI研究員へ</Link><Link to="/research/lab">底打ちアルゴリズム実験室へ</Link>
    <section className="card"><h2>固定コホート</h2><p>明示操作で作成します。J-Quantsへの追加取得はありません。</p>
      <label>完了済み分析ジョブ<select value={jobId} onChange={e=>setJob(e.target.value)}><option value="">選択してください</option>{status.data?.jobs.filter(j=>j.status==="completed").map(j=><option key={j.id} value={j.id}>{j.input.asOf} · {j.mode} · {j.id.slice(0,8)}</option>)}</select></label>
      <label>研究区分<select value={experiment} onChange={e=>setExperiment(e.target.value)}><option value="retrospective">過去研究</option><option value="prospective">実運用の事前記録（当日のみ）</option><option value="walk-forward">walk-forward</option></select></label>
      <button disabled={busy||!jobId} onClick={()=>void act("cohort")}>固定コホートを作成</button>
      <label>保存済みコホート<select value={cohortId} onChange={e=>update("cohort",e.target.value)}><option value="">選択してください</option>{cohorts.data?.records.map(c=><option key={c.cohortId} value={c.cohortId}>{c.asOf} · {c.experiment} · {c.memberCount}銘柄 · {c.cohortId.slice(0,8)}</option>)}</select></label>
      <button disabled={busy||!cohortId} onClick={()=>void act("evaluate")}>期限後評価を実行</button>
      {evaluationJob.data&&evaluationJob.data.job.cohortId===cohortId&&<div aria-live="polite"><p role="status">保存済み価格で評価：{evaluationJob.data.job.status} ／ {evaluationJob.data.completedSymbols}/{evaluationJob.data.job.symbolTotal}銘柄 ／ 評価済{evaluationJob.data.evaluated}・価格不足{evaluationJob.data.missing}・計算失敗{evaluationJob.data.job.failed}</p>{(["pause","cancel","resume"] as const).map(action=><button key={action} disabled={busy||evaluationJob.data.job.status==="completed"} onClick={()=>{void request(`/bottom/hunter/cohort-evaluation-jobs/${evaluationJobId}/control`,{action}).then(()=>client.invalidateQueries({queryKey:["cohort-evaluation-job",evaluationJobId]})).catch(e=>setMessage(e instanceof Error?e.message:"操作できませんでした"));}}>{action==="pause"?"評価を中断":action==="cancel"?"評価をキャンセル":"評価を再開"}</button>)}</div>}
      {evaluationJob.error&&<p role="alert">評価ジョブを確認できません。{evaluationJob.error.message}</p>}
    </section>
    <section className="card"><h2>研究テーマ一覧</h2><label>テーマ<select aria-label="テーマ" value={theme} onChange={e=>setTheme(notebookTheme.parse(e.target.value))}>{notebookTheme.options.map(t=><option key={t} value={t}>{notebookThemes[t]}</option>)}</select></label>
      <label>研究時点の仮説（観測事実とは別）<textarea maxLength={500} value={hypothesis} onChange={e=>setHypothesis(e.target.value)}/></label>
      <button disabled={busy||!cohortId||!!evaluationJob.data&&evaluationJob.data.job.cohortId===cohortId&&evaluationJob.data.job.status!=="completed"} onClick={()=>void act("note")}>研究ノートを作成</button><p>未評価・標本不足も保存し、根拠のない成績を補完しません。</p>
    </section>
    {busy&&<p role="status">原本を確認中…</p>}{message&&<p role="status">{message}</p>}
    {(cohorts.error||history.error||status.error||note.error)&&<p role="alert">保存済みデータを確認できません。{(note.error??cohorts.error??history.error??status.error)?.message}</p>}
    {note.isFetching&&id&&<p role="status">研究ノートとEvidenceを照合中…</p>}
    {original&&selected.current===original.notebookId&&<><h2>{notebookThemes[original.theme]}</h2><p>{original.mode} · {original.period.from}〜{original.period.to} ／ 作成 {original.createdAt} ／ {original.methodVersion}</p><p>仮説：{original.hypothesis||"未指定"}</p>
      <section className="card"><h2>候補・非候補の比較</h2>{original.report.groups.length===0&&<p>このテーマは比較できる根拠がなく、まだ判断できません。</p>}{original.report.groups.map(g=><article key={g.key}><h3>{g.mode} · {g.experiment} · {g.horizon}営業日</h3><p>候補{g.candidate.evaluated}/{g.candidate.count}件：平均{pct(g.candidate.meanReturn)}・中央値{pct(g.candidate.medianReturn)}・上昇割合{pct(g.candidate.upRatio)}</p><p>非候補{g.control.evaluated}/{g.control.count}件：平均{pct(g.control.meanReturn)}・中央値{pct(g.control.medianReturn)}・上昇割合{pct(g.control.upRatio)}</p><p>{original.report.comparisonMethod==="paired-v2"?"同時点比較の平均差":"群平均差（旧方式）"}{points(g.difference)} ／ 探索的区間{g.interval?`${points(g.interval[0])}〜${points(g.interval[1])}`:"標本不足のため表示しません"}</p>{g.pooledDifference!==undefined&&<p>銘柄数で重み付けした群平均差：{points(g.pooledDifference)} ／ 対応する時点{g.matchedDates}件</p>}<p>終値ベース最大下落：候補{pct(g.candidate.maxDrawdown)}／非候補{pct(g.control.maxDrawdown)}。再下落：候補{pct(g.candidate.relapseRatio)}／非候補{pct(g.control.relapseRatio)}</p><p>未取得・未評価{g.candidate.missing+g.control.missing}（未実行・期限前等{g.candidate.pending+g.control.pending}／価格不足{g.candidate.unavailable+g.control.unavailable}） ／ 判定不能等の除外{g.excludedMembers} ／ 重複除外{g.excludedOverlap} ／ {g.uniqueCodes}銘柄・{g.dates}時点</p>{g.lowSample&&<strong>標本不足・信頼性が低い探索的結果です。</strong>}
        <h3>スコア帯別実績</h3><div role="img" aria-label={`${g.horizon}営業日後のスコア帯別平均騰落率`}>{Object.entries(g.bands).map(([band,m])=><div className="notebook-band" key={band}><span>{band}点 · {m.evaluated}件</span><meter min={-1} max={1} value={m.meanReturn??0}/><span>{pct(m.meanReturn)}</span></div>)}</div>
      </article>)}</section>
      <section className="card"><h2>成功事例と失敗事例</h2>{[["成功例",original.successes],["失敗例",original.failures]].map(([title,cases])=><div key={title as string}><h3>{title as string}</h3>{(cases as typeof original.successes).length===0&&<p>確認できる事例がありません。</p>}{(cases as typeof original.successes).map(c=><p key={c.evaluationId}>{c.code} · {c.horizon}営業日 · {c.candidate?"候補":"非候補"} · {c.score??"判定不能"}点 · {pct(c.actualReturn)} ／ 評価ID {c.evaluationId}</p>)}</div>)}</section>
      <section className="card"><h2>かぶまるの研究コメント</h2>{note.data?.summary.statements.map((s,i)=><p key={i}>{s.text}（標本{s.sampleCount}件）{s.evidenceIds.map(e=><a key={e} href={`#notebook-evidence-${e}`}>根拠</a>)}</p>)}<h3>信頼性・データ不足</h3>{original.limitations.map((l,i)=><p key={i}>{l}</p>)}<p>次回確認する条件：{original.nextConditions.join("、")}</p></section>
      <details className="card"><summary>Evidence一覧</summary>{original.evidence.map(e=><NotebookEvidence key={e.evidenceId} notebookId={original.notebookId} evidence={e} request={request}/>)}</details>
      <NotebookMemory key={original.notebookId} id={original.notebookId} theme={original.theme} createdAt={original.createdAt} request={request}/>
    </>}
    <section className="card"><h2>過去の研究ノート履歴</h2>{history.isLoading&&<p role="status">履歴を読み込み中…</p>}{history.data?.records.length===0&&<p>保存済み研究ノートはありません。</p>}{history.data?.records.map(n=><p key={n.notebookId}><Link to={`?id=${n.notebookId}&page=${page}`}>{notebookThemes[n.theme]} · {n.period.from}〜{n.period.to} · {n.mode}</Link></p>)}<button disabled={page<=1} onClick={()=>update("page",String(page-1))}>前のページ</button><span>{page}ページ</span><button disabled={page*20>=Math.max(cohorts.data?.total??0,history.data?.total??0)} onClick={()=>update("page",String(page+1))}>次のページ</button></section>
  </section>;
}
function NotebookEvidence({notebookId,evidence,request}:{notebookId:string;evidence:z.infer<typeof notebookViewSchema>["evidence"][number];request:Request}){
  const [open,setOpen]=useState(false),[page,setPage]=useState(1),query=useQuery({queryKey:["notebook-evidence",notebookId,evidence.evidenceId,page],enabled:open,queryFn:async()=>z.object({evaluationIds:z.array(z.string()),total:z.number()}).parse(await request(`/research/notebook/${notebookId}/evidence/${evidence.evidenceId}?page=${page}`))});
  return <details id={`notebook-evidence-${evidence.evidenceId}`} onToggle={e=>setOpen(e.currentTarget.open)}><summary>根拠 {evidence.evidenceId.slice(0,12)} · {evidence.sampleCount}件</summary>{open&&<><p>{evidence.evidenceId}</p><p>コホートID {evidence.cohortIds.join("、")}</p><p>評価revision {evidence.evaluationCount}件 ／ {page}ページ</p>{query.isFetching&&<p role="status">評価参照を読み込み中…</p>}{query.error&&<p role="alert">評価参照を確認できませんでした。</p>}<pre>{query.data?.evaluationIds.join("\n")||"評価原本はありません。"}</pre><button disabled={page<=1} onClick={()=>setPage(page-1)}>前の評価参照</button><button disabled={page*100>=(query.data?.total??0)} onClick={()=>setPage(page+1)}>次の評価参照</button></>}</details>;
}
