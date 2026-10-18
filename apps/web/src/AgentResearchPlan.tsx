import type { AgentPlan } from "../../../packages/core/kabumaru-agent-schema";
export function AgentResearchPlan({ plan: p }: { plan: AgentPlan }) {
  return (
    <section className="card agent-plan">
      <h2>研究計画と処理の上限</h2>
      <p>目的：{p.objective}</p>
      <p>仮説：{p.hypothesis}</p>
      <p>
        データ締切 {p.cutoff} ／ 調査データ{p.cohortIds.length}組 ／{" "}
        {p.methodIds.length}方式 ／ {p.foldPlanIds.length}検証期間
      </p>
      <p>
        調査データ1組は、同じ基準日・取得条件で固定した銘柄群です。同じ銘柄群でも基準日が違えば別の1組です。
      </p>
      <dl>
        <dt>試す回数の上限</dt>
        <dd>{p.budget.maxExperiments}回（検証期間×方式と最終確認の合計）</dd>
        <dt>調べるデータのまとまり（上限）</dt>
        <dd>
          最大{p.budget.maxCohorts}組 ／ この計画では{p.cohortIds.length}
          組を使用。銘柄数の上限ではありません。
        </dd>
        <dt>処理時間の上限</dt>
        <dd>{p.budget.maxRuntimeSeconds}秒（既存処理単位の境界で停止）</dd>
        <dt>外部API追加取得</dt>
        <dd>0回</dd>
        <dt>MemWal外部同期</dt>
        <dd>0回・別操作が必要</dd>
        <dt>Sui署名・送信</dt>
        <dd>0回</dd>
      </dl>
      <p>
        想定時間は未計測の入力では未算出です。失敗時は一時的エラーだけ上限付きで再試行でき、恒久エラーは停止します。
      </p>
      <details>
        <summary>ステップ・依存関係・固定入力</summary>
        {p.steps.map((s) => (
          <p key={s.stepId}>
            {s.stepId} · {s.tool} ／ 依存 {s.dependencies.join("、") || "なし"}{" "}
            ／ 再試行上限{s.maxAttempts} ／ 入力hash {s.inputHash}
          </p>
        ))}
        <p>Plan ID {p.planId}</p>
      </details>
      {p.warnings.map((w, i) => (
        <p key={i}>{w}</p>
      ))}
    </section>
  );
}
