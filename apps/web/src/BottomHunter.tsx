import { DejavuResearch } from "./DejavuResearch";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { hunterForecastResponseSchema, hunterSummarySchema, hunterCategory, hunterDetailSchema, hunterFilterSchema, hunterJobSchema, hunterRankingsSchema, hunterStatusSchema, type HunterRow } from "../../../packages/core/hunter-schema";
import { KabumaruPortrait } from "./Kabumaru";
import { displayStockCode } from "./stock-search";
import { HunterPriceChart } from "./HunterPriceChart";

type Request = (url: string, body?: unknown) => Promise<unknown>;
const number = (n: number | null | undefined, percent = false) => n == null ? "—" : `${(n * (percent ? 100 : 1)).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}${percent ? "%" : ""}`;
const filterKeys = ["jobId", "asOf", "market", "minScore", "rsiMin", "rsiMax", "maxDrawdown", "liquidity", "category", "risk", "page", "pageSize"];
export function BottomHunter({ request }: { request: Request }) {
  const [params, setParams] = useSearchParams(), client = useQueryClient();
  const [recordingMode, setRecordingMode] = useState("research");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("scan"), [from, setFrom] = useState(""), [revision, setRevision] = useState(""), [external, setExternal] = useState(false);
  const parsed = hunterFilterSchema.safeParse(Object.fromEntries([...params].filter(([key, value]) => filterKeys.includes(key) && value !== "")));
  const query = new URLSearchParams(parsed.success ? Object.fromEntries(Object.entries(parsed.data).filter(([,v]) => v !== undefined).map(([k,v]) => [k,String(v)])) : {});
  const code = params.get("code") ?? "";
  function update(key: string, value: string) {
    setParams(current => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); if (key !== "page" && key !== "code") next.delete("page"); if (key === "asOf") { next.delete("jobId"); next.delete("code"); } return next; });
  }
  const status = useQuery({ queryKey: ["hunter-status"], queryFn: async () => hunterStatusSchema.parse(await request("/bottom/hunter/status")),
    refetchInterval: q => q.state.data?.jobs.some(j => j.status === "queued" || j.status === "running") ? 2000 : false });
  const ranks = useQuery({ queryKey: ["hunter-rankings", query.toString()], enabled: parsed.success,
    queryFn: async () => hunterRankingsSchema.parse(await request(`/bottom/hunter/rankings?${query}`)) });
  const selectedJob = params.get("jobId") || ranks.data?.coverage?.jobId;
  const detail = useQuery({ queryKey: ["hunter-detail", selectedJob, code], enabled: !!selectedJob && /^[A-Z0-9]{5}$/.test(code),
    queryFn: async () => hunterDetailSchema.parse(await request(`/bottom/hunter/candidates/${code}?jobId=${selectedJob}`)) });
  const summaries = useQuery({ queryKey: ["hunter-evaluations"], queryFn: async () => hunterSummarySchema.parse(await request("/bottom/hunter/evaluations")) });
  const completion = status.data?.jobs.map(j => `${j.id}:${j.status}:${j.processed}`).join(",");
  useEffect(() => { void client.invalidateQueries({ queryKey: ["hunter-rankings"] }); }, [completion, client]);
  const coverage = ranks.data?.coverage;
  const asOf = params.get("asOf") || coverage?.asOf || "";
  async function act(path: string, body: unknown) {
    setBusy(true); setMessage("");
    try {
      const result = await request(path, body);
      if (path === "/bottom/hunter/jobs") {
        const job = hunterJobSchema.parse(result); update("jobId", job.id); setMessage("ジョブを開始しました。進捗はJSONに保存されます。");
      } else if (path === "/bottom/hunter/forecasts") {
        const saved = hunterForecastResponseSchema.parse(result);
        setMessage(`${saved.records.length}件の研究仮説を記録しました。${saved.note}`);
      } else setMessage("操作を受け付けました。");
      await Promise.all([client.invalidateQueries({ queryKey: ["hunter-status"] }), client.invalidateQueries({ queryKey: ["/watchlist"] }), client.invalidateQueries({ queryKey: ["hunter-evaluations"] })]);
    } catch (e) { setMessage(e instanceof Error ? e.message : "通信に失敗しました"); } finally { setBusy(false); }
  }
  function actions(row: HunterRow) {
    const q = new URLSearchParams({ code: row.code, asOf: row.asOf });
    return <div className="hunter-actions">
      <button onClick={() => update("code", row.code)}>底打ち詳細を見る</button>
      <Link to={`/bottom?${q}`}>個別解析</Link>
      <Link to={`/similar?${q}&hunterJobId=${row.jobId}`}>デジャヴ相場を見る</Link>
      <button disabled={busy || !row.candidate} onClick={() => void act("/bottom/hunter/forecasts", { jobId: row.jobId, code: row.code, recordingMode })}>予測仮説を記録する</button>
      <button disabled={busy} onClick={() => void act("/watchlist", { code: row.code, hunterJobId: row.jobId })}>ウォッチリストに追加</button>
    </div>;
  }
  return <section className="hunter-page">
    <div className="hunter-heading"><KabumaruPortrait pose={coverage?.candidateCount ? "discover" : "analyze"} /><div><h1>底打ちハンター</h1><p>取得済みの東証データから条件を探索します。スコアは的中確率ではありません。</p><p>{status.data?.mode === "demo" ? "DEMO · 架空データ" : "RESEARCH · 研究用"} ／ {status.data?.plan} ／ 遅延 {status.data?.delayDays ?? "—"}日</p></div></div>
    {status.error && <p role="alert">{status.error.message}</p>}
    {!parsed.success && <p role="alert">URLのフィルターが不正です。値を修正してください。</p>}
    {ranks.error && <p role="alert">{ranks.error.message}</p>}
    {message && <p role="status">{message}</p>}
    <div className="hunter-coverage card" aria-label="カバレッジ">
      <h2>データ品質</h2><p>基準日 {coverage?.asOf ?? "未走査"} ／ 最終データ更新 {coverage?.lastObservedAt ?? "未取得"}</p>
      <p>対象 {coverage?.universeCount ?? 0}銘柄 ／ 分析完了率 {coverage?.universeCount ? number(coverage.analyzedCount / coverage.universeCount, true) : "—"} ／ 候補発見 {coverage?.candidateCount ?? 0}件</p>
      {coverage && <><p>取得済み {coverage.acquiredCount} ／ 80営業日 {coverage.continuous80Count} ／ 判定可能 {coverage.analyzedCount} ／ 判定不能 {coverage.unavailableCount} ／ 取得失敗 {coverage.failedCount} ／ ユニバース除外 {coverage.excludedCount}</p><p>取得対象期間 {coverage.periodFrom ?? "旧記録：開始日未記録"} 〜 {coverage.periodTo ?? coverage.asOf} ／ {coverage.plan ?? status.data?.plan} ／ 契約遅延 {coverage.delayDays}日</p><p>取得締切 {coverage.cutoff}</p><strong>{coverage.complete ? "対象ユニバースの判定完了" : "未取得・未判定を含みます。全市場の完全走査ではありません。"}</strong><p role="note">かぶまる：{coverage.complete ? "今回の対象銘柄の判定は完了したよ。スコアは将来の成功確率ではないよ。" : `まだ全銘柄の判定が揃っていないよ。今回のランキングは保存済み結果だけが対象だよ！ 未処理 ${Math.max(0, coverage.universeCount-coverage.processedCount)}銘柄。欠損・除外理由も確認してね。`}</p><details><summary>除外・判定不能の理由</summary>{Object.entries(coverage.exclusionReasons).map(([reason,count]) => <p key={reason}>{reason}: {count}件</p>)}</details></>}
    </div>
    <details className="card"><summary>取得・走査ジョブを明示的に開始</summary>
      <p>走査は保存済みJSONのみを使います。初回取得・差分更新・訂正取得はJ-Quantsへ接続します。起動時の自動取得はありません。</p>
      <label>ジョブ種別<select value={kind} onChange={e => setKind(e.target.value)}><option value="scan">保存済みデータを走査</option><option value="initial">初回取得</option><option value="update">差分更新</option><option value="correction">直近5営業日の訂正取得</option></select></label>
      <label>取得開始日<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>訂正revision<input value={revision} onChange={e => setRevision(e.target.value)} placeholder="correction-20261017" /></label>
      <label><input type="checkbox" checked={external} onChange={e => setExternal(e.target.checked)} />J-Quantsへの実接続を許可して開始する</label>
      <button disabled={busy || !asOf || !parsed.success || (kind !== "scan" && status.data?.mode !== "demo" && !external)} onClick={() => void act("/bottom/hunter/jobs", { kind, asOf, ...(from ? { from } : {}), ...(revision ? { revision } : {}), confirmExternal: external })}>ジョブを開始</button>
    </details>
    <div className="hunter-filters card">
      <label>基準日<input type="date" value={params.get("asOf") ?? ""} onChange={e => update("asOf", e.target.value)} /></label>
      <label>市場区分<select value={params.get("market") ?? ""} onChange={e => update("market", e.target.value)}><option value="">すべて</option>{[["0111","プライム"],["0112","スタンダード"],["0113","グロース"],["0105","TOKYO PRO MARKET"]].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>スコア下限<input type="number" min="0" max="100" value={params.get("minScore") ?? ""} onChange={e => update("minScore", e.target.value)} /></label>
      <label>RSI下限<input type="number" min="0" max="100" value={params.get("rsiMin") ?? ""} onChange={e => update("rsiMin", e.target.value)} /></label>
      <label>RSI上限<input type="number" min="0" max="100" value={params.get("rsiMax") ?? ""} onChange={e => update("rsiMax", e.target.value)} /></label>
      <label>60日下落率以下（小数）<input type="number" min="-1" max="0" step="0.01" value={params.get("maxDrawdown") ?? ""} onChange={e => update("maxDrawdown", e.target.value)} /></label>
      <label>流動性<select value={params.get("liquidity") ?? ""} onChange={e => update("liquidity", e.target.value)}><option value="">すべて</option><option value="sufficient">1億円以上</option><option value="low">1億円未満</option><option value="unknown">未確認</option></select></label>
      <label>候補分類<select value={params.get("category") ?? ""} onChange={e => update("category", e.target.value)}><option value="">すべて</option>{hunterCategory.options.map(c => <option key={c}>{c}</option>)}</select></label>
      <label>リスク<select value={params.get("risk") ?? ""} onChange={e => update("risk", e.target.value)}><option value="">すべて</option><option value="yes">あり</option><option value="no">なし</option></select></label>
    </div>
    <label>予測記録の区分<select value={recordingMode} onChange={e => setRecordingMode(e.target.value)}><option value="research">過去研究（後から作成した仮説）</option><option value="live">実運用（当日作成のみ）</option></select></label>
    <h2>ランキング（{ranks.data?.total ?? 0}件）</h2>
    {!ranks.data?.rows.length && <p>この条件の走査済み結果はありません。基準日を指定してジョブを開始してください。</p>}
    <div className="hunter-desktop"><table><thead><tr><th>順位・銘柄・市場</th><th>点数・分類</th><th>RSI・下落率・出来高倍率</th><th>平均売買代金</th><th>根拠・リスク・取得状態</th><th>操作</th></tr></thead><tbody>{ranks.data?.rows.map(r => <tr key={r.code}><td>{r.rank} · {displayStockCode(r.code)} {r.name}<br />{r.marketName} · {r.asOf}</td><td>{r.score ?? "—"}点<br />{r.category}{r.candidate ? " · 候補" : ""}</td><td>{number(r.rsi)} ／ {number(r.drawdown,true)} ／ {number(r.volumeRatio)}</td><td>{number(r.averageTurnover20)}円</td><td>{r.reasons.slice(0,3).join("、")}<br />{r.risks.join("、") || "追加リスクなし"}<br />{r.acquisitionStatus} · {r.continuousSessions}営業日</td><td>{actions(r)}</td></tr>)}</tbody></table></div>
    <div className="hunter-mobile">{ranks.data?.rows.map(r => <article className="card" key={r.code}><h3>{r.rank} · {displayStockCode(r.code)} {r.name}</h3><p>{r.marketName} · {r.asOf} ／ {r.score ?? "—"}点 · {r.category}</p><p>RSI {number(r.rsi)} ／ 下落 {number(r.drawdown,true)} ／ 出来高 {number(r.volumeRatio)}倍 ／ 売買代金 {number(r.averageTurnover20)}円</p><p>{r.reasons.slice(0,3).join("、")}</p><p>{r.risks.join("、")} · {r.acquisitionStatus} · {r.continuousSessions}営業日</p>{actions(r)}</article>)}</div>
    <div className="toolbar"><button disabled={!parsed.success || (parsed.data.page ?? 1) <= 1} onClick={() => update("page", String((parsed.success ? parsed.data.page : 1)-1))}>前のページ</button><span>{parsed.success ? parsed.data.page : "—"}ページ</span><button disabled={!ranks.data || ranks.data.page*ranks.data.pageSize >= ranks.data.total} onClick={() => update("page", String((parsed.success ? parsed.data.page : 1)+1))}>次のページ</button></div>
    {detail.error && <p role="alert">{detail.error.message}</p>}
    {detail.data && <article className="card hunter-detail"><h2>{detail.data.row.name} 底打ち詳細</h2><p>{detail.data.explanation}</p><p>{detail.data.analysis.score ?? "—"}点 ／ {detail.data.row.category}</p><HunterPriceChart chart={detail.data.analysis.chart} /><ul>{detail.data.analysis.conditions.map(c => <li key={c.code}>{c.met ? "一致" : "未一致"} · {c.label} · {c.earnedPoints}/{c.maxPoints}点</li>)}</ul><p>リスク：{detail.data.analysis.riskCodes.join("、")}</p><p>{detail.data.dejavuWarning}</p>{detail.data.dejavu && <DejavuResearch data={detail.data.dejavu} code={detail.data.row.code} date={detail.data.row.asOf} compare="" hunterJobId={detail.data.row.jobId} request={request} memories={<p>ハンターの予測原本・反省は研究ジャーナルに保存します。</p>} />}</article>}
    <section className="card"><h2>研究仮説の結果検証</h2><p>実運用・過去研究・walk-forwardは別集計です。方向一致率は将来の的中確率ではありません。</p><button disabled={busy} onClick={() => void act("/bottom/hunter/evaluations", {})}>期限後の結果を検証</button>{summaries.error && <p role="alert">{summaries.error.message}</p>}{summaries.data?.groups.map(g => <article key={g.key}><p>{g.key}</p><p>未評価 {g.pending} ／ 評価可能 {g.available} ／ 評価済み {g.evaluated} ／ 方向一致 {number(g.directionRate,true)} ／ 実現騰落率 {number(g.meanReturn,true)} ／ 中央値との差 {number(g.meanError,true)} ／ 最悪最大下落 {number(g.worstDrawdown,true)}</p></article>)}</section>
    <details className="card"><summary>ジョブの進捗・中断・再開</summary>{status.data?.jobs.map(job => <article key={job.id}><p>{job.input.kind} · {job.input.asOf} · {job.status} · {job.processed}/{job.total}</p><p>{job.error}</p>{job.status !== "completed" && <><button disabled={busy || job.status === "running"} onClick={() => void act("/bottom/hunter/jobs", { resumeJobId: job.id })}>再開</button><button disabled={busy} onClick={() => void act(`/bottom/hunter/jobs/${job.id}/cancel`, {})}>キャンセル</button></>}</article>)}</details>
  </section>;
}
