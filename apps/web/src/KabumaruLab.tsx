import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  labMethodSchema,
  labMethodInputSchema,
  labStateSchema,
  labRunSchema,
  labPeriodSchema,
} from "../../../packages/core/hunter-experiment-schema";
import { labReportViewSchema } from "../../../packages/core/hunter-lab-report-schema";
import { labDefaultWeights } from "../../../packages/core/hunter-experiment-method";
import { KabumaruPortrait } from "./Kabumaru";
import { LabMethodEditor } from "./LabMethodEditor";
import { LabResearchReport } from "./LabResearchReport";
import { LabMemory } from "./LabMemory";
import "./KabumaruLab.css";
type Request = (url: string, body?: unknown) => Promise<unknown>;
const list = <T extends z.ZodType>(schema: T) =>
  z.object({ records: z.array(schema), total: z.number() });
const planView = z.object({
  planId: z.string(),
  training: labPeriodSchema,
  validation: labPeriodSchema,
  test: labPeriodSchema,
  partitions: z.record(z.string(), z.string()),
  purgeReasons: z.record(z.string(), z.string()),
});
export function KabumaruLab({ request }: { request: Request }) {
  const [params, setParams] = useSearchParams(),
    client = useQueryClient(),
    page = Math.max(1, Number(params.get("page")) || 1),
    runId = params.get("run") ?? "";
  const [name, setName] = useState("実験方式"),
    [hypothesis, setHypothesis] = useState(
      "保存済み条件の重みを変え、別期間で検証する",
    ),
    [parameters, setWeights] = useState({ ...labDefaultWeights }),
    [threshold, setThreshold] = useState(60),
    [methodId, setMethod] = useState(""),
    [planId, setPlan] = useState(""),
    [proposalId, setProposal] = useState<string>(),
    [evidenceIds, setEvidence] = useState<string[]>([]),
    [cohortIds, setCohorts] = useState(""),
    [notebookIds, setNotebooks] = useState(""),
    [confirm, setConfirm] = useState(false),
    [stage, setStage] = useState<"training" | "validation" | "test">(
      "validation",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [dates, setDates] = useState({
      training: { from: "", to: "" },
      validation: { from: "", to: "" },
      test: { from: "", to: "" },
    }),
    [embargo, setEmbargo] = useState(20),
    [cost, setCost] = useState(0),
    [slippage, setSlippage] = useState(0);
  const methods = useQuery({
    queryKey: ["lab-methods", page],
    queryFn: async () =>
      list(labMethodSchema.extend({ status: labStateSchema })).parse(
        await request(`/research/lab/methods?page=${page}`),
      ),
  });
  const plans = useQuery({
    queryKey: ["lab-plans", page],
    queryFn: async () =>
      list(planView).parse(await request(`/research/lab/plans?page=${page}`)),
  });
  const runs = useQuery({
    queryKey: ["lab-runs", page],
    queryFn: async () =>
      list(labRunSchema).parse(
        await request(`/research/lab/runs?page=${page}`),
      ),
  });
  const run = useQuery({
    queryKey: ["lab-run", runId],
    enabled: /^[a-f0-9]{64}$/.test(runId),
    queryFn: async () =>
      labRunSchema.parse(await request(`/research/lab/runs/${runId}`)),
    refetchInterval: (q) =>
      ["queued", "running"].includes(q.state.data?.status ?? "") ? 1000 : false,
  });
  const report = useQuery({
    queryKey: ["lab-report-view", runId],
    enabled: run.data?.status === "completed",
    staleTime: Infinity,
    queryFn: async () =>
      labReportViewSchema.parse(
        await request(`/research/lab/runs/${runId}/report?view=compact`),
      ),
  });
  const restored = useRef("");
  useLayoutEffect(() => {
    if (runId && !report.data && !report.error) return;
    const key = `lab-scroll:${params}`;
    if (restored.current === key) return;
    try {
      window.scrollTo(0, Number(sessionStorage.getItem(key) ?? 0));
    } catch {
      /* Optional preference. */
    }
    restored.current = key;
  }, [params, runId, report.data, report.error]);
  useEffect(() => {
    const key = `lab-scroll:${params}`,
      previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    const save = () => {
      if (restored.current !== key) return;
      try {
        sessionStorage.setItem(key, String(scrollY));
      } catch {
        /* Optional preference. */
      }
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      history.scrollRestoration = previous;
    };
  }, [params]);
  function update(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set(key, value);
      return next;
    });
  }
  async function act(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["lab-methods"] }),
        client.invalidateQueries({ queryKey: ["lab-plans"] }),
        client.invalidateQueries({ queryKey: ["lab-runs"] }),
        client.invalidateQueries({ queryKey: ["lab-run"] }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理できませんでした");
    } finally {
      setBusy(false);
    }
  }
  const ids = (s: string) => s.split(/[\s,]+/).filter(Boolean),
    method = methods.data?.records.find((m) => m.experimentId === methodId),
    plan = plans.data?.records.find((p) => p.planId === planId);
  return (
    <section className="kabumaru-lab">
      <header className="lab-heading">
        <KabumaruPortrait pose="analyze" />
        <div>
          <h1>かぶまるAI研究所</h1>
          <p>底打ちアルゴリズム実験室</p>
        </div>
      </header>
      <p>
        <Link to="/research/agent">自律研究エージェント</Link> · <Link to="/research/notebook">研究ノート</Link> ·{" "}
        <Link to="/bottom/hunter">底打ちハンター</Link>
      </p>
      <section className="card">
        <h2>現行方式</h2>
        <p>
          bottom-rule-v1 ／
          bottom-80-v1。従来の10条件・流動性・リスク判定を維持します。スコアは確率ではありません。本番切替はありません。
        </p>
      </section>
      <section className="card">
        <h2>対象データと時系列分割</h2>
        <p>
          固定コホートIDを入力してください。結果窓の境界越えとembargoを除外します。実データの追加取得は行いません。
        </p>
        <label>
          固定コホートID（空白区切り）
          <textarea
            value={cohortIds}
            onChange={(e) => setCohorts(e.target.value)}
          />
        </label>
        <div className="lab-grid">
          {(["training", "validation", "test"] as const).map((k) => (
            <fieldset key={k}>
              <legend>{k}</legend>
              {(["from", "to"] as const).map((v) => (
                <label key={v}>
                  {k} {v}
                  <input
                    type="date"
                    value={dates[k][v]}
                    onChange={(e) =>
                      setDates({
                        ...dates,
                        [k]: { ...dates[k], [v]: e.target.value },
                      })
                    }
                  />
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <label>
          Embargo営業日数
          <input
            type="number"
            min="0"
            max="60"
            value={embargo}
            onChange={(e) => setEmbargo(e.target.valueAsNumber)}
          />
        </label>
        <label>
          片道手数料bps
          <input
            type="number"
            min="0"
            max="1000"
            value={cost}
            onChange={(e) => setCost(e.target.valueAsNumber)}
          />
        </label>
        <label>
          片道スリッページbps
          <input
            type="number"
            min="0"
            max="1000"
            value={slippage}
            onChange={(e) => setSlippage(e.target.valueAsNumber)}
          />
        </label>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const p = z
                .object({ planId: z.string() })
                .parse(
                  await request("/research/lab/plans", {
                    cohortIds: ids(cohortIds),
                    ...dates,
                    embargoSessions: embargo,
                    costBps: cost,
                    slippageBps: slippage,
                  }),
                );
              setPlan(p.planId);
              setMessage("検証計画を固定しました。");
            })
          }
        >
          検証計画を固定する
        </button>
        <label>
          保存済み検証計画
          <select value={planId} onChange={(e) => setPlan(e.target.value)}>
            <option value="">選択してください</option>
            {plans.data?.records.map((p) => (
              <option key={p.planId} value={p.planId}>
                {p.training.from}〜{p.test.to} · {p.planId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {plan && (
          <p>
            割当
            {
              Object.values(plan.partitions).filter((p) => p !== "purged")
                .length
            }
            コホート ／ 除外{Object.keys(plan.purgeReasons).length}件。
            {Object.values(plan.purgeReasons).join("、")}
          </p>
        )}
      </section>
      <section className="card">
        <h2>改善仮説</h2>
        <p>
          Trainingに限定した研究ノートから決定的な提案を生成します。自由なコードは生成・実行しません。
        </p>
        <label>
          根拠ノートID（空白区切り）
          <textarea
            value={notebookIds}
            onChange={(e) => setNotebooks(e.target.value)}
          />
        </label>
        <button
          disabled={busy || !planId}
          onClick={() =>
            void act(async () => {
              const p = z
                .object({
                  proposalId: z.string(),
                  proposal: labMethodInputSchema,
                  warnings: z.array(z.string()),
                })
                .parse(
                  await request("/research/lab/hypotheses", {
                    planId,
                    notebookIds: ids(notebookIds),
                  }),
                );
              setWeights(p.proposal.parameters);
              setThreshold(p.proposal.candidateThreshold);
              setHypothesis(p.proposal.hypothesis);
              setEvidence(p.proposal.evidenceIds);
              setProposal(p.proposalId);
              setMessage(p.warnings.join(" "));
            })
          }
        >
          Trainingから仮説を生成
        </button>
      </section>
      <section className="card">
        <h2>実験方式</h2>
        <label>
          方式名
          <input
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          改善仮説
          <textarea
            maxLength={1000}
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
          />
        </label>
        <LabMethodEditor
          parameters={parameters}
          onChange={(p) => {
            setWeights(p);
            setProposal(undefined);
            setEvidence([]);
          }}
          threshold={threshold}
          onThreshold={(n) => {
            setThreshold(n);
            setProposal(undefined);
            setEvidence([]);
          }}
        />
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const m = labMethodSchema.parse(
                await request("/research/lab/methods", {
                  method: {
                    name,
                    hypothesis,
                    parameters,
                    candidateThreshold: threshold,
                    evidenceIds,
                    proposalId,
                  },
                  confirm: true,
                }),
              );
              setMethod(m.experimentId);
              setMessage("独立した実験方式を保存しました。");
            })
          }
        >
          実験方式を保存
        </button>
        <label>
          保存済み方式
          <select value={methodId} onChange={(e) => setMethod(e.target.value)}>
            <option value="">選択してください</option>
            {methods.data?.records.map((m) => (
              <option key={m.experimentId} value={m.experimentId}>
                {m.name} · {m.status} · {m.experimentId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {method && (
          <details>
            <summary>変更条件・理由・参照Evidence</summary>
            <p>{method.hypothesis}</p>
            <p>{JSON.stringify(method.parameters)}</p>
            <p>{method.evidenceIds.join("、") || "手動仮説・参照なし"}</p>
          </details>
        )}
      </section>
      <section className="card">
        <h2>実験開始・進捗</h2>
        <label>
          検証区間
          <select
            aria-label="検証区間"
            value={stage}
            onChange={(e) =>
              setStage(
                z
                  .enum(["training", "validation", "test"])
                  .parse(e.target.value),
              )
            }
          >
            <option value="training">Training（探索）</option>
            <option value="validation">Validation（選択）</option>
            <option value="test">最終Test（開封履歴を記録）</option>
          </select>
        </label>
        <label className="lab-confirm">
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          設定・分割・過学習の注意を確認し、実験を開始します
        </label>
        <button
          disabled={busy || !confirm || !methodId || !planId}
          onClick={() =>
            void act(async () => {
              if (method?.status === "draft")
                await request(`/research/lab/methods/${methodId}/state`, {
                  status: "testing",
                  reason: "設定・分割を確認して開始",
                  confirm: true,
                });
              const j = labRunSchema.parse(
                await request("/research/lab/runs", {
                  experimentId: methodId,
                  planId,
                  stage,
                  confirm: true,
                }),
              );
              update("run", j.runId);
            })
          }
        >
          確認した設定で実験開始
        </button>
        <button
          disabled={busy || !methodId || !planId || !confirm}
          onClick={() =>
            void act(async () => {
              await request(`/research/lab/plans/${planId}/select`, {
                experimentId: methodId,
                confirm: true,
              });
              setMessage(
                "最終Testの方式を固定しました。選択は変更できません。",
              );
            })
          }
        >
          Validation後にTest方式を固定
        </button>
        {run.data && (
          <div aria-live="polite">
            <p>
              状態：{run.data.status} ／ 完了{run.data.processed}/
              {run.data.total}コホート ／ 計算失敗{run.data.failed}
            </p>
            <p>{run.data.error}</p>
            <progress
              value={run.data.processed}
              max={Math.max(1, run.data.total)}
            />
            {(["pause", "cancel", "resume"] as const).map((action) => (
              <button
                key={action}
                disabled={busy || run.data.status === "completed"}
                onClick={() =>
                  void act(async () => {
                    await request(`/research/lab/runs/${runId}/control`, {
                      action,
                    });
                  })
                }
              >
                {action === "pause"
                  ? "中断"
                  : action === "cancel"
                    ? "キャンセル"
                    : "再開"}
              </button>
            ))}
          </div>
        )}
      </section>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {(methods.error ||
        plans.error ||
        runs.error ||
        run.error ||
        report.error) && (
        <p role="alert">
          研究データを確認できません。
          {
            (
              methods.error ??
              plans.error ??
              runs.error ??
              run.error ??
              report.error
            )?.message
          }
        </p>
      )}
      {report.isFetching && <p role="status">比較レポートを照合中…</p>}
      {report.data && report.data.runId === runId && (
        <>
          <LabResearchReport report={report.data} />
          <LabMemory key={runId} id={runId} request={request} />
        </>
      )}
      <section className="card">
        <h2>採用候補の記録</h2>
        <p>
          良い結果でも自動採用しません。validatedには十分なValidationが必要です。本番切替はありません。
        </p>
        {(["validated", "proposed-for-adoption", "rejected"] as const).map(
          (status) => (
            <button
              key={status}
              disabled={busy || !methodId || !confirm}
              onClick={() =>
                void act(async () => {
                  await request(`/research/lab/methods/${methodId}/state`, {
                    status,
                    reason: "利用者の明示判断。詳細は実験原本を参照",
                    confirm: true,
                  });
                  setMessage(`状態を${status}として追記しました。`);
                })
              }
            >
              {status}
            </button>
          ),
        )}
      </section>
      <section className="card">
        <h2>実験履歴</h2>
        {runs.isLoading && <p role="status">履歴を読み込み中…</p>}
        {runs.data?.records.length === 0 && <p>実験記録はありません。</p>}
        {runs.data?.records.map((j) => (
          <p key={j.runId}>
            <Link to={`?run=${j.runId}&page=${page}`}>
              {j.stage} · {j.status} · {j.runId.slice(0, 12)}
            </Link>
          </p>
        ))}
        <button
          disabled={page <= 1}
          onClick={() => update("page", String(page - 1))}
        >
          前のページ
        </button>
        <span>{page}ページ</span>
        <button
          disabled={
            page * 20 >=
            Math.max(
              methods.data?.total ?? 0,
              plans.data?.total ?? 0,
              runs.data?.total ?? 0,
            )
          }
          onClick={() => update("page", String(page + 1))}
        >
          次のページ
        </button>
      </section>
    </section>
  );
}
