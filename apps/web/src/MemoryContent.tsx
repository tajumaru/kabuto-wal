import { displayStockCode } from "./stock-search";

export const memoryKindLabel = (kind: string) => ({
  dejavu_memory: "似た値動きの分析", user_memory: "方針・メモ",
  prediction_memory: "予測の記録", lesson_memory: "検証の振り返り",
  market_analysis: "相場の分析", chat_memory: "会話の記録",
})[kind] ?? "保存記録";

export function memorySyncLabel(status?: string, blobId?: string) {
  if (status === "synced") return blobId ? "MemWal保存完了" : "MemWal保存完了未確認";
  return ({ pending: "MemWal同期待ち", submitting: "MemWal送信処理中", accepted: "MemWal受付済み・保存完了待ち", uncertain: "MemWal送信結果不明", failed: "MemWal同期失敗", local: "アプリ内のみ保存" })[status ?? ""] ?? "MemWal保存未確認";
}

export function MemoryContent({ memory, stocks }: { memory: any; stocks: any[] }) {
  const stockName = (code: string) => {
    const stock = stocks.find((s) => s.providerCode === code);
    return `${displayStockCode(code)}${stock ? ` ${stock.name}` : ""}`;
  };
  const savedDate = new Date(memory.createdAt);
  const savedTime = Number.isNaN(savedDate.getTime()) ? "保存日時不明" : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(savedDate);
  let payload = memory.payload;
  if (!payload && memory.kind === "dejavu_memory") {
    try { payload = JSON.parse(memory.text); } catch { /* Display the original note below. */ }
  }
  const analysis = memory.kind === "dejavu_memory" && Array.isArray(payload?.examples);
  const change = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%` : "—";
  return <div className="memory-content">
    {analysis ? <>
      <h3>{stockName(memory.providerCode || payload.providerCode || "")}の似た値動き</h3>
      <p className="muted">分析基準日：{memory.dataAsOf || payload.asOf || "—"} · 比較対象：{stockName(payload.compareCode || memory.providerCode || "")}</p>
      <p>過去の似た期間を{payload.examples.length}件保存しました。類似度は値動きの近さを表します。</p>
      <div className="memory-table-scroll"><table className="memory-examples">
        <thead><tr><th>似ていた過去の期間</th><th>類似度</th><th>その後1営業日</th><th>5営業日</th><th>20営業日</th></tr></thead>
        <tbody>{payload.examples.map((example: any, index: number) => <tr key={index}>
          <td>{example.start} ～ {example.end}</td>
          <td>{typeof example.score === "number" ? `${example.score.toFixed(1)} / 100` : "—"}</td>
          <td>{change(example.future?.[1])}</td><td>{change(example.future?.[5])}</td><td>{change(example.future?.[20])}</td>
        </tr>)}</tbody>
      </table></div>
      {!payload.examples.length && <p className="muted">似ていた過去の期間はありません。</p>}
      <p className="muted">「その後」は過去の実績です。類似度は上昇確率ではありません。未取得の実績は「—」で表示します。</p>
    </> : <p className="memory-note">{memory.text}</p>}
    <p className="muted">保存日時：{savedTime}（日本時間）</p>
    <p className="memory-storage-note">{memory.sync?.status === "synced" && memory.sync?.blobId
      ? "保存先：このアプリ ＋ MemWal（保存完了のblob IDを確認済み）"
      : memory.sync?.status === "accepted"
        ? "このアプリには保存済みです。MemWalは受付済みですが、保存完了はまだ確認できていません。"
        : "このアプリには保存済みです。MemWalへの保存完了は確認できていません。"}</p>
    <details className="memory-details"><summary>保存データの詳細</summary>
      <p className="muted">記録ID：{memory.recordId}</p>
      {memory.sync?.blobId && <p style={{overflowWrap:"anywhere"}}>MemWal blob ID：{memory.sync.blobId}</p>}
      {memory.sync?.jobId && <p style={{overflowWrap:"anywhere"}}>MemWal受付ジョブID：{memory.sync.jobId}</p>}
      {analysis && <pre>{JSON.stringify(payload, null, 2)}</pre>}
    </details>
  </div>;
}
