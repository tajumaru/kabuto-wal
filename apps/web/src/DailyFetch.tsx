import { displayStockCode } from "./stock-search";
type Step = { step?: string; code?: string; count?: number; status?: string; dataAsOf?: string; requestedThrough?: string; error?: string; horizon?: number };
type Job = { recordId: string; createdAt: string; status: string; steps: Step[] };
const time = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日時不明" : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "medium" }).format(date);
};
const label = (status: string) => ({ done: "完了", running: "実行中", failed: "失敗", interrupted: "中断", ok: "反映済み", missing: "未反映" })[status] ?? status;

export function DailyFetch({ jobs = [] }: { jobs?: Job[] }) {
  const history = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = history[0];
  const prices = latest?.steps.filter((s) => s.step === "prices") ?? [];
  return <section className="card daily-fetch">
    <div className="fetch-heading"><h2>日次取得</h2><span className="fetch-zone">日本時間 · JST</span></div>
    <div className="fetch-summary">
      <div><span>最終実行（開始時刻）</span><strong>{latest ? time(latest.createdAt) : "まだ実行されていません"}</strong></div>
      <div><span>処理状況</span><strong>{latest ? label(latest.status) : "履歴なし"}</strong></div>
      <div><span>最新実行の株価反映</span><strong>{prices.length ? `${prices.filter((s) => s.status === "ok").length} / ${prices.length} 銘柄` : "取得記録なし"}</strong></div>
    </div>
    <ol className="fetch-schedule" aria-label="取得スケジュール">
      <li><strong>17:30</strong><span>初回取得</span></li><li><strong>18:00</strong><span>未反映時に再試行</span></li><li><strong>19:00</strong><span>未反映時に再試行</span></li>
    </ol>
    <p className="muted">ブラウザを閉じても常時稼働サーバーのCLIジョブが動きます。ローカルPCを停止すると取得も停止します。</p>
    <h3>実行履歴 <small>最新{history.length}件</small></h3>
    {!history.length && <p className="muted">実行後に、銘柄ごとの取得状況がここに表示されます。</p>}
    <div className="fetch-history">{history.map((job, index) => <details key={job.recordId} open={index === 0} className="fetch-run">
      <summary><time dateTime={job.createdAt}>{time(job.createdAt)}</time><span className={`fetch-badge ${job.status === "failed" ? "fetch-warning" : job.status === "done" ? "fetch-success" : ""}`}>{label(job.status)}</span></summary>
      {job.steps.some((s) => s.step === "prices") && <div className="fetch-table-scroll"><table className="fetch-table"><thead><tr><th>銘柄コード</th><th>反映状況</th><th>取得件数</th><th>データ基準日</th><th>取得対象日まで</th></tr></thead><tbody>{job.steps.filter((s) => s.step === "prices").map((s, i) => <tr key={i}><td>{s.code ? displayStockCode(s.code) : "—"}</td><td><span className={`fetch-badge ${s.status === "ok" ? "fetch-success" : "fetch-warning"}`}>{label(s.status ?? "不明")}</span></td><td>{s.count?.toLocaleString("ja-JP") ?? "—"} 件</td><td>{s.dataAsOf ?? "—"}</td><td>{s.requestedThrough ?? "—"}</td></tr>)}</tbody></table></div>}
      {job.steps.filter((s) => s.step !== "prices" || s.error).map((s, i) => <p key={i} className={s.error ? "error" : "muted"}>{s.step === "evaluation" ? `予測評価：${s.count ?? 0} 件` : s.step === "forecast" ? `予測作成：${s.code ? displayStockCode(s.code) : ""}（${s.horizon ?? "—"}日）` : s.step === "memwal" ? "MemWal同期" : s.step ?? "処理"}{s.error ? `：${s.error}` : ""}</p>)}
      {!job.steps.length && <p className="muted">処理結果はまだ記録されていません。</p>}
    </details>)}</div>
  </section>;
}

