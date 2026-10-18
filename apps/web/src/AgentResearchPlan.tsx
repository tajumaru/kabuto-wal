import type { AgentPlan } from "../../../packages/core/kabumaru-agent-schema";
export function AgentResearchPlan({ plan: p }: { plan: AgentPlan }) {
  return (
    <section className="card">
      <h2>研究計画と実行予算</h2>
      <p>目的：{p.objective}</p>
      <p>仮説：{p.hypothesis}</p>
      <p>
        データ締切 {p.cutoff} ／ {p.cohortIds.length}コホート ／{" "}
        {p.methodIds.length}方式 ／ {p.foldPlanIds.length}fold
      </p>
      <dl>
        <dt>実験上限</dt>
        <dd>{p.budget.maxExperiments}回</dd>
        <dt>コホート上限</dt>
        <dd>{p.budget.maxCohorts}件</dd>
        <dt>実行時間上限</dt>
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
