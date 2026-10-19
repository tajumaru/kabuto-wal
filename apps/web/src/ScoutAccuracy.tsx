import { useEffect,useState } from "react";
import { Link,useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { scoutAccuracySchema,type AccuracyPrediction } from "../../../packages/core/scout-accuracy";
import { PageTitle } from "./PageTitle";
import { KabumaruPortrait } from "./Kabumaru";
import "./ScoutAccuracy.css";
const pct=(v:number|null|undefined)=>v==null?"—":`${v>0?"+":""}${(v*100).toFixed(2)}%`;
const ratio=(v:number|null|undefined)=>v==null?"未評価":`${(v*100).toFixed(1)}%`;
const indicatorNames:Record<string,string>={rsi14:"RSI（14日）",macd:"MACD",signal:"MACDシグナル",sma5:"5日移動平均",sma25:"25日移動平均",sma75:"75日移動平均",bollingerLower:"ボリンジャー下限",bollingerUpper:"ボリンジャー上限",volumeRatio:"出来高倍率",drawdown75:"75日高値からの下落率"};
const outcome=(r:AccuracyPrediction["results"][number]|undefined)=>!r||r.status==="unavailable"?"評価不能":r.status==="pending"?"評価待ち":r.actualReturn!>0?"的中（上昇）":r.actualReturn===0?"不的中（横ばい）":"不的中（下落）";
function PredictionCard({p,horizon}:{p:AccuracyPrediction;horizon:number}){
  const [open,setOpen]=useState(false),e=p.evidence,r=p.results.find(r=>r.horizon===horizon),reflection=p.reflection?.outcomes.find(r=>r.horizon===horizon);
  return <article className="card accuracy-prediction" id={`forecast-${p.forecastId}-${e.code}`}>
    <div className="accuracy-prediction-title"><div><span>順位 {p.rank} ／ スコア {e.score}点</span><h3>{e.name} <small>{e.code}</small></h3></div><strong>{outcome(r)}</strong></div>
    <p>基準日 {e.asOf} ／ {horizon}営業日後 {r?.target??"期限不明"} ／ 騰落率 {pct(r?.actualReturn)}</p>
    {!p.included&&<p role="note">{p.exclusionReason}。この記録は集計対象外です。</p>}
    {r?.status!=="evaluated"&&<p>{r?.reason??"評価原本がありません"}</p>}
    <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>予測の根拠・結果・かぶまるの振り返り</summary>{open&&<>
      <p>{p.reflection?.selection}</p><p>{reflection?.text}</p>
      <dl className="accuracy-facts"><dt>当初の基準日調整終値</dt><dd>{p.referencePrice?.toLocaleString("ja-JP")??"確認不能"}円</dd><dt>最大上昇（終値）</dt><dd>{pct(r?.maxRise)}</dd><dt>最大ドローダウン（終値）</dt><dd>{pct(r?.maxDrawdown)}</dd><dt>再下落</dt><dd>{r?.relapse==null?"未評価":r.relapse?"あり":"なし"}</dd><dt>評価系列の基準終値</dt><dd>{r?.basePrice?.toLocaleString("ja-JP")??"未評価"}</dd></dl>
      <p>分割等の調整・後日改訂で当初の価格と評価系列の価格が異なる場合があります。予測原本は変更しません。</p>
      <p>期限後の調整終値：{r?.targetPrice?.toLocaleString("ja-JP")??"未評価"}。比較対象の騰落率：{r?.status==="evaluated"&&r.benchmarkReturn!==null?pct(r.benchmarkReturn):"比較不能"}。</p>
      <h4>保存した指標と注意点</h4><dl className="accuracy-facts">{Object.entries(e.indicators).map(([key,value])=><div key={key}><dt>{indicatorNames[key]??key}</dt><dd>{value===null?"欠損":key==="drawdown75"?pct(value):value.toFixed(3)}</dd></div>)}</dl>
      {e.contributions.map(c=><p key={c.code}>{c.label}：{c.met?"成立":"未成立"}（{c.earnedPoints}/{c.maxPoints}点）</p>)}
      {e.similar?<p>デジャヴ類似度 {e.similar.bestSimilarity?.toFixed(1)??"未確認"} ／ 過去事例 {e.similar.sampleCount}件。{e.similar.lowSample&&"少数事例のため信頼性は低いです。"}</p>:<p>デジャヴの根拠は未保存です。</p>}
      <h4>似た条件で成功した保存済み予測</h4>{reflection?.similarSuccesses.length?reflection.similarSuccesses.map(s=><p key={`${s.forecastId}/${s.code}`}>{s.code}：{s.matchedConditions.join("、")} ／ 予測ID {s.forecastId}</p>):<p>このページでは、比較できる確定成功例がまだありません。</p>}
      {p.reflection?.cautions.map((text,i)=><p key={i}>{text}</p>)}
      <div className="accuracy-links"><Link to={`/similar?${new URLSearchParams({code:e.code,asOf:e.asOf,...(e.hunterJobId?{hunterJobId:e.hunterJobId}:{})})}`}>デジャヴの根拠を見る</Link><Link to={`/bottom?code=${e.code}&asOf=${e.asOf}`}>底打ちの根拠を見る</Link></div>
      <details><summary>原本ID・データ取得時点</summary><p>予測日時 {p.predictedAt} ／ 取得時点 {e.observedAt??"未記録"}</p><p>方式 {p.algorithmVersion}</p><p>予測ID {p.forecastId}</p><p>分析ID {p.reportId}</p><p>入力hash {p.inputHash}</p><p>予測revision {e.inputRevisionIds.join("、")}</p><p>評価revision {r?.revisionIds.join("、")}</p><p>比較対象revision {r?.benchmarkRevisionIds.join("、")}</p><p>評価原本 {r?.evaluationId}</p></details>
    </>}</details>
  </article>;
}
export function ScoutAccuracy({request}:{request:(url:string,body?:unknown)=>Promise<unknown>}){
  const [params,setParams]=useSearchParams(),rawPage=Number(params.get("page")??1),page=Number.isSafeInteger(rawPage)&&rawPage>=1?rawPage:1,recordingMode=params.get("recordingMode")==="research"?"research":"live",horizon=[5,10,20].includes(Number(params.get("horizon")))?Number(params.get("horizon")):20,status=params.get("status")??"all",reportId=params.get("reportId");
  const query=useQuery({queryKey:["scout-accuracy",page,recordingMode,reportId],staleTime:60000,refetchOnWindowFocus:false,retry:false,queryFn:async()=>{
    if(reportId&&!/^[a-f0-9]{64}$/.test(reportId))throw Error("予測の参照IDが不正です。「全体の一覧へ戻る」を選んでください。");
    return scoutAccuracySchema.parse(await request(`/research/scout/accuracy?${new URLSearchParams({page:String(page),pageSize:"5",recordingMode,...(reportId?{reportId}:{})})}`));
  }});
  const scrollKey=`scout-accuracy-scroll:${params}`;
  useEffect(()=>{if(!query.data)return;try{window.scrollTo(0,Number(sessionStorage.getItem(scrollKey)??0));}catch{/* Optional view preference. */}const save=()=>{try{sessionStorage.setItem(scrollKey,String(scrollY));}catch{/* Optional. */}};window.addEventListener("scroll",save,{passive:true});return()=>window.removeEventListener("scroll",save);},[scrollKey,query.data]);
  const update=(key:string,value:string)=>setParams(current=>{const next=new URLSearchParams(current);next.set(key,value);if(key==="recordingMode"){next.delete("reportId");next.set("page","1");}return next;});
  const data=query.error?undefined:query.data,g=data?.groups.find(g=>g.horizon===horizon),shown=data?.predictions.filter(p=>{const r=p.results.find(r=>r.horizon===horizon);return status==="all"||status==="hit"&&r?.status==="evaluated"&&r.actualReturn!>0||status==="miss"&&r?.status==="evaluated"&&r.actualReturn!<=0||status===r?.status;})??[];
  return <section className="scout-accuracy-page">
    <PageTitle eyebrow="FORECAST REVIEW" title="予測の答え合わせ" description="成功も失敗も、保存した根拠から確認するよ。スコアは確率ではありません。" portrait={<KabumaruPortrait pose="analyze"/>}/>
    <nav className="accuracy-links" aria-label="答え合わせの関連画面"><Link to="/research">かぶまる研究へ</Link><Link to="/chat">チャットで候補を探す</Link>{reportId&&<Link to={`/research/accuracy?recordingMode=${recordingMode}`}>全体の一覧へ戻る</Link>}</nav>
    <div className="card accuracy-controls"><label>記録区分<select value={recordingMode} onChange={e=>update("recordingMode",e.target.value)}><option value="live">当日基準の予測記録</option><option value="research">過去・遅延データの研究記録</option></select></label><label>評価期間<select value={horizon} onChange={e=>update("horizon",e.target.value)}>{[5,10,20].map(h=><option key={h} value={h}>{h}営業日後</option>)}</select></label><button disabled={query.isFetching} onClick={()=>void query.refetch()}>保存済みデータで再評価</button></div>
    {query.isPending&&<p role="status">保存した予測と実績を確認中…</p>}{query.error&&<p role="alert">答え合わせを読み込めませんでした：{query.error.message}</p>}
    {data&&<>
      <p className="accuracy-scope">{data.mode==="demo"?"DEMO・架空データと人工カレンダー":"保存済みJ-Quants実データ"} ／ このページ：{data.selectedReports}/{data.totalReports}分析原本 ／ 全履歴の集計対象予測 {data.cumulative.included}件 ／ 重複除外 {data.cumulative.duplicates}件</p>
      <section className="card"><h2>かぶまる：これまでの答え合わせ</h2><p>{data.explanation}</p><p>95%信頼区間は独立標本を仮定した参考区間です。銘柄間・連続日の相関を補正していないため、実際の不確実性を小さく見せる可能性があります。将来の上昇確率ではありません。</p></section><p>的中＝期限後の調整終値が基準日を上回ったこと。横ばいは不的中。評価待ち・評価不能は分母に含めません。</p>
      {!data.predictions.length&&<div className="card" role="status"><h2>集計できる予測はまだありません</h2><p>この機能の追加後に生成したスカウト上位10候補を保存します。候補なし・未生成・古い原本への証拠の後付けは行いません。過去・遅延データの分析は記録区分を切り替えて確認してください。</p><Link to="/chat">かぶまるに底打ち候補を聞く</Link></div>}
      <div className="accuracy-grid">{data.groups.map(m=><article className="card accuracy-kpi" key={m.horizon}><h2>{m.horizon}営業日後</h2><strong>{ratio(m.hitRate)}</strong><p>95%信頼区間 {m.confidence95?`${ratio(m.confidence95.lower)}〜${ratio(m.confidence95.upper)}`:"未評価"}</p><p>的中{m.hits} / 評価済み{m.evaluated}件</p><p>平均 {pct(m.meanReturn)} ／ 中央値 {pct(m.medianReturn)}</p><p>評価待ち{m.pending}件 ／ 評価不能{m.unavailable}件</p>{m.lowSample&&<p className="accuracy-caution">少数サンプルです。精度を断定できません。</p>}</article>)}</div>
      {g&&<section className="card"><h2>{horizon}営業日後の順位別成績</h2><div className="accuracy-grid">{data.top.filter(m=>m.horizon===horizon).map(m=><div key={m.top}><h3>TOP{m.top}</h3><strong>{ratio(m.hitRate)}</strong><p>95%信頼区間 {m.confidence95?`${ratio(m.confidence95.lower)}〜${ratio(m.confidence95.upper)}`:"未評価"}</p><p>的中{m.hits} / 評価済み{m.evaluated}件</p><p>平均{pct(m.meanReturn)} ／ 不能{m.unavailable}件</p></div>)}</div><p>候補不足の場合は表示順位に達していなくても実件数だけを集計します。</p></section>}
      <section className="card"><h2>{horizon}営業日後のスコア帯別成績</h2><div className="accuracy-table"><table><thead><tr><th>点数</th><th>評価済み</th><th>的中率</th><th>平均騰落率</th></tr></thead><tbody>{data.bands.filter(m=>m.horizon===horizon).map(m=><tr key={m.band}><th>{m.band}</th><td>{m.evaluated}件</td><td>{ratio(m.hitRate)}</td><td>{pct(m.meanReturn)}</td></tr>)}</tbody></table></div><p>80点以上が優秀だと決めつけず、件数と実績で確認します。</p></section>
      {g&&<section className="card"><h2>比較対象との差</h2><p>{g.comparisonNote}</p>{g.benchmarkPairs>0?<><p>比較対象コード {g.benchmarkCode} ／ 同じ評価可能ペア {g.benchmarkPairs}件</p><p>予測銘柄平均 {pct(g.pairedPredictionMean)} ／ 比較対象平均 {pct(g.benchmarkMean)}</p><p>平均超過リターン {pct(g.meanExcessReturn)} ／ 上回った割合 {ratio(g.outperformanceRate)}</p></>:<p>比較不能。保存済みの比較データが確認できません。</p>}</section>}
      <section className="card"><h2>かぶまる：不的中の予測に共通する条件</h2><p>条件別の頻度であり、失敗の原因や次回の成功を証明するものではありません。</p>{data.conditions.filter(c=>c.horizon===horizon&&c.failures>0).sort((a,b)=>b.failures-a.failures).map(c=><p key={c.code}>{c.label}を満たした評価{c.evaluated}件のうち、不的中{c.failures}件。</p>)}{!data.conditions.some(c=>c.horizon===horizon&&c.failures>0)&&<p>確認できる不的中条件はまだありません。評価待ちや標本不足を成功とは扱いません。</p>}</section>
      <section className="card"><h2>予測時点の相場環境別</h2><p>保存済み市場指標を当時の取得締切で再構成できる場合のみ分類します。分類不能を推測で埋めません。</p>{data.regimes.filter(m=>m.horizon===horizon).map(m=><p key={m.regime}>{{up:"上昇",down:"下落",flat:"横ばい",unknown:"分類不能"}[m.regime]}：評価済み{m.evaluated}件 ／ 的中{ratio(m.hitRate)} ／ 平均{pct(m.meanReturn)} ／ 待ち{m.pending}件・不能{m.unavailable}件</p>)}</section><label>結果の表示<select value={status} onChange={e=>update("status",e.target.value)}><option value="all">すべて</option><option value="hit">的中</option><option value="miss">不的中</option><option value="pending">評価待ち</option><option value="unavailable">評価不能</option></select></label><p>表示を絞っても、上の集計は選択した記録区分の全履歴です。分析IDや明細ページの切替でも累積成績は変わりません。</p>
      <section aria-label="個別予測の根拠と結果">{shown.map(p=><PredictionCard key={`${p.forecastId}/${p.evidence.code}`} p={p} horizon={horizon}/>)}{!!data.predictions.length&&!shown.length&&<p role="status">この条件の予測はありません。</p>}</section>
      <nav className="accuracy-pagination" aria-label="予測のページ"><button disabled={page<=1||query.isFetching} onClick={()=>update("page",String(page-1))}>前のページ</button><span>{page}ページ</span><button disabled={page*data.pageSize>=data.totalReports||query.isFetching} onClick={()=>update("page",String(page+1))}>次のページ</button></nav>
      <details className="card"><summary>集計範囲・定義・注意点</summary>{data.notes.map(n=><p key={n}>{n}</p>)}<p>記憶保存は元のチャットから利用者が明示操作した場合のみ。閲覧や再評価ではMemWal送信を行いません。</p><p>評価取得時刻 {data.evaluatedAt} ／ {data.methodVersion}</p></details>
    </>}
  </section>;
}
