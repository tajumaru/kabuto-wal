import { useState } from "react";
import type { AgentPlan } from "../../../packages/core/kabumaru-agent-schema";
import { browserAgentHash } from "../../../packages/core/kabumaru-agent-canonical";
import { agentToolPermissions } from "../../../packages/core/kabumaru-agent-policy";
export function AgentApprovalPanel({
  plan,
  onApprove,
  disabled,
}: {
  plan: AgentPlan;
  onApprove: (body: unknown) => Promise<void>;
  disabled: boolean;
}) {
  const [confirm, setConfirm] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="card agent-approval-panel">
      <h2>利用者の承認</h2>
      <label className="agent-check">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(e) => setConfirm(e.target.checked)}
        />
        目的・固定データ・回数・時間上限・失敗時の処理を確認し、表示した計画だけを承認します
      </label>
      <p>承認しても外部送信・署名・本番採点変更の権限は付与されません。</p>
      <button
        className="agent-primary"
        disabled={disabled || !confirm}
        onClick={() => {
          void (async () => {
            try {
              setError("");
              const planHash = await browserAgentHash(plan);
              await onApprove({
                planId: plan.planId,
                planHash,
                confirm: true,
                allowedTools: [...new Set(plan.steps.map((s) => s.tool))],
                permissions: [
                  ...new Set(
                    plan.steps.map((s) => agentToolPermissions[s.tool]),
                  ),
                ],
                budget: plan.budget,
                failurePolicy: "pause-transient-stop-permanent-v1",
              });
            } catch (e) {
              setError(e instanceof Error ? e.message : "承認できませんでした");
            }
          })();
        }}
      >
        内容を確認して承認する
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
