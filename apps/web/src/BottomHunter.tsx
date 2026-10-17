import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { hunterPeriodSchema, hunterJobInputSchema, hunterPreflightSchema, hunterForecastResponseSchema, hunterSummarySchema, hunterCategory, hunterDetailSchema, hunterFilterSchema, hunterJobSchema, hunterRankingsSchema, hunterStatusSchema, type HunterRow } from "../../../packages/core/hunter-schema";
import { KabumaruPortrait } from "./Kabumaru";
import { displayStockCode } from "./stock-search";
import { hunterLabel, acquisitionLabel } from "./hunter-labels";
const HunterPriceChart = lazy(() => import("./HunterPriceChart").then(m => ({ default: m.HunterPriceChart })));
const DejavuResearch = lazy(() => import("./DejavuResearch").then(m => ({ default: m.DejavuResearch })));

type Request = (url: string, body?: unknown) => Promise<unknown>;
const number = (n: number | null | undefined, percent = false) => n == null ? "—" : `${(n * (percent ? 100 : 1)).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}${percent ? "%" : ""}`;
const filterKeys = ["view", "jobId", "asOf", "market", "minScore", "rsiMin", "rsiMax", "maxDrawdown", "liquidity", "category", "risk", "page", "pageSize"];
export function BottomHunter({ request }: { request: Request }) {
  const [params, setParams] = useSearchParams(), client = useQueryClient();
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [showSummary, setShowSummary] = useState(false);
  const restored = useRef("");
  const previousCompletion = useRef<string | undefined>(undefined);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [recordingMode, setRecordingMode] = useState("research");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [jobMessage, setJobMessage] = useState("");
  const [jobError, setJobError] = useState(false);
  const [kind, setKind] = useState("scan"), [from, setFrom] = useState(""), [revision, setRevision] = useState(""), [external, setExternal] = useState(false);
  const parsed = hunterFilterSchema.safeParse(Object.fromEntries([...params].filter(([key, value]) => filterKeys.includes(key) && value !== "")));
  const query = new URLSearchParams(parsed.success ? Object.fromEntries(Object.entries(parsed.data).filter(([,v]) => v !== undefined).map(([k,v]) => [k,String(v)])) : {});
  const queryString = query.toString();
  const code = params.get("code") ?? "";
  const unavailableView = params.get("view") === "unavailable";
  function update(key: string, value: string) {
    setParams(current => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); if (key !== "page" && key !== "code") next.delete("page"); if (key === "asOf") { next.delete("jobId"); next.delete("code"); } return next; });
  }
  const status = useQuery({ queryKey: ["hunter-status"], queryFn: async () => hunterStatusSchema.parse(await request("/bottom/hunter/status")),
    refetchInterval: q => q.state.data?.jobs.some(j => j.status === "queued" || j.status === "running") ? 2000 : false });
  const ranks = useQuery({ queryKey: ["hunter-rankings", queryString], enabled: parsed.success, staleTime: 30000,
    queryFn: async () => hunterRankingsSchema.parse(await request(`/bottom/hunter/rankings?${query}`)) });
  const selectedJob = params.get("jobId") || ranks.data?.coverage?.jobId;
  const activeJob = status.data?.jobs.find(job => job.id === selectedJob) ?? status.data?.jobs.find(job => job.status !== "completed" && job.status !== "cancelled");
  const runningJob = status.data?.jobs.find(job => job.status === "running" || job.status === "queued");
  const detail = useQuery({ queryKey: ["hunter-detail", selectedJob, code], staleTime: 30000, enabled: !!selectedJob && /^[A-Z0-9]{5}$/.test(code),
    queryFn: async () => hunterDetailSchema.parse(await request(`/bottom/hunter/candidates/${code}?jobId=${selectedJob}`)) });
  const summaries = useQuery({ queryKey: ["hunter-evaluations"], enabled: showSummary, staleTime: 30000, queryFn: async () => hunterSummarySchema.parse(await request("/bottom/hunter/evaluations")) });
  const completion = status.data?.jobs.map(j => `${j.id}:${j.status}:${j.processed}`).join(",");
  useEffect(() => {
    if (previousCompletion.current !== undefined && previousCompletion.current !== completion)
      void client.invalidateQueries({ queryKey: ["hunter-rankings"] });
    previousCompletion.current = completion;
  }, [completion, client]);
  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => { window.history.scrollRestoration = previous; };
  }, []);
  useLayoutEffect(() => {
    if (!ranks.data) return;
    const key = `hunter-scroll:${queryString}`;
    if (restored.current !== key) { window.scrollTo(0, Number(sessionStorage.getItem(key) || 0)); restored.current = key; }
    const save = () => sessionStorage.setItem(key, String(window.scrollY));
    window.addEventListener("scroll", save, { passive: true });
    window.addEventListener("pagehide", save);
    return () => { window.removeEventListener("scroll", save); window.removeEventListener("pagehide", save); };
  }, [queryString, ranks.data]);
  const coverage = ranks.data?.coverage;
  const asOf = params.get("asOf") || coverage?.asOf || status.data?.suggestedAsOf || "";
  const acquisitionFrom = from || status.data?.suggestedFrom || "";
  const period = useQuery({ queryKey: ["hunter-period", asOf], enabled: !!asOf && kind !== "scan", staleTime: 30000, retry: false,
    queryFn: async () => hunterPeriodSchema.parse(await request(`/bottom/hunter/period?asOf=${asOf}`)) });
  const preflightInput = hunterJobInputSchema.safeParse({ kind, asOf, ...(kind !== "scan" && acquisitionFrom ? { from: acquisitionFrom } : {}), ...(kind === "correction" && revision ? { revision } : {}) });
  const preflightBody = preflightInput.success ? preflightInput.data : null;
  const preflight = useQuery({ queryKey: ["hunter-preflight", preflightBody], enabled: !!preflightBody,
    queryFn: async () => hunterPreflightSchema.parse(await request("/bottom/hunter/preflight", preflightBody)), staleTime: 10000, retry: false });
  const preflightBlocked = !preflightBody || preflight.isPending || !!preflight.error || !!preflight.data?.errors.length;
  const jobBlocked = busy ? "開始を受け付けています。" : runningJob ? "実行中の処理が終わるまでお待ちください。" : !asOf ? "分析する基準日を入力してください。" : !parsed.success ? "絞り込み条件を修正してください。" : kind !== "scan" && !acquisitionFrom ? "取得開始日を入力してください。" : kind === "correction" && !revision ? "訂正revisionを入力してください。" : kind !== "scan" && status.data?.mode !== "demo" && !external ? "J-Quantsへの実接続にチェックを入れてください。" : "";
  async function act(path: string, body: unknown) {
    setBusy(true); setMessage("");
    const startingJob = path === "/bottom/hunter/jobs";
    if (startingJob) { setJobError(false); setJobMessage("開始を受け付けています…"); }
    try {
      const result = await request(path, body);
      if (path === "/bottom/hunter/jobs") {
        const job = hunterJobSchema.parse(result); update("jobId", job.id); setJobMessage("開始しました。この下に進捗を表示します。");
      } else if (path === "/bottom/hunter/forecasts") {
        const saved = hunterForecastResponseSchema.parse(result);
        setMessage(`${saved.records.length}件の研究仮説を記録しました。${saved.note}`);
      } else setMessage("操作を受け付けました。");
      await Promise.all([client.invalidateQueries({ queryKey: ["hunter-status"] }), client.invalidateQueries({ queryKey: ["/watchlist"] }), client.invalidateQueries({ queryKey: ["hunter-evaluations"] })]);
    } catch (e) {
      const error = e instanceof Error ? e.message : "通信に失敗しました";
      if (startingJob) { setJobError(true); setJobMessage(error); }
      else setMessage(error);
    } finally { setBusy(false); }
  }
  function actions(row: HunterRow) {
    const q = new URLSearchParams({ code: row.code, asOf: row.asOf });
    return <div className="hunter-actions">
      <button className="hunter-detail-action" aria-label="底打ち詳細を見る" onClick={() => update("code", row.code)}>詳細を見る</button>
      <details className="hunter-more"><summary>その他</summary>
      <div className="hunter-more-items" onClick={event => { if ((event.target as HTMLElement).closest("a,button:not(:disabled)")) event.currentTarget.closest("details")?.removeAttribute("open"); }}>
      <Link to={`/research?${q}&jobId=${row.jobId}`}>かぶまるに研究してもらう</Link>
      <Link to={`/bottom?${q}`}>個別解析</Link>
      <Link to={`/similar?${q}&hunterJobId=${row.jobId}`}>デジャヴ相場を見る</Link>
      <button disabled={busy || !row.candidate} onClick={() => void act("/bottom/hunter/forecasts", { jobId: row.jobId, code: row.code, recordingMode })}>予測仮説を記録する</button>
      <button disabled={busy} onClick={() => void act("/watchlist", { code: row.code, hunterJobId: row.jobId })}>ウォッチリストに追加</button>
      </div></details>
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
      {coverage && <><p>取得済み {coverage.acquiredCount} ／ 80営業日 {coverage.continuous80Count} ／ 判定可能 {coverage.analyzedCount} ／ 判定不能 {coverage.unavailableCount} ／ 取得失敗 {coverage.failedCount} ／ ユニバース除外 {coverage.excludedCount}</p><p>取得対象期間 {coverage.periodFrom ?? "旧記録：開始日未記録"} 〜 {coverage.periodTo ?? coverage.asOf} ／ {coverage.plan ?? status.data?.plan} ／ 契約遅延 {coverage.delayDays}日</p><p>取得締切 {coverage.cutoff}</p><strong>{coverage.complete ? "対象ユニバースの判定完了" : "未取得・未判定を含みます。全市場の完全走査ではありません。"}</strong><p role="note">かぶまる：{coverage.complete ? "今回の対象銘柄の判定は完了したよ。スコアは将来の成功確率ではないよ。" : `まだ全銘柄の判定が揃っていないよ。今回のランキングは保存済み結果だけが対象だよ！ 未処理 ${Math.max(0, coverage.universeCount-coverage.processedCount)}銘柄。欠損・除外理由も確認してね。`}</p><details><summary>除外・判定不能の理由</summary>{Object.entries(coverage.exclusionReasons).map(([reason,count]) => <p key={reason}>{hunterLabel(reason)}: {count}件</p>)}</details></>}
    </div>
    <section className="card hunter-workflow" aria-label="取得とランキング更新">
      <h2>ランキングを更新する</h2>
      <ol className="hunter-steps"><li><strong>取得方法を選ぶ</strong><span>初めての日付は「初回取得」</span></li><li><strong>期間を確認して開始</strong><span>判定には連続80営業日分が必要</span></li><li><strong>ランキングに自動反映</strong><span>取得後、そのまま分析します</span></li></ol>
      <details className="hunter-help"><summary>ホームの取得・保存済みデータとの違い</summary><p>ホームの「日足を取得」だけでは全市場ランキングは更新されません。「保存済みデータを走査」はハンター用の取得データを再分析します。</p></details>
      <div className="hunter-job-fields">
      <label>分析する基準日<input type="date" value={asOf} onChange={e => update("asOf", e.target.value)} /></label>
      {asOf && [0, 6].includes(new Date(`${asOf}T00:00:00Z`).getUTCDay()) && <p role="note">指定日は土日です。データを取得できる直前の営業日に変更してください。</p>}
      <label>ジョブ種別<select value={kind} onChange={e => setKind(e.target.value)}><option value="scan">保存済みデータを走査</option><option value="initial">初回取得</option><option value="update">差分更新</option><option value="correction">直近5営業日の訂正取得</option></select></label>
      {kind !== "scan" && <div className="hunter-period-field"><label>取得開始日<input type="date" max={asOf} value={acquisitionFrom} onChange={e => setFrom(e.target.value)} /></label>
        <button className="hunter-period-button" disabled={!period.data?.from || period.isFetching} onClick={() => { if (period.data?.from) { setFrom(period.data.from); setJobMessage(`基準日を含む80営業日分の開始日（${period.data.from}）を設定しました。`); setJobError(false); } }}>80営業日分に設定</button>
        <small>{period.isFetching ? "営業日を確認中…" : period.error ? "営業日を確認できません。再読み込みしてください。" : period.data?.reason ?? "基準日を含む80営業日。日付の設定のみ行います。"}</small>
      </div>}
      {kind === "correction" && <label>訂正revision<input value={revision} onChange={e => setRevision(e.target.value)} placeholder="correction-20261017" /></label>}
      </div>
      {kind !== "scan" && status.data?.mode !== "demo" && <label className="hunter-consent"><input type="checkbox" checked={external} onChange={e => setExternal(e.target.checked)} />J-Quantsへの実接続を許可して開始する</label>}
      {jobBlocked && <p role="note">{jobBlocked}</p>}
      <div className="hunter-preflight" aria-label="取得前チェック" aria-live="polite">
        <strong>取得前チェック</strong>
        {!preflightBody && <p>日付・取得期間・訂正revisionを確認してください。</p>}
        {preflightBody && preflight.isPending && <p>契約設定と保存済みデータを確認中…</p>}
        {preflight.error && <p role="alert">事前チェックに接続できません。サーバーの起動状態を確認してください。</p>}
        {preflight.data && <><p>{preflight.data.plan} ／ 契約上限 {preflight.data.limit}回/分 ／ アプリの取得速度 {preflight.data.rpm}回/分</p>
          <p>取得可能期間：{preflight.data.windowFrom} 〜 {preflight.data.windowTo}</p>
          <p>{kind === "scan" ? "保存済みデータの分析：外部APIは使用しません。" : `対象 ${preflight.data.sessions}営業日 ／ 取得済み ${preflight.data.cachedDays}日 ／ API最少 ${preflight.data.minimumRequests}回 ／ 通信待ち時間の目安 ${Math.ceil(preflight.data.minimumSeconds / 60)}分以上（分析時間は別）`}</p>
          {preflight.data.waitSeconds > 0 && <p>API再開まで約{preflight.data.waitSeconds}秒待機します。</p>}
          {preflight.data.errors.map(error => <p role="alert" className="error" key={error}>{error}</p>)}
          {preflight.data.warnings.map(warning => <p className="muted" key={warning}>{warning}</p>)}
          {!preflight.data.errors.length && <p>設定上は開始できます。実接続の成功を保証するチェックではありません。</p>}
        </>}
        <button className="hunter-reset" disabled={!preflightBody || preflight.isFetching} onClick={() => void preflight.refetch()}>再チェック</button>
      </div>
      <button disabled={!!jobBlocked || preflightBlocked} onClick={() => void act("/bottom/hunter/jobs", { kind, asOf, ...(kind !== "scan" && acquisitionFrom ? { from: acquisitionFrom } : {}), ...(revision ? { revision } : {}), confirmExternal: external })}>{busy ? "開始中…" : kind === "scan" ? "保存済みデータを分析して反映" : "データを取得してランキングに反映"}</button>
      {jobMessage && <p role={jobError ? "alert" : "status"} className={jobError ? "error" : undefined}>{jobMessage}</p>}
      {activeJob && <div aria-live="polite"><p>状態：{({ queued: "開始待ち", running: "実行中", paused: "一時停止", cancelled: "中止", failed: "失敗", completed: "完了・ランキング反映済み" })[activeJob.status]} ／ 基準日 {activeJob.input.asOf}</p>
        {activeJob.acquisition && <p>データ取得：{activeJob.acquisition.total ? `${activeJob.acquisition.completed} / ${activeJob.acquisition.total}営業日` : "営業日カレンダーを確認中"}{activeJob.acquisition.date && ` ／ ${activeJob.acquisition.date}`}</p>}
        <p>銘柄分析：{activeJob.total ? `${activeJob.processed} / ${activeJob.total}銘柄` : "データの準備後に開始します"}</p>
        {activeJob.status === "running" && <p>完了すると自動でランキングを更新します。このページを開いたままお待ちください。</p>}
        {activeJob.error && <p role="alert" className="error">{activeJob.error}{activeJob.error.includes("マスター") && "。「初回取得」を選び、対象期間のデータを取得してください。"}</p>}
        {["paused", "failed", "cancelled"].includes(activeJob.status) && <button disabled={busy || !!runningJob} onClick={() => void act("/bottom/hunter/jobs", { resumeJobId: activeJob.id })}>中断した処理を再開</button>}
        {["running", "queued"].includes(activeJob.status) && <button disabled={busy} onClick={() => void act(`/bottom/hunter/jobs/${activeJob.id}/cancel`, {})}>処理を中止</button>}
      </div>}
    </section>
    <section className="card hunter-filter-panel">
      <div className="hunter-filter-heading"><div><h2>表示の絞り込み</h2><p>変更すると結果に即時反映されます。</p></div>
      <button className="hunter-reset" onClick={() => setParams(current => { const next = new URLSearchParams(); for (const key of ["jobId", "asOf", "view"]) { const value = current.get(key); if (value) next.set(key, value); } return next; })}>絞り込みを解除</button></div>
      <div className="hunter-filters">
      <label>基準日<input type="date" value={params.get("asOf") ?? ""} onChange={e => update("asOf", e.target.value)} /></label>
      <label>市場区分<select value={params.get("market") ?? ""} onChange={e => update("market", e.target.value)}><option value="">すべて</option>{[["0111","プライム"],["0112","スタンダード"],["0113","グロース"],["0105","TOKYO PRO MARKET"]].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>スコア下限<input type="number" min="0" max="100" value={params.get("minScore") ?? ""} onChange={e => update("minScore", e.target.value)} /></label>
      <label>RSI下限<input type="number" min="0" max="100" value={params.get("rsiMin") ?? ""} onChange={e => update("rsiMin", e.target.value)} /></label>
      <label>RSI上限<input type="number" min="0" max="100" value={params.get("rsiMax") ?? ""} onChange={e => update("rsiMax", e.target.value)} /></label>
      <label>60日下落率の上限<input aria-label="60日下落率以下（小数）" type="number" min="-1" max="0" step="0.01" placeholder="例：-0.2（-20%）" value={params.get("maxDrawdown") ?? ""} onChange={e => update("maxDrawdown", e.target.value)} /></label>
      <label>流動性<select value={params.get("liquidity") ?? ""} onChange={e => update("liquidity", e.target.value)}><option value="">すべて</option><option value="sufficient">1億円以上</option><option value="low">1億円未満</option><option value="unknown">未確認</option></select></label>
      <label>候補分類<select value={params.get("category") ?? ""} onChange={e => update("category", e.target.value)}><option value="">すべて</option>{hunterCategory.options.map(c => <option key={c}>{c}</option>)}</select></label>
      <label>リスク<select value={params.get("risk") ?? ""} onChange={e => update("risk", e.target.value)}><option value="">すべて</option><option value="yes">あり</option><option value="no">なし</option></select></label>
      </div>
    </section>
    <label>予測記録の区分<select value={recordingMode} onChange={e => setRecordingMode(e.target.value)}><option value="research">過去研究（後から作成した仮説）</option><option value="live">実運用（当日作成のみ）</option></select></label>
    <div className="hunter-result-tabs" role="group" aria-label="分析結果の表示">
      <button aria-pressed={!unavailableView} onClick={() => { update("view", "ranked"); }}>ランキング（{ranks.data?.rankedCount ?? 0}銘柄）</button>
      <button aria-pressed={unavailableView} onClick={() => { update("view", "unavailable"); }}>判定不能（{ranks.data?.unavailableCount ?? 0}銘柄）</button>
    </div>
    <h2>{unavailableView ? "判定不能の銘柄" : "採点済みランキング"}（{ranks.data?.total ?? 0}件）</h2>
    <p className="muted">{unavailableView ? "データ不足・不備のため採点できなかった銘柄です。順位は付けていません。" : "採点できた銘柄だけを掲載しています。判定不能の銘柄はランキングに含めません。"}</p>
    {!unavailableView && coverage && ranks.data?.rankedCount === 0 && <div className="callout"><strong>採点できた銘柄がないため、ランキングはまだ作成できません。</strong><p>ハンターの初回取得で、基準日まで連続80営業日を含む期間を取得してください。対象はウォッチリスト外も含む全市場です。ウォッチリストへの追加は不要です。</p><p>ホームで取得した個別銘柄の日足とは別のデータを使います。取得済みの日付は再利用します。</p></div>}
    {ranks.isLoading && <p role="status">ランキングを読み込み中…</p>}
    {!ranks.isLoading && !ranks.error && !ranks.data?.rows.length && <p>{runningJob ? "取得・分析中です。上の進捗をご確認ください。" : !unavailableView && ranks.data?.rankedCount === 0 && coverage ? "判定不能の銘柄は、上の「判定不能」から確認できます。" : coverage?.processedCount ? "絞り込み条件に一致する銘柄がありません。「絞り込みを解除」で結果を確認できます。" : "まだ分析結果がありません。上の「ランキングを更新する」で初回取得、または保存済みデータの分析を開始してください。"}</p>}
    {!mobile && <div className="hunter-desktop"><table><thead><tr><th>順位・銘柄・市場</th><th>点数・分類</th><th>RSI・下落率・出来高倍率</th><th>平均売買代金</th><th>根拠・リスク・取得状態</th><th>操作</th></tr></thead><tbody>{ranks.data?.rows.map(r => <tr key={r.code}><td>{r.rank !== null ? `${r.rank}位 · ` : ""} {displayStockCode(r.code)} {r.name}<br />{r.marketName} · {r.asOf}</td><td>{r.score ?? "—"}点<br />{r.category}{r.candidate ? " · 候補" : ""}</td><td>{number(r.rsi)} ／ {number(r.drawdown,true)} ／ {number(r.volumeRatio)}</td><td>{number(r.averageTurnover20)}円</td><td>{r.reasons.slice(0,3).map(hunterLabel).join("、")}<br />{r.risks.map(hunterLabel).join("、") || "追加リスクなし"}<br />{acquisitionLabel[r.acquisitionStatus]} · {r.continuousSessions}営業日</td><td>{actions(r)}</td></tr>)}</tbody></table></div>}
    {mobile && <div className="hunter-mobile">{ranks.data?.rows.map(r => <article className="card" key={r.code}><h3>{r.rank !== null ? `${r.rank}位 · ` : ""} {displayStockCode(r.code)} {r.name}</h3><p>{r.marketName} · {r.asOf} ／ {r.score ?? "—"}点 · {r.category}</p><p>RSI {number(r.rsi)} ／ 下落 {number(r.drawdown,true)} ／ 出来高 {number(r.volumeRatio)}倍 ／ 売買代金 {number(r.averageTurnover20)}円</p><p>{r.reasons.slice(0,3).map(hunterLabel).join("、")}</p><p>{r.risks.map(hunterLabel).join("、")} · {acquisitionLabel[r.acquisitionStatus]} · {r.continuousSessions}営業日</p>{actions(r)}</article>)}</div>}
    <div className="toolbar"><button disabled={!parsed.success || (parsed.data.page ?? 1) <= 1} onClick={() => update("page", String((parsed.success ? parsed.data.page : 1)-1))}>前のページ</button><span>{parsed.success ? parsed.data.page : "—"}ページ</span><button disabled={!ranks.data || ranks.data.page*ranks.data.pageSize >= ranks.data.total} onClick={() => update("page", String((parsed.success ? parsed.data.page : 1)+1))}>次のページ</button></div>
    {detail.error && <p role="alert">{detail.error.message}</p>}
    {detail.isFetching && <p role="status">詳細を読み込み中…</p>}
    {detail.data && <Suspense fallback={<p role="status">チャート・研究画面を読み込み中…</p>}><article className="card hunter-detail"><h2>{detail.data.row.name} 底打ち詳細</h2><p>{detail.data.explanation}</p><p>{detail.data.analysis.score ?? "—"}点 ／ {detail.data.row.category}</p><HunterPriceChart chart={detail.data.analysis.chart} /><ul>{detail.data.analysis.conditions.map(c => <li key={c.code}>{c.met ? "一致" : "未一致"} · {c.label} · {c.earnedPoints}/{c.maxPoints}点</li>)}</ul><p>リスク：{detail.data.analysis.riskCodes.map(hunterLabel).join("、")}</p><p>{detail.data.dejavuWarning}</p>{detail.data.dejavu && <DejavuResearch data={detail.data.dejavu} code={detail.data.row.code} date={detail.data.row.asOf} compare="" hunterJobId={detail.data.row.jobId} request={request} memories={<p>ハンターの予測原本・反省は研究ジャーナルに保存します。</p>} />}</article></Suspense>}
    <section className="card"><h2>研究仮説の結果検証</h2><p>実運用・過去研究・walk-forwardは別集計です。方向一致率は将来の的中確率ではありません。</p><button aria-expanded={showSummary} onClick={() => setShowSummary(!showSummary)}>成績集計を{showSummary ? "閉じる" : "表示"}</button>{showSummary && summaries.isLoading && <p role="status">成績を集計中…</p>}<button disabled={busy} onClick={() => void act("/bottom/hunter/evaluations", {})}>期限後の結果を検証</button>{summaries.error && <p role="alert">{summaries.error.message}</p>}{showSummary && summaries.data?.groups.length === 0 && <p>評価対象の予測記録がありません。</p>}{showSummary && summaries.data?.groups.map(g => <article key={g.key}><p>{g.mode} ／ {g.experiment} ／ {g.horizon}営業日 ／ {g.classification} ／ {g.band}点 ／ 基準月 {g.period}</p>{g.lowSample && <strong>少数標本：評価済み20件未満で信頼性は低い集計です。</strong>}<p>未評価 {g.pending} ／ 評価可能（評価済み含む） {g.eligible ?? g.available} ／ 評価済み {g.evaluated} ／ 方向一致 {number(g.directionRate,true)} ／ 実現騰落率 {number(g.meanReturn,true)} ／ 実現中央値 {number(g.medianReturn,true)} ／ 上昇割合 {number(g.upRatio,true)} ／ 予測中央値との差 {number(g.meanError,true)} ／ 絶対誤差 {number(g.meanAbsoluteError,true)} ／ 最悪最大下落 {number(g.worstDrawdown,true)} ／ 下落分布25%・中央値・75% {number(g.drawdownDistribution?.p25,true)}・{number(g.drawdownDistribution?.median,true)}・{number(g.drawdownDistribution?.p75,true)}（{g.drawdownCount ?? 0}件）</p></article>)}</section>
    <details className="card"><summary>ジョブの進捗・中断・再開</summary>{status.data?.jobs.map(job => <article key={job.id}><p>{job.input.kind} · {job.input.asOf} · {job.status} · {job.processed}/{job.total}</p><p>{job.error}</p>{job.status !== "completed" && <><button disabled={busy || job.status === "running"} onClick={() => void act("/bottom/hunter/jobs", { resumeJobId: job.id })}>再開</button><button disabled={busy} onClick={() => void act(`/bottom/hunter/jobs/${job.id}/cancel`, {})}>キャンセル</button></>}</article>)}</details>
  </section>;
}
