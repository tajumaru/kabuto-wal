import type { LabReport } from "../../../packages/core/hunter-lab-report-schema";
import { labDefaultWeights } from "../../../packages/core/hunter-experiment-method";
import { labFeatureLabels } from "./LabMethodEditor";
const pct = (n: number | null) =>
  n === null ? "未評価" : `${(n * 100).toFixed(2)}%`;
export function LabResearchReport({ report: r }: { report: LabReport }) {
  return (
    <article className="card">
      <h2>かぶまる実験レポート</h2>
      <p>
        {r.stage} ／ {r.period.from}〜{r.period.to} ／ 評価可能
        {r.evaluatedPairs}銘柄・期間 ／ 試行{r.trialCount}件
      </p>
      <strong>
        {r.sufficient
          ? "探索的結果です。採用は人間が判断します。"
          : "標本不足のため優劣は判断できません。"}
      </strong>
      <p>
        候補判定一致率{pct(r.candidateAgreement)} ／ 候補集合Jaccard
        {pct(r.candidateJaccard)} ／ 特徴量不足率{pct(r.missingFeatureRate)} ／
        往復コスト{pct(r.costPerTrade)}
      </p>
      <details>
        <summary>変更した採点条件・理由・使用ノート</summary>
        <p>
          方式：{r.method.name} ／ 追加候補閾値{r.method.candidateThreshold}点
        </p>
        <p>変更理由・仮説：{r.method.hypothesis}</p>
        {(Object.keys(labDefaultWeights) as (keyof typeof labDefaultWeights)[])
          .filter((k) => r.method.parameters[k] !== labDefaultWeights[k])
          .map((k) => (
            <p key={k}>
              {labFeatureLabels[k]}：{labDefaultWeights[k]}→
              {r.method.parameters[k]}
            </p>
          ))}
        <p>重みは合計100点に正規化。現行候補の安全条件を維持。</p>
        {r.notebookIds.length ? (
          r.notebookIds.map((id) => (
            <p key={id}>
              <a href={`/research/notebook?id=${id}`}>根拠ノート {id}</a>
            </p>
          ))
        ) : (
          <p>手動仮説。参照研究ノートなし。</p>
        )}
      </details>
      {r.comparisons.map((c) => (
        <section key={c.horizon}>
          <h3>{c.horizon}営業日後</h3>
          <p>
            固定ユニバース平均{pct(c.marketMean)} ／ 現行の平均超過
            {pct(c.baselineExcess)} ／ 実験の平均超過{pct(c.experimentExcess)}
          </p>
          <p>
            同時点候補の平均差
            {c.candidateMeanDifference === null
              ? "未評価"
              : `${(c.candidateMeanDifference * 100).toFixed(2)}ポイント`}{" "}
            ／ 対応{c.pairedDates}時点
          </p>
        </section>
      ))}
      <h3>新旧方式・スコア帯別実績</h3>
      {(
        [
          ["現行", r.baseline],
          ["実験", r.experiment],
        ] as const
      ).map(([label, data]) => (
        <details key={label}>
          <summary>{label}方式の成績を開く</summary>
          {data.groups.map((g) => (
            <section key={g.key}>
              <h4>{g.horizon}営業日</h4>
              <p>
                候補{g.candidate.count}／非候補{g.control.count}、評価済
                {g.candidate.evaluated + g.control.evaluated}件
              </p>
              {([g.candidate, g.control] as const).map((m, i) => (
                <p key={i}>
                  {i ? "非候補" : "候補"}：平均{pct(m.meanReturn)}／中央値
                  {pct(m.medianReturn)}／上昇割合{pct(m.upRatio)}／最大下落
                  {pct(m.maxDrawdown)}／再下落割合{pct(m.relapseRatio)}
                </p>
              ))}
              <p>
                候補対照差{pct(g.difference)} ／ 探索的区間
                {g.interval
                  ? `${pct(g.interval[0])}〜${pct(g.interval[1])}`
                  : "未推定"}
              </p>
              {Object.entries(g.bands).map(([band, m]) => (
                <div className="lab-band" key={band}>
                  <span>
                    {band}点・{m.evaluated}件
                  </span>
                  <meter min={-1} max={1} value={m.meanReturn ?? 0} />
                  <span>{pct(m.meanReturn)}</span>
                </div>
              ))}
            </section>
          ))}
        </details>
      ))}
      <h3>かぶまるの説明</h3>
      {r.statements.map((s, i) => (
        <p key={i}>
          {s.text}
          <a href="#lab-evidence">根拠</a>
        </p>
      ))}
      <details>
        <summary>不確実性・過学習・次の確認条件</summary>
        {r.notes.map((n, i) => (
          <p key={i}>{n}</p>
        ))}
        <p>
          次は別期間・別相場局面、業種・規模の偏り、十分な独立時点で確認してください。本番への自動反映はありません。
        </p>
      </details>
      <details id="lab-evidence">
        <summary>Evidenceと再現情報</summary>
        <p>Evidence ID {r.evidenceId}</p>
        <p>入力hash {r.inputHash}</p>
        <p>Report ID {r.reportId}</p>
        <p>Plan ID {r.planId}</p>
      </details>
    </article>
  );
}
