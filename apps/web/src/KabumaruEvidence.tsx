import type { ResearchEvidence } from "../../../packages/core/kabumaru-research-schema";
import { useEffect,useState } from "react";

const labels = { bottom: "底打ち判定", dejavu: "過去の類似相場", forecast: "予測原本", evaluation: "期限後の評価", memory: "原本と照合した記憶" };
export function KabumaruEvidence({ evidence }: { evidence: ResearchEvidence[] }) {
  const [opened,setOpened]=useState<Set<string>>(new Set());
  useEffect(()=>{const id=location.hash.slice(1),element=document.getElementById(id);if(element instanceof HTMLDetailsElement){element.open=true;element.scrollIntoView();}},[]);
  return <section className="card research-evidence"><h2>根拠一覧</h2><p>MemWalの文章を原本として扱わず、保存済みの分析・予測・評価を参照しています。</p>
    {!evidence.length && <p>確認できる根拠がありません。</p>}
    {evidence.map(e => <details key={e.evidenceId} id={`evidence-${e.evidenceId}`} onToggle={event=>{const open=event.currentTarget.open;setOpened(current=>{const next=new Set(current);if(open)next.add(e.evidenceId);else next.delete(e.evidenceId);return next;});}}><summary>{labels[e.kind]} · {e.asOf}</summary>
      {opened.has(e.evidenceId)&&<>
      <p>根拠ID：<code>{e.evidenceId}</code></p><p>原本参照：<code>{e.sourceId}</code></p><p>取得締切：{e.cutoff} ／ 方式：{e.methodVersion}</p>
      <pre>{JSON.stringify(e.facts, null, 2)}</pre>{e.limitations.map(text => <p key={text}>{text}</p>)}
      <details><summary>入力revision（{e.revisionIds.length}件）</summary><pre>{e.revisionIds.join("\n") || "参照元のEvidenceを確認してください。"}</pre></details></>}
    </details>)}
  </section>;
}
