import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { researchOutcomeReportSchema } from "../../../packages/core/research-outcomes";
const pct=(v:number|null)=>v===null?"未計測":`${(v*100).toFixed(2)}%`;
export function ResearchOutcomes({request,jobId}:{request:(url:string,body?:unknown)=>Promise<unknown>;jobId:string|null}) {
  const [open,setOpen]=useState(false);
  const report=useQuery({queryKey:["research-outcomes",jobId],enabled:open,staleTime:30000,queryFn:async()=>researchOutcomeReportSchema.parse(await request(`/research/outcomes${jobId?`?jobId=${jobId}`:""}`))});
  return <details className="card" onToggle={e=>setOpen(e.currentTarget.open)}><summary>スコア帯別の実績検証レポート</summary>
    {report.isFetching&&<p role="status">保存済み予測と評価を集計中…</p>}{report.error&&<p role="alert">実績を読み込めませんでした。</p>}
    {report.data&&<>{report.data.notes.map(n=><p key={n}>{n}</p>)}<p>比較母集団：判定可能{report.data.control.ready}銘柄 ／ 候補{report.data.control.candidates} ／ 非候補{report.data.control.nonCandidates}。非候補の成績は未記録です。</p>
      {!report.data.groups.length&&<p>評価対象の予測がありません。実市場の成績は作成していません。</p>}
      {report.data.groups.map((g,i)=><details key={i}><summary>{g.mode} · {g.experiment} · {g.horizon}営業日 · {g.band}点 ／ 評価済み{g.evaluated}件</summary>
        <p>{g.period} · {g.classification} · {g.methodVersion}</p><p>評価可能{g.eligible} ／ 評価済み{g.evaluated} ／ 銘柄数{g.uniqueCodes} ／ 重複除外{g.excludedOverlap}</p>
        <p>{g.lowSample?"少数標本・信頼性が低い集計です。":"標本間の相関と選択バイアスに注意してください。"}</p>
        <p>平均{pct(g.meanReturn)} ／ 中央値{pct(g.medianReturn)} ／ 上昇割合{pct(g.upRatio)} ／ 最大下落{pct(g.maxDrawdown)}</p>
        <p>下落分布：25%点{pct(g.drawdowns.p25)} · 中央値{pct(g.drawdowns.median)} · 75%点{pct(g.drawdowns.p75)}</p>
        <p>再下落割合{pct(g.relapseRatio)}（記録{g.relapseCount}件） ／ デジャヴ中央値との平均絶対誤差{pct(g.meanAbsoluteError)}</p>
      </details>)}</>}
  </details>;
}
