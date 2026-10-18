import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  agentSessionSchema,
  agentStatusSchema,
  agentPlanSchema,
  agentApprovalSchema,
  agentCheckpointSchema,
  agentSessionInputSchema,
} from "../../../packages/core/kabumaru-agent-schema";
import { agentResearchReportSchema } from "../../../packages/core/kabumaru-agent-report-schema";
import { KabumaruPortrait } from "./Kabumaru";
import { AgentResearchPlan } from "./AgentResearchPlan";
import { AgentApprovalPanel } from "./AgentApprovalPanel";
import { AgentExecutionTimeline } from "./AgentExecutionTimeline";
import { AgentResearchResults } from "./AgentResearchResults";
import { AgentMemoryPanel } from "./AgentMemoryPanel";
import { AgentSuiAttestation } from "./AgentSuiAttestation";
import { AgentWorkflowGuide, agentStatusLabels } from "./AgentWorkflowGuide";
import { AgentSavedInputs } from "./AgentSavedInputs";
import "./KabumaruAgent.css";
type Request = (url: string, body?: unknown) => Promise<unknown>;
const viewSchema = z.object({
  original: agentSessionSchema,
  status: agentStatusSchema,
  plan: agentPlanSchema.nullable(),
  approval: agentApprovalSchema.nullable(),
  checkpoint: agentCheckpointSchema.nullable(),
});
const topics = [
  "高スコアで再下落した特徴",
  "出来高回復の効果",
  "RSI回復条件",
  "デジャヴ類似度",
  "候補と非候補",
  "相場局面の違い",
  "方式の安定性",
  "データ不足",
];
const ids = (s: string) => s.split(/[\s,]+/).filter(Boolean);
export function KabumaruAgent({ request }: { request: Request }) {
  const [params, setParams] = useSearchParams(),
    client = useQueryClient(),
    id = params.get("session") ?? "",
    page = Math.max(1, Number(params.get("page")) || 1);
  const [objective, setObjective] = useState(
      "今までの研究を読み返し、分かっていることと、まだ分からないことを整理する",
    ),
    [topic, setTopic] =
      useState<z.infer<typeof agentSessionInputSchema>["topic"]>(
        "method-stability",
      ),
    [notebooks, setNotebooks] = useState(""),
    [folds, setFolds] = useState(""),
    [methods, setMethods] = useState(""),
    [advanced, setAdvanced] = useState(false),
    [experiments, setExperiments] = useState(11),
    [cohorts, setCohorts] = useState(100),
    [seconds, setSeconds] = useState(300),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sessions = useQuery({
    queryKey: ["agent-sessions", page],
    queryFn: async () =>
      z
        .object({
          records: z.array(
            z.object({
              original: agentSessionSchema,
              status: agentStatusSchema,
            }),
          ),
          total: z.number(),
        })
        .parse(await request(`/research/agent/sessions?page=${page}`)),
  });
  const session = useQuery({
    queryKey: ["agent-session", id],
    enabled: /^[a-f0-9]{64}$/.test(id),
    queryFn: async () =>
      viewSchema.parse(await request(`/research/agent/sessions/${id}`)),
    refetchInterval: (q) =>
      q.state.data &&
      (q.state.data.status === "running" ||
        q.state.data.status === "approved" ||
        q.state.data.checkpoint?.lease)
        ? 1500
        : false,
  });
  const state = session.data,
    terminal =
      !!state && ["completed", "failed", "cancelled"].includes(state.status);
  const report = useQuery({
    queryKey: ["agent-report", id],
    enabled: terminal && !!state?.approval,
    queryFn: async () =>
      agentResearchReportSchema.parse(
        await request(`/research/agent/sessions/${id}/report`),
      ),
    retry: false,
  });
  useEffect(() => {
    const key = `agent-scroll:${id}`,
      restore = () => {
        const value = Number(sessionStorage.getItem(key));
        if (Number.isFinite(value)) window.scrollTo(0, value);
      };
    const frame = requestAnimationFrame(restore);
    const save = () => sessionStorage.setItem(key, String(window.scrollY));
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", save);
    };
  }, [id, !!state, !!report.data]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await client.invalidateQueries({ queryKey: ["agent-session", id] });
      await client.invalidateQueries({ queryKey: ["agent-sessions"] });
      await client.invalidateQueries({ queryKey: ["agent-timeline", id] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作できませんでした");
    } finally {
      setBusy(false);
    }
  }
  const base = `/research/agent/sessions/${id}`;
  return (
    <div className="agent-page">
      <section
        className="card agent-header"
        aria-label="研究エージェントの紹介"
      >
        <KabumaruPortrait pose="analyze" />
        <div>
          <h1>かぶまる自律研究エージェント</h1>
          <p>
            保存した研究を調べ、あなたが確認した計画に沿って、比較と振り返りを進めるよ。
          </p>
          <details>
            <summary>かぶまるが自動で進めること</summary>
            <p>
              あなたが内容を確認して開始すると、計画に沿って比較・結果の確認・記録を進めます。条件を勝手に変えて研究を繰り返すことはありません。株の売買・送金・データの外部送信は行いません。
            </p>
          </details>
          <Link to="/research/lab">AI研究所</Link> ·{" "}
          <Link to="/research/notebook">研究ノート</Link>
        </div>
      </section>
      <AgentWorkflowGuide status={state?.status} />
      {!id && (
        <section className="card">
          <h2>1. 何を調べたいですか？</h2>
          <p>
            目的とテーマを選びます。初めてなら入力済みの内容のままで試せます。
          </p>
          <label>
            研究目的
            <textarea
              value={objective}
              maxLength={1000}
              onChange={(e) => setObjective(e.target.value)}
            />
          </label>
          <label>
            研究テーマ
            <select
              value={topic}
              onChange={(e) =>
                setTopic(
                  agentSessionInputSchema.shape.topic.parse(e.target.value),
                )
              }
            >
              {agentSessionInputSchema.shape.topic
                .unwrap()
                .options.map((t, i) => (
                  <option key={t} value={t}>
                    {topics[i]}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="agent-primary"
            disabled={busy || !objective.trim()}
            onClick={() =>
              void act(async () => {
                const r = agentSessionSchema.parse(
                  await request("/research/agent/sessions", {
                    objective,
                    topic,
                    requestId: crypto.randomUUID(),
                  }),
                );
                setParams({ session: r.sessionId });
              })
            }
          >
            このテーマで研究を作る
          </button>
        </section>
      )}
      {id && (
        <button
          className="agent-secondary"
          onClick={() => {
            setParams({});
            setAdvanced(false);
            setFolds("");
            setMethods("");
            setNotebooks("");
            setError("");
          }}
        >
          新しい研究を作る
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {id && !/^[a-f0-9]{64}$/.test(id) && (
        <p role="alert">セッションIDが不正です。</p>
      )}
      {session.isFetching && !state && <p role="status">研究を読み込み中…</p>}
      {session.error && (
        <p role="alert">
          研究を読み込めません。URLとアクセス権を確認してください。
          <button onClick={() => void session.refetch()}>再読込</button>
        </p>
      )}
      {state && (
        <>
          <section className="card" id="agent-session">
            <h2>今回の研究</h2>
            <p>{state.original.objective}</p>
            <p role="status">
              状態：{agentStatusLabels[state.status]} ／{" "}
              {state.checkpoint?.processed ?? 0}/
              {state.checkpoint?.total ?? state.plan?.steps.length ?? 0}ステップ
            </p>
            <details>
              <summary>研究の識別ID</summary>
              <p>{id}</p>
            </details>
            {state.checkpoint && (
              <>
                <progress
                  max={state.checkpoint.total || 1}
                  value={state.checkpoint.processed}
                />
                <p>
                  消費：実験{state.checkpoint.usage.experiments.length}回 ／{" "}
                  {Math.ceil(state.checkpoint.usage.runtimeMs / 1000)}秒 ／
                  調査データ{state.checkpoint.usage.cohorts.length}組
                </p>
                {state.checkpoint.error && (
                  <p role="alert">{state.checkpoint.error}</p>
                )}
              </>
            )}
            {state.status === "draft" ? (
              <>
                <h3>2. 研究の進め方を選ぶ</h3>
                <fieldset className="agent-mode">
                  <legend>
                    最初は「保存した研究を読み返す」がおすすめです
                  </legend>
                  <label>
                    <input
                      type="radio"
                      name="agent-mode"
                      checked={!advanced}
                      onChange={() => setAdvanced(false)}
                    />
                    <span>
                      <strong>保存した研究を読み返す</strong>
                      <small>
                        ID入力は不要。既存の研究記録と不足情報を調べます。方式比較の実験は行いません。
                      </small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="agent-mode"
                      checked={advanced}
                      onChange={() => setAdvanced(true)}
                    />
                    <span>
                      <strong>別の時期でも成績がよいか比べる</strong>
                      <small>
                        AI研究所で保存した判定ルールと2〜5個の期間計画が必要です。
                      </small>
                    </span>
                  </label>
                </fieldset>
                {!advanced && (
                  <p className="agent-next">
                    この確認では実験回数は0回です。比較用の期間を指定しないため、仮説評価は「データ不足」になります。操作の失敗ではありません。
                  </p>
                )}
                {advanced && (
                  <div className="agent-advanced">
                    <h3>先にAI研究所で準備してください</h3>
                    <p>
                      比較する判定ルールを保存し、検証期間をずらした2〜5個の期間計画を作成します。各計画の最終Testは共通の未使用期間にしてください。保存した設定は下の一覧から選べます。
                    </p>
                    <Link to="/research/lab">
                      AI研究所で方式・期間計画を準備する →
                    </Link>
                    <AgentSavedInputs
                      request={request}
                      folds={folds}
                      methods={methods}
                      onFolds={setFolds}
                      onMethods={setMethods}
                    />
                    <details>
                      <summary>
                        IDを直接入力する・研究ノートを指定する（任意）
                      </summary>
                      <label>
                        研究ノートID（省略時はcutoff内の既存記録）
                        <textarea
                          value={notebooks}
                          onChange={(e) => setNotebooks(e.target.value)}
                        />
                      </label>
                      <label>
                        時系列順のfold計画ID（2〜5件。省略時は記録調査のみ）
                        <textarea
                          value={folds}
                          onChange={(e) => setFolds(e.target.value)}
                        />
                      </label>
                      <label>
                        研究所の判定ルールID
                        <textarea
                          value={methods}
                          onChange={(e) => setMethods(e.target.value)}
                        />
                      </label>
                      <p>
                        AI研究所で保存した期間計画・方式を再利用します。最終Testは全foldで同じ未開封期間を指定してください。
                      </p>
                    </details>
                  </div>
                )}
                <details>
                  <summary>処理の上限を変更する（通常は変更不要）</summary>
                  <p>
                    処理が増えすぎないための設定です。銘柄数や料金の設定ではありません。初めての場合は変更せず進めてください。
                  </p>
                  <div className="agent-budget">
                    <label>
                      実験回数上限
                      <input
                        type="number"
                        min={0}
                        max={30}
                        value={advanced ? experiments : 0}
                        disabled={!advanced}
                        onChange={(e) => setExperiments(Number(e.target.value))}
                      />
                      <small>
                        判定ルールを時期ごとに試す回数です。2つの時期で1つのルールを試し、最後の確認を1回行うなら最大3回です。記録を読み返すだけなら0回です。
                      </small>
                    </label>
                    <label>
                      調べるデータのまとまり（上限）
                      <input
                        aria-label="調べるデータのまとまり（上限）"
                        aria-describedby="agent-dataset-help"
                        type="number"
                        min={0}
                        max={100}
                        value={cohorts}
                        onChange={(e) => setCohorts(Number(e.target.value))}
                      />
                      <small id="agent-dataset-help">
                        同じ基準日・取得条件で固定した銘柄群を1組と数えます。同じ銘柄群でも基準日が違えば別の組です。100は銘柄数ではありません。
                      </small>
                    </label>
                    <label>
                      処理時間の上限（秒）
                      <input
                        type="number"
                        min={1}
                        max={3600}
                        value={seconds}
                        onChange={(e) => setSeconds(Number(e.target.value))}
                      />
                      <small>
                        300秒は5分です。中断・再開しても使用時間は累積し、上限に達したら処理の区切りで停止します。
                      </small>
                    </label>
                  </div>
                </details>
                {advanced &&
                  (ids(folds).length < 2 || !ids(methods).length) && (
                    <p>
                      期間計画を2件以上、判定ルールを1件以上選ぶと計画を作成できます。
                    </p>
                  )}
                <button
                  className="agent-primary"
                  disabled={
                    busy ||
                    (advanced &&
                      (ids(folds).length < 2 || !ids(methods).length))
                  }
                  onClick={() =>
                    void act(() =>
                      request(`${base}/propose`, {
                        requestId: crypto.randomUUID(),
                        proposal: {
                          notebookIds: advanced ? ids(notebooks) : [],
                          foldPlanIds: advanced ? ids(folds) : [],
                          methodIds: advanced ? ids(methods) : [],
                          budget: {
                            maxExperiments: advanced ? experiments : 0,
                            maxCohorts: cohorts,
                            maxRuntimeSeconds: seconds,
                            maxJQuantsRequests: 0,
                            maxExternalWrites: 0,
                            maxSuiTransactions: 0,
                          },
                        },
                      }),
                    )
                  }
                >
                  この内容で計画を作る
                </button>
              </>
            ) : null}
            {state.status === "approved" && state.plan && state.approval && (
              <button
                className="agent-primary"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    request(`${base}/start`, {
                      planId: state.plan!.planId,
                      approvalId: state.approval!.approvalId,
                    }),
                  )
                }
              >
                この計画で研究を始める
              </button>
            )}
            {state.status === "running" && (
              <button
                className="agent-secondary"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    request(`${base}/control`, { action: "pause" }),
                  )
                }
              >
                研究を一時停止
              </button>
            )}
            {state.status === "paused" && (
              <button
                className="agent-primary"
                disabled={busy || !!state.checkpoint?.lease}
                onClick={() =>
                  void act(() =>
                    request(`${base}/control`, { action: "resume" }),
                  )
                }
              >
                研究を再開
              </button>
            )}
            {!["completed", "failed", "cancelled"].includes(state.status) && (
              <button
                className="agent-danger"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    request(`${base}/control`, { action: "cancel" }),
                  )
                }
              >
                研究をキャンセル
              </button>
            )}
            <p>
              画面を閉じても開始済みの研究はサーバーで継続します。再訪時はこのセッションを選択してください。
            </p>
          </section>
          <div id="agent-approval">
            {state.plan && <AgentResearchPlan plan={state.plan} />}{" "}
            {state.plan && state.status === "awaiting-approval" && (
              <AgentApprovalPanel
                key={state.plan.planId}
                plan={state.plan}
                disabled={busy}
                onApprove={async (body) => {
                  await act(async () => {
                    await request(`${base}/approve`, body);
                  });
                }}
              />
            )}
          </div>
          <details>
            <summary>詳しい実行履歴を開く</summary>
            <AgentExecutionTimeline
              key={id}
              id={id}
              request={request}
              running={state.status === "running"}
            />
          </details>
          {report.isFetching && (
            <p role="status">実験原本とEvidenceを照合中…</p>
          )}
          {report.error && (
            <p role="alert">
              研究結果を検証できません。
              <button onClick={() => void report.refetch()}>
                結果を再確認
              </button>
            </p>
          )}
          {report.data && (
            <div id="agent-results">
              <AgentResearchResults
                key={id}
                report={report.data}
                request={request}
              />
              <details>
                <summary>研究記憶の保存・MemWal同期（任意）</summary>
                <AgentMemoryPanel
                  key={`memory:${id}`}
                  id={id}
                  request={request}
                />
              </details>
              <details>
                <summary>研究証跡のhashを確認する（任意）</summary>
                <AgentSuiAttestation
                  key={`sui:${id}`}
                  id={id}
                  request={request}
                />
              </details>
            </div>
          )}
        </>
      )}
      <section className="card">
        <h2>保存済み研究</h2>
        {sessions.isPending ? (
          <p role="status">一覧を読み込み中…</p>
        ) : sessions.error ? (
          <p role="alert">一覧を読み込めません。</p>
        ) : sessions.data?.records.length === 0 ? (
          <p>今回の研究はまだありません。</p>
        ) : (
          sessions.data?.records.map((s) => (
            <p key={s.original.sessionId}>
              <Link to={`?session=${s.original.sessionId}&page=${page}`}>
                {s.original.objective}
              </Link>{" "}
              · {agentStatusLabels[s.status]}
            </p>
          ))
        )}
        <button
          disabled={page <= 1}
          onClick={() =>
            setParams({
              ...(id ? { session: id } : {}),
              page: String(page - 1),
            })
          }
        >
          前の研究
        </button>
        <button
          disabled={page * 20 >= (sessions.data?.total ?? 0)}
          onClick={() =>
            setParams({
              ...(id ? { session: id } : {}),
              page: String(page + 1),
            })
          }
        >
          次の研究
        </button>
      </section>
    </div>
  );
}
