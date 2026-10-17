import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { researchInputSchema, researchResultSchema, type ResearchResult } from "../../../packages/core/kabumaru-research-schema";
import { hunterStatusSchema } from "../../../packages/core/hunter-schema";
import { KabumaruPortrait } from "./Kabumaru";
const KabumaruEvidence = lazy(() => import("./KabumaruEvidence").then(m=>({default:m.KabumaruEvidence})));
import { displayStockCode } from "./stock-search";
import { StockPicker } from "./StockPicker";
const ResearchOutcomes = lazy(() => import("./ResearchOutcomes").then(m=>({default:m.ResearchOutcomes})));
import "./KabumaruResearch.css";

type Request = (url: string, body?: unknown) => Promise<unknown>;
const questions = [
  ["why", "なぜこの銘柄が底打ち候補なの？"], ["similar", "過去に似た相場はあった？"], ["risk", "この銘柄のリスクは？"],
  ["high-score", "スコア80点以上の過去成績は？"], ["outcome", "過去の予測は当たった？"], ["watch", "どの条件が変わったら評価が変わる？"],
] as const;
const sectionNames = { summary: "研究サマリー", bullish: "強気の根拠", bearish: "弱気の根拠", dejavu: "デジャヴ相場との比較", reflection: "過去予測の検証・反省", watch: "次に観察する条件", uncertainty: "不確実性" };
const answerSections: Record<string, string[]> = { why: ["summary", "bullish"], similar: ["dejavu"], risk: ["bearish", "uncertainty"], "high-score": ["reflection"], outcome: ["reflection"], watch: ["watch"] };
export function KabumaruResearch({ request }: { request: Request }) {
  const [params, setParams] = useSearchParams();
  const [chat, setChat] = useState<ResearchResult | null>(null), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [saveHistory, setSaveHistory] = useState(false), [allowLlm, setAllowLlm] = useState(false);
  const [diagnostic, setDiagnostic] = useState<unknown>(null);
  const [evidenceOpen,setEvidenceOpen]=useState(false),[reportOpen,setReportOpen]=useState(false);
  const raw = Object.fromEntries([...params].filter(([k]) => ["code", "asOf", "jobId"].includes(k)));
  const parsed = researchInputSchema.safeParse(raw), key = JSON.stringify(raw);
  const currentKey=useRef(key); currentKey.current=key;
  const research = useQuery({ queryKey: ["kabumaru-research", key], enabled: parsed.success, staleTime: 30000,
    queryFn: async () => researchResultSchema.parse(await request("/research", parsed.success ? parsed.data : {})) });
  const status = useQuery({ queryKey: ["hunter-status"], queryFn: async () => hunterStatusSchema.parse(await request("/bottom/hunter/status")) });
  const master = useQuery({ queryKey: ["/master"], queryFn: async () => z.array(z.object({ providerCode: z.string(), name: z.string(), displayCode: z.string().optional() })).parse(await request("/master")) });
  const result = research.data;
  const hasResult=!!result;
  useEffect(()=>{setChat(null);setDiagnostic(null);setMessage("");setBusy(false);setAllowLlm(false);setEvidenceOpen(false);},[key]);
  const restored=useRef("");
  useLayoutEffect(()=>{
    if(!hasResult||restored.current===key)return;
    restored.current=key;
    try{window.scrollTo(0,Number(sessionStorage.getItem(`research-scroll:${key}`)??0));}catch{/* Storage may be disabled. */}
    const save=()=>{try{sessionStorage.setItem(`research-scroll:${key}`,String(window.scrollY));}catch{/* Optional preference. */}};
    window.addEventListener("scroll",save,{passive:true});return()=>window.removeEventListener("scroll",save);
  },[key,hasResult]);
  const activeChat = chat && chat.researchId===result?.researchId && chat.code === result?.code && chat.asOf === result.asOf && chat.jobId === result.jobId ? chat : null;
  function update(k: string, value: string) {
    setParams(current => { const next = new URLSearchParams(current); if (value) next.set(k,value); else next.delete(k); if (k !== "jobId") next.delete("jobId"); return next; });
    setChat(null); setDiagnostic(null); setMessage("");
  }
  async function act(kind: "chat" | "save" | "memory" | "llm" | "diagnostic", question = "summary") {
    if (!parsed.success) return;
    const requestKey=key;
    if(kind==="chat"&&!saveHistory&&result){setChat({...result,question:researchInputSchema.shape.question.parse(question)});return;}
    setBusy(true); setMessage("");
    try {
      const body = { ...parsed.data, question, provider: kind === "llm" ? "configured-llm" : "deterministic", allowExternalLlm: kind === "llm" && allowLlm, recallRemote: kind === "memory" };
      if (kind === "save") {
        const response = z.object({ note: z.string() }).parse(await request("/research/save", body)); if(currentKey.current===requestKey)setMessage(response.note);
      } else if (kind === "diagnostic") {const response=await request("/research/diagnostics", body);if(currentKey.current===requestKey)setDiagnostic(response);}
      else {
        const response = await request(kind === "chat" ? "/research/chat" : "/research", kind === "chat" ? { research: body, saveHistory } : body);
        if(currentKey.current===requestKey)setChat(researchResultSchema.parse(response));
      }
    } catch (e) { if(currentKey.current===requestKey)setMessage(e instanceof Error ? e.message : "研究結果を取得できませんでした。"); } finally { if(currentKey.current===requestKey)setBusy(false); }
  }
  return <section className="kabumaru-research" onClick={e=>{if((e.target as HTMLElement).closest('a[href^="#evidence-"]'))setEvidenceOpen(true);}}>
    <header className="research-heading"><KabumaruPortrait pose="analyze" /><div><h1>かぶまるAI研究員</h1><p>数値は保存済みの根拠から確認するよ。将来の上昇や投資判断を約束するものではないよ。</p></div></header>
    <div className="card research-controls"><StockPicker stocks={(master.data ?? []).map(s => ({ ...s, displayCode: s.displayCode ?? displayStockCode(s.providerCode) }))} value={params.get("code") ?? ""} onChange={code => update("code",code)} loading={master.isLoading} />
      <label>研究の基準日<input type="date" value={params.get("asOf") ?? ""} onChange={e => update("asOf",e.target.value)} /></label>
      <label>分析ジョブ<select value={params.get("jobId") ?? ""} onChange={e => update("jobId",e.target.value)}><option value="">基準日の保存済み結果を選択</option>{status.data?.jobs.map(j => <option key={j.id} value={j.id}>{j.input.asOf} · {j.status} · {j.id.slice(0,8)}</option>)}</select></label>
    </div>
    {!parsed.success && <p role="alert">銘柄を選び、正しい基準日・ジョブを指定してください。</p>}
    {research.isLoading && <p role="status">保存済みの根拠を確認中…</p>}{research.error && <p role="alert">{research.error.message}</p>}
    {message && <p role="status">{message}</p>}
    {result && <><section className="card"><h2>信頼性とデータ取得状況</h2><p>{result.mode === "demo" ? "DEMO・架空データ" : "保存済み実市場データの研究"} ／ {result.asOf} ／ 取得締切 {result.cutoff}</p>
      <strong>{result.reliability}</strong><p>信頼性の区分は上昇確率ではありません。</p>
      {result.dataCoverage ? <p>対象{result.dataCoverage.universeCount}・取得済み{result.dataCoverage.acquiredCount}・80営業日{result.dataCoverage.continuous80Count}・判定可能{result.dataCoverage.analyzedCount}・取得失敗{result.dataCoverage.failedCount}。契約遅延{result.dataCoverage.delayDays}日。</p> : <p>カバレッジ情報は確認できません。</p>}
      {result.warnings.map(w => <p key={w}>{w}</p>)}</section>
      <div className="research-cards">{Object.entries(sectionNames).map(([section,title]) => {
        const statements=result.explanation.statements.filter(s=>s.section===section);
        const paragraphs=(items:typeof statements)=>items.map(s=><p key={s.statementId}>{s.text} {s.evidenceIds.map((id,i)=><a key={id} href={`#evidence-${id}`}>根拠{i+1} </a>)}</p>);
        return <section key={section} className="card"><h2>{title}</h2>{paragraphs(statements.slice(0,3))}{statements.length>3&&<details><summary>続きを表示（{statements.length-3}項目）</summary>{paragraphs(statements.slice(3))}</details>}</section>;
      })}</div>
      <section className="card"><h2>質問チャット</h2><p>定義済みの質問を、同じ取得時点の証拠で調べます。自由文や個人情報を送信する入力欄はありません。</p>
        <label><input type="checkbox" checked={saveHistory} onChange={e => setSaveHistory(e.target.checked)} />質問と回答をこの端末のJSONに保存</label>
        <div className="research-questions">{questions.map(([value,label]) => <button key={value} disabled={busy} onClick={() => void act("chat",value)}>{label}</button>)}</div>
        {busy && <p role="status">根拠を照合中…</p>}
        {activeChat && <div aria-live="polite"><h3>{questions.find(([q]) => q === activeChat.question)?.[1] ?? "研究回答"}</h3><p>説明方式：{activeChat.provider} ／ {activeChat.reliability}</p>{activeChat.warnings.map(w => <p key={w}>{w}</p>)}{activeChat.explanation.statements.filter(s => (answerSections[activeChat.question] ?? Object.keys(sectionNames)).includes(s.section)).map(s => <p key={s.statementId}>{s.text} {s.evidenceIds.map((id,i) => <a key={id} href={`#evidence-${id}`}>根拠{i+1} </a>)}</p>)}</div>}
      </section>
      <details className="card"><summary>保存・関連記憶・任意の外部説明</summary><p>ローカル研究は外部通信なしで利用できます。市場データ送信は既存の許可設定にも従います。</p>
        <button disabled={busy} onClick={() => void act("save")}>研究要約をローカル保存</button><button disabled={busy} onClick={() => void act("memory")}>許可設定に従ってMemWal関連記憶を検索</button>
        <label><input type="checkbox" checked={allowLlm} onChange={e => setAllowLlm(e.target.checked)} />今回の研究Evidenceを設定済みLLMへ送信することを明示許可</label>
        <button disabled={busy || !allowLlm} onClick={() => void act("llm")}>設定済みLLMで根拠文を構成</button>
      </details>
      <details className="card"><summary>保存済み実市場データの診断</summary><p>この1銘柄の取得状況・調整系列・revision・類似件数を確認します。J-Quantsへの追加取得は行いません。</p><button disabled={busy} onClick={() => void act("diagnostic")}>ローカル診断を実行</button>{diagnostic !== null && <pre>{JSON.stringify(diagnostic,null,2)}</pre>}</details>
      <button aria-expanded={reportOpen} onClick={()=>setReportOpen(!reportOpen)}>実績検証レポートを{reportOpen?"閉じる":"表示"}</button>
      {reportOpen&&<Suspense fallback={<p role="status">検証画面を読み込み中…</p>}><ResearchOutcomes request={request} jobId={result.jobId} /></Suspense>}
      <button aria-expanded={evidenceOpen} onClick={()=>setEvidenceOpen(!evidenceOpen)}>根拠一覧を{evidenceOpen?"閉じる":"表示"}</button>
      {evidenceOpen&&<Suspense fallback={<p role="status">根拠カードを読み込み中…</p>}><KabumaruEvidence evidence={result.evidence} /></Suspense>}
    </>}
    <Link to={`/bottom/hunter?${new URLSearchParams(Object.fromEntries([...params].filter(([k]) => ["asOf","jobId"].includes(k))))}`}>底打ちハンターへ戻る</Link>
  </section>;
}
