import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { AgentResearchReport } from "../../../packages/core/kabumaru-agent-report-schema";
const pct = (n: number | null) =>
  n === null ? "未評価" : `${(n * 100).toFixed(2)}ポイント`;
export function AgentResearchResults({
  report: r,
  request,
}: {
  report: AgentResearchReport;
  request: (url: string, body?: unknown) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    evidence = useQuery({
      queryKey: ["agent-evidence", r.sessionId, page],
      enabled: open,
      queryFn: async () =>
        z
          .object({ records: z.array(z.string()), total: z.number() })
          .parse(
            await request(
              `/research/agent/sessions/${r.sessionId}/evidence?page=${page}`,
            ),
          ),
    });
  return (
    <section className="card">
      <h2>研究結果と振り返り</h2>
      <strong>
        {
          {
            supported: "観測範囲内で支持",
            mixed: "結果が混在",
            "not-supported": "仮説は支持されず",
            "insufficient-data": "データ不足",
          }[r.classification]
        }
      </strong>
      <p>{r.reason}</p>
      <p>
        研究仮説への評価で、株価上昇・本番採用・統計的優位性を保証しません。
      </p>
      <h3>walk-forward結果</h3>
      {r.comparison.folds.length === 0 && <p>検証foldが未指定・未完了です。</p>}
      {r.comparison.folds.map((f) => (
        <details key={f.labPlanId}>
          <summary>
            fold {f.index + 1} · {f.included ? "集計対象" : "除外"} ·{" "}
            {f.period.from}〜{f.period.to}
          </summary>
          <p>{f.reason}</p>
          {f.methods.map((m) => (
            <p key={m.methodId}>
              実験方式 {m.methodId.slice(0, 12)} ／ 現行対比差 {pct(m.score)} ／
              候補対照差 {pct(m.candidateControlDifference)} ／ 候補
              {m.candidateCount}件 ／ データ不足
              {(m.missingFeatureRate * 100).toFixed(1)}% ／ Evidence{" "}
              {m.evidenceId}
            </p>
          ))}
        </details>
      ))}
      {r.comparison.methods.map((m) => (
        <p key={m.methodId}>
          方式 {m.methodId.slice(0, 12)}：{m.foldCount}fold ／ 中央値
          {pct(m.median)} ／ 最悪{pct(m.min)} ／ 最良{pct(m.max)} ／ 標準偏差
          {pct(m.standardDeviation)} ／ 候補数{m.candidateCountMin ?? "—"}〜
          {m.candidateCountMax ?? "—"}
        </p>
      ))}
      <p>
        探索ジョブ数：{r.comparison.trialCount}。多重比較による過学習に注意。
      </p>
      <details>
        <summary>方式間の対応付き差</summary>
        {r.comparison.pairedMethodDifferences.length === 0 ? (
          <p>比較方式または対応時点が不足しています。</p>
        ) : (
          r.comparison.pairedMethodDifferences.map((d, i) => (
            <p key={i}>
              fold {d.foldIndex + 1} · {d.left.slice(0, 8)}−
              {d.right.slice(0, 8)}：同日時点{d.dates}件 ／ 平均{pct(d.mean)} ／
              中央値{pct(d.median)}
            </p>
          ))
        )}
      </details>
      <h3>最終Test</h3>
      {r.finalTest ? (
        <p>
          実験 {r.finalTest.experimentId.slice(0, 12)} ／ 現行対比差{" "}
          {pct(r.finalTest.difference)} ／{" "}
          {r.finalTest.sufficient ? "標本条件を充足" : "標本不足"} ／ Evidence{" "}
          {r.finalTest.evidenceId}
        </p>
      ) : (
        <p>方式未選択・データ不足等のため未開封、または未完了です。</p>
      )}
      <h3>不確実性</h3>
      <details>
        <summary>限界と注意点を確認</summary>
        {r.uncertainty.map((w, i) => (
          <p key={i}>{w}</p>
        ))}
      </details>
      <h3>次の研究テーマ</h3>
      <ul>
        {r.nextTopics.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>計画のEvidence（必要時に読み込み）</summary>
        {evidence.isFetching && <p role="status">根拠を読み込み中…</p>}
        {evidence.error && <p role="alert">根拠を確認できません。</p>}
        {evidence.data?.records.map((id) => (
          <p key={id}>{id}</p>
        ))}
        {evidence.data?.total === 0 && (
          <p>
            計画時点の研究ノートEvidenceはありません。実験Evidenceは各foldを参照してください。
          </p>
        )}
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          前の根拠
        </button>
        <button
          disabled={page * 20 >= (evidence.data?.total ?? 0)}
          onClick={() => setPage(page + 1)}
        >
          次の根拠
        </button>
      </details>
      <p>Result hash {r.reportId}</p>
    </section>
  );
}
