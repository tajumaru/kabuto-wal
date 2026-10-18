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
            supported: "今回調べた範囲では、改善が見られました",
            mixed: "時期によって結果が分かれました",
            "not-supported": "今回の比較では、改善を確認できませんでした",
            "insufficient-data": "判断するためのデータが足りません",
          }[r.classification]
        }
      </strong>
      {r.classification === "insufficient-data" && (
        <p>
          データがない、比較する期間を選んでいない、件数が少ないなどの理由で、ルールの良し悪しをまだ判断できません。これは必ずしも操作の失敗ではありません。
        </p>
      )}
      <details>
        <summary>評価の詳しい理由を読む</summary>
        <p>{r.reason}</p>
      </details>
      <p>
        この結果は今回の調査についての振り返りです。これから株価が上がると約束するものではありません。
      </p>
      <h3>時期を変えて比べた結果</h3>
      {r.comparison.folds.length === 0 && (
        <p>比較する時期を選んでいないか、まだ比較が終わっていません。</p>
      )}
      {r.comparison.folds.map((f) => (
        <details key={f.labPlanId}>
          <summary>
            期間 {f.index + 1} · {f.included ? "集計対象" : "集計対象外"} ·{" "}
            {f.period.from}〜{f.period.to}
          </summary>
          <p>{f.reason}</p>
          {f.methods.map((m) => (
            <p key={m.methodId}>
              判定ルール {m.methodId.slice(0, 12)} ／ 現行対比差 {pct(m.score)}{" "}
              ／ 候補対照差 {pct(m.candidateControlDifference)} ／ 候補
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
        保存された実験の数：{r.comparison.trialCount}
        。何度も試すと、偶然よい結果だけが見つかることがあります。
      </p>
      <details>
        <summary>同じ日に比べたルールごとの違い</summary>
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
      <h3>まだ使っていない期間での最後の確認</h3>
      {r.finalTest ? (
        <p>
          実験 {r.finalTest.experimentId.slice(0, 12)} ／ 現行対比差{" "}
          {pct(r.finalTest.difference)} ／{" "}
          {r.finalTest.sufficient ? "標本条件を充足" : "標本不足"} ／ Evidence{" "}
          {r.finalTest.evidenceId}
        </p>
      ) : (
        <p>
          比較するルールが決まっていない、データが足りないなどの理由で、最後の確認は行っていないか、まだ終わっていません。
        </p>
      )}
      <h3>結果を読むときの注意</h3>
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
      <details>
        <summary>結果を照合するための記録ID</summary>
        <p>{r.reportId}</p>
      </details>
    </section>
  );
}
