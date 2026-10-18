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
      "方式の安定性とデータ不足を保存済み研究から検証する",
    ),
    [topic, setTopic] =
      useState<z.infer<typeof agentSessionInputSchema>["topic"]>(
        "method-stability",
      ),
    [notebooks, setNotebooks] = useState(""),
    [folds, setFolds] = useState(""),
    [methods, setMethods] = useState(""),
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
    enabled: terminal,
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
    <main className="agent-page">
      <header className="card agent-header">
        <KabumaruPortrait pose="analyze" />
        <div>
          <h1>かぶまる自律研究エージェント</h1>
          <p>
            保存済みデータから計画を提案し、利用者が承認した研究だけを実行するよ。
          </p>
          <p>
            追加取得・外部送信・Sui取引の実行予算は0。本番方式は変更しません。
          </p>
          <Link to="/research/lab">AI研究所</Link> ·{" "}
          <Link to="/research/notebook">研究ノート</Link>
        </div>
      </header>
      <section className="card">
        <h2>研究テーマの提案</h2>
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
            {agentSessionInputSchema.shape.topic.unwrap().options.map((t, i) => (
              <option key={t} value={t}>
                {topics[i]}
              </option>
            ))}
          </select>
        </label>
        <button
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
          研究セッションを作成
        </button>
      </section>
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
          <section className="card">
            <h2>研究セッション</h2>
            <p>{state.original.objective}</p>
            <p role="status">
              状態：{state.status} ／ {state.checkpoint?.processed ?? 0}/
              {state.checkpoint?.total ?? state.plan?.steps.length ?? 0}ステップ
            </p>
            <p>セッション {id}</p>
            {state.checkpoint && (
              <>
                <progress
                  max={state.checkpoint.total || 1}
                  value={state.checkpoint.processed}
                />
                <p>
                  消費：実験{state.checkpoint.usage.experiments.length}回 ／{" "}
                  {Math.ceil(state.checkpoint.usage.runtimeMs / 1000)}秒 ／
                  コホート{state.checkpoint.usage.cohorts.length}件
                </p>
                {state.checkpoint.error && (
                  <p role="alert">{state.checkpoint.error}</p>
                )}
              </>
            )}
            {state.status === "draft" ||
            state.status === "awaiting-approval" ? (
              <>
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
                  研究所の実験方式ID
                  <textarea
                    value={methods}
                    onChange={(e) => setMethods(e.target.value)}
                  />
                </label>
                <p>
                  AI研究所で保存した期間計画・方式を再利用します。最終Testは全foldで同じ未開封期間を指定してください。
                </p>
                <div className="agent-budget">
                  <label>
                    実験回数上限
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={experiments}
                      onChange={(e) => setExperiments(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    コホート上限
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={cohorts}
                      onChange={(e) => setCohorts(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    実行秒数上限
                    <input
                      type="number"
                      min={1}
                      max={3600}
                      value={seconds}
                      onChange={(e) => setSeconds(Number(e.target.value))}
                    />
                  </label>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      request(`${base}/propose`, {
                        requestId: crypto.randomUUID(),
                        proposal: {
                          notebookIds: ids(notebooks),
                          foldPlanIds: ids(folds),
                          methodIds: ids(methods),
                          budget: {
                            maxExperiments: experiments,
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
                  研究計画を提案
                </button>
              </>
            ) : null}
            {state.status === "approved" && state.plan && state.approval && (
              <button
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
                承認済み研究を開始
              </button>
            )}
            {state.status === "running" && (
              <button
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
          <AgentExecutionTimeline
            key={id}
            id={id}
            request={request}
            running={state.status === "running"}
          />
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
            <>
              <AgentResearchResults
                key={id}
                report={report.data}
                request={request}
              />
              <AgentMemoryPanel
                key={`memory:${id}`}
                id={id}
                request={request}
              />
              <AgentSuiAttestation
                key={`sui:${id}`}
                id={id}
                request={request}
              />
            </>
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
          <p>研究セッションはまだありません。</p>
        ) : (
          sessions.data?.records.map((s) => (
            <p key={s.original.sessionId}>
              <Link to={`?session=${s.original.sessionId}&page=${page}`}>
                {s.original.objective}
              </Link>{" "}
              · {s.status}
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
    </main>
  );
}
