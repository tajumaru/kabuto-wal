import type { AgentStatus } from "../../../packages/core/kabumaru-agent-schema";
export const agentStatusLabels: Record<AgentStatus, string> = {
  draft: "計画を作る前",
  "awaiting-approval": "内容の確認待ち",
  approved: "開始待ち",
  running: "研究を実行中",
  paused: "一時停止中",
  completed: "完了",
  failed: "エラーで停止",
  cancelled: "キャンセル済み",
};
const guidance: Record<
  AgentStatus,
  { text: string; target?: string; link?: string }
> = {
  draft: {
    text: "下の「研究の進め方」を選び、「この内容で計画を作る」を押してください。まだ実行は始まりません。",
    target: "agent-session",
    link: "計画を作る欄へ",
  },
  "awaiting-approval": {
    text: "計画の目的・使用データ・上限を確認し、承認欄のチェックを入れてください。承認後も、開始ボタンを押すまで実行しません。",
    target: "agent-approval",
    link: "計画と承認欄へ",
  },
  approved: {
    text: "確認した計画を実行できます。「この計画で研究を始める」を押してください。",
    target: "agent-session",
    link: "開始ボタンへ",
  },
  running: {
    text: "ここからは計画内の処理を自動で進めます。操作せず待てます。一時停止・キャンセルは下の欄から行えます。",
  },
  paused: {
    text: "停止理由を確認してください。処理が完全に止まったら「研究を再開」を押すと続きから進みます。それまでに使った時間や回数は引き継ぎます。",
    target: "agent-session",
    link: "停止理由と再開操作へ",
  },
  completed: {
    text: "下の「研究結果と振り返り」を確認してください。「データ不足」は、方式の良し悪しを判断する材料が足りないという意味です。",
    target: "agent-results",
    link: "結果を見る",
  },
  failed: {
    text: "下のエラー内容を確認してください。この研究は停止しています。条件を変更して試す場合は、新しい研究を作成してください。",
    target: "agent-session",
    link: "エラーを見る",
  },
  cancelled: {
    text: "この研究はキャンセル済みです。「新しい研究を作る」から別の研究を始められます。",
  },
};
export function AgentWorkflowGuide({ status }: { status?: AgentStatus }) {
  const active = !status
    ? 0
    : status === "draft"
      ? 1
      : status === "awaiting-approval"
        ? 2
        : ["approved", "running", "paused"].includes(status)
          ? 3
          : 4;
  const next = status
    ? guidance[status]
    : {
        text: "初めてなら、下の目的とテーマはそのままで「このテーマで研究を作る」を押してください。保存した研究を読み返すから試せます。",
      };
  return (
    <section className="card agent-guide" aria-label="操作ガイド">
      <h2>使い方と次の操作</h2>
      <ol className="agent-steps">
        {[
          "研究を作る",
          "計画を作る",
          "内容を承認",
          "研究を開始",
          "結果を見る",
        ].map((s, i) => (
          <li key={s} aria-current={i === active ? "step" : undefined}>
            <span>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <p className="agent-next">
        <strong>次にすること：</strong>
        {next.text}
      </p>
      {"target" in next && next.target && (
        <a href={`#${next.target}`}>
          {"link" in next ? next.link : "次の操作へ"} ↓
        </a>
      )}
    </section>
  );
}
