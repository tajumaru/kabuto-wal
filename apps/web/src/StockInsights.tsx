import { Link } from "react-router-dom";
import { memoryKindLabel } from "./MemoryContent";
import "./StockInsights.css";

type Memory = {
  recordId: string;
  active: boolean;
  providerCode?: string;
  kind: string;
  text: string;
  createdAt: string;
  dataAsOf?: string;
  payload?: unknown;
};
type Forecast = {
  predictionId: string;
  providerCode: string;
  createdAt: string;
  dataAsOf: string;
  targetSessionDate: string;
  horizonSessions: number;
  predictedReturn: number;
  sampleCount: number;
  reason: string;
  evaluations?: { actualReturn: number }[];
};
const change = (value: number) =>
  Number.isFinite(value)
    ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`
    : "—";
const newest = <T extends { createdAt: string }>(items: T[]) =>
  [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
function preview(memory: Memory) {
  let payload = memory.payload;
  if (!payload) {
    try {
      payload = JSON.parse(memory.text);
    } catch {
      /* A plain note needs no parsing. */
    }
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const fields = payload as Record<string, unknown>;
    if (memory.kind === "dejavu_memory" && Array.isArray(fields.examples))
      return `似た値動きの過去事例を${fields.examples.length}件保存`;
    const text = [fields.summary, fields.answer, fields.text].find(
      (value): value is string => typeof value === "string" && !!value.trim(),
    );
    return text
      ? excerpt(text)
      : `${memoryKindLabel(memory.kind)}の分析データを保存しています。`;
  }
  return excerpt(memory.text);
}
function excerpt(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "本文のない記録です。";
  const sentence = clean.match(/^.*?[。！？]/)?.[0] || clean;
  const short = sentence.slice(0, 70);
  return short.length < clean.length ? short + "…" : short;
}

function MemoryItem({ memory }: { memory: Memory }) {
  return (
    <article className="stock-memory-item">
      <div className="stock-memory-meta">
        <span>{memoryKindLabel(memory.kind)}</span>
        <time>{memory.dataAsOf || memory.createdAt.slice(0, 10)}</time>
      </div>
      <p>{preview(memory)}</p>
      <details>
        <summary>全文・保存データを見る</summary>
        <p className="stock-memory-full">{memory.text}</p>
        <small>記録ID：{memory.recordId}</small>
      </details>
    </article>
  );
}
export function StockInsights({
  code,
  memories,
  predictions,
  memoryLoading,
  predictionLoading,
  memoryError,
  predictionError,
}: {
  code: string;
  memories: Memory[];
  predictions: Forecast[];
  memoryLoading: boolean;
  predictionLoading: boolean;
  memoryError: boolean;
  predictionError: boolean;
}) {
  const own = newest(
    memories.filter((m) => m.active && m.providerCode === code),
  );
  const shared = newest(memories.filter((m) => m.active && !m.providerCode));
  const forecasts = newest(predictions.filter((p) => p.providerCode === code));
  const latest = [1, 5, 20].map((horizon) => ({
    horizon,
    record: forecasts.find((p) => p.horizonSessions === horizon),
  }));
  return (
    <section className="card stock-insights" aria-label="この銘柄の記憶と予測">
      <div className="stock-insights-heading">
        <div>
          <span className="stock-eyebrow">RESEARCH NOTES & FORECASTS</span>
          <h2>この銘柄の記憶と予測</h2>
          <p>過去に残したメモと、期限ごとの最新予測を確認できます。</p>
        </div>
      </div>
      <div className="stock-insights-grid">
        <section aria-label="銘柄の記憶">
          <div className="stock-insights-subheading">
            <h3>覚えておきたいこと</h3>
            <span>
              {memoryLoading || memoryError ? "—" : `${own.length}件`}
            </span>
          </div>
          {memoryLoading ? (
            <p role="status">記憶を読み込み中…</p>
          ) : memoryError ? (
            <p role="alert">記憶を読み込めませんでした。</p>
          ) : (
            <>
              {!own.length && (
                <p className="stock-insights-empty">
                  この銘柄だけに紐づく記憶はまだありません。
                </p>
              )}
              {own.slice(0, 3).map((m) => (
                <MemoryItem key={m.recordId} memory={m} />
              ))}
              {own.length > 3 && (
                <details className="stock-more-notes">
                  <summary>以前の記憶を表示（{own.length - 3}件）</summary>
                  {own.slice(3).map((m) => (
                    <MemoryItem key={m.recordId} memory={m} />
                  ))}
                </details>
              )}
              {!!shared.length && (
                <details className="stock-shared-notes">
                  <summary>全銘柄に共通するメモ（{shared.length}件）</summary>
                  <p>
                    銘柄指定のない方針やメモです。この銘柄だけの分析ではありません。
                  </p>
                  {shared.map((m) => (
                    <MemoryItem key={m.recordId} memory={m} />
                  ))}
                </details>
              )}
            </>
          )}
          <Link to="/memories" className="stock-insights-link">
            記憶の管理へ →
          </Link>
        </section>
        <section aria-label="期限ごとの最新予測">
          <div className="stock-insights-subheading">
            <h3>最新の予測</h3>
            <span>
              {predictionLoading || predictionError
                ? "—"
                : `${forecasts.length}件の記録`}
            </span>
          </div>
          {predictionLoading ? (
            <p role="status">予測を読み込み中…</p>
          ) : predictionError ? (
            <p role="alert">予測を読み込めませんでした。</p>
          ) : (
            <>
              <p className="stock-forecast-help">
                予測騰落率と、期限後に確認した実績です。基準日は予測ごとに異なります。
              </p>
              <div className="stock-forecast-list">
                {latest.map(({ horizon, record }) => (
                  <article className="stock-forecast-row" key={horizon}>
                    <div className="stock-forecast-horizon">
                      {horizon}
                      <small>営業日先</small>
                    </div>
                    {record ? (
                      <div className="stock-forecast-body">
                        <div className="stock-forecast-values">
                          <div>
                            <span>予測騰落率</span>
                            <strong>{change(record.predictedReturn)}</strong>
                          </div>
                          <div>
                            <span>検証結果</span>
                            <strong className="stock-forecast-actual">
                              {record.evaluations?.length
                                ? `実績 ${change(record.evaluations.at(-1)!.actualReturn)}`
                                : "未検証"}
                            </strong>
                          </div>
                        </div>
                        <p className="stock-forecast-date">
                          基準 {record.dataAsOf} → 期限{" "}
                          {record.targetSessionDate}
                        </p>
                        <details>
                          <summary>予測の根拠</summary>
                          <p>{record.reason}</p>
                          <p>過去サンプル {record.sampleCount}件</p>
                        </details>
                      </div>
                    ) : (
                      <p className="stock-insights-empty">
                        予測はまだありません
                      </p>
                    )}
                  </article>
                ))}
              </div>
              <p className="stock-forecast-help">
                予測は過去データに基づく推定です。将来の値動きを保証しません。
              </p>
            </>
          )}
          <Link to="/predictions" className="stock-insights-link">
            予測履歴で詳しく確認 →
          </Link>
        </section>
      </div>
    </section>
  );
}
