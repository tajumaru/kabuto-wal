import { dejavuEvaluationListSchema, dejavuExplanationSchema, dejavuForecastResponseSchema, dejavuSaveResponseSchema, evaluationResponseSchema } from "../../../packages/core/dejavu-api-schema";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Area,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { KabumaruPortrait } from "./Kabumaru";
import type { z } from "zod";
import { dejavuResultSchema } from "../../../packages/core/dejavu-api-schema";

type Result = z.infer<typeof dejavuResultSchema>;
type Request = (url: string, body?: unknown) => Promise<unknown>;
const pct = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n)
    ? `${(n * 100).toFixed(2)}%`
    : "—";
export function DejavuResearch({
  data,
  code,
  date,
  compare,
  request,
  memories,
}: {
  data: Result;
  code: string;
  date: string;
  compare: string;
  request: Request;
  memories: React.ReactNode;
}) {
  const [horizon, setHorizon] = useState<1 | 5 | 20>(5),
    [example, setExample] = useState(0);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const client = useQueryClient();
  const params = `code=${code}${date ? `&asOf=${date}` : ""}${compare ? `&compareCode=${compare}` : ""}`;
  const explanation = useQuery({
    queryKey: ["dejavu-explanation", data.recordId],
    queryFn: async () => dejavuExplanationSchema.parse(await request(`/dejavu/explanation?${params}`)),
  });
  const journal = useQuery({
    queryKey: ["dejavu-journal", params],
    queryFn: async () => dejavuEvaluationListSchema.parse(await request(`/dejavu/evaluations?${params}`)),
  });
  const s = data.consensus.horizons[horizon];
  const d = data.dna[Math.min(example, data.dna.length - 1)];
  const pose = explanation.isFetching
    ? "thinking"
    : s.consensusScore !== null && s.consensusScore < 0
      ? "warning"
      : s.consensusScore !== null && s.consensusScore > 0
        ? "happy"
        : data.examples.length
          ? "discover"
          : "analyze";
  async function act(action: "forecast" | "evaluate" | "save") {
    setBusy(true);
    setMessage("");
    try {
      if (action === "forecast") {
        const r = dejavuForecastResponseSchema.parse(await request("/dejavu/forecast", {
          code,
          asOf: date || undefined,
          compareCode: compare || undefined,
        }));
        setMessage(
          `1・5・20営業日の仮説を記録しました（${r.records.length}件）。同じ条件の原本は再作成しません。${r.syncError || ""}`,
        );
      } else if (action === "evaluate") {
        const result = evaluationResponseSchema.parse(await request("/evaluations", {}));
        setMessage(
          `取得済みの日足で答え合わせしました。期限前・未取得の実績は補完しません。${result.syncError || ""}`,
        );
      } else {
        const r = dejavuSaveResponseSchema.parse(await request("/dejavu/save", {
          code,
          asOf: date || undefined,
          compareCode: compare || undefined,
        }));
        setMessage(
          r.sync.status === "synced"
            ? "MemWal保存完了（blob確認済み）"
            : data.mode === "demo"
              ? "デモの記憶をローカル保存しました。外部送信しません。"
              : `ローカル保存済み。同期状態：${r.sync.status}。${r.error || ""}`,
        );
      }
      await Promise.all([
        ...(action !== "save" ? [client.invalidateQueries({ queryKey: ["dejavu-journal", params] })] : []),
        ...(action === "evaluate" ? [client.invalidateQueries({ queryKey: ["dejavu-explanation", data.recordId] })] : []),
        ...(action !== "evaluate" ? [client.invalidateQueries({ queryKey: ["dejavu-memories", code, date] })] : []),
        client.invalidateQueries({ queryKey: ["kabumaru-feed"] }),
      ]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "通信に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  const chart = Array.from({ length: 40 }, (_, i) => ({
    day: i - 19,
    current: i < 20 ? data.query.shape[i] : null,
    ...Object.fromEntries(
      data.examples.map((e, n) => [
        `case${n}`,
        i < 20 ? e.shape[i] : e.futureShape[i - 20],
      ]),
    ),
  }));
  return (
    <div className="dejavu-research">
      <section className="card dejavu-scenario">
        <div className="dejavu-section-head">
          <div>
            <span className="badge">
              {data.mode === "demo"
                ? "DEMO · 架空OHLCV"
                : "実データ · J-Quants取得日足"}
            </span>
            <h2>デジャヴ未来シナリオ</h2>
          </div>
          <div className="dejavu-tabs" role="group" aria-label="集計期間">
            {([1, 5, 20] as const).map((h) => (
              <button
                key={h}
                aria-pressed={horizon === h}
                onClick={() => setHorizon(h)}
              >
                {h}営業日
              </button>
            ))}
          </div>
        </div>
        <div className="dejavu-metrics">
          <div>
            <small>騰落率中央値</small>
            <strong>{pct(s.medianReturn)}</strong>
          </div>
          <div>
            <small>Consensus Score</small>
            <strong>{s.consensusScore?.toFixed(3) ?? "—"}</strong>
          </div>
          <div>
            <small>有効サンプル</small>
            <strong>{s.sampleCount}件</strong>
            <span>{s.reliability}</span>
          </div>
          <div>
            <small>上昇割合</small>
            <strong>{pct(s.upRatio)}</strong>
            <span>
              上昇{s.up} / 下落{s.down} / 横ばい{s.flat}
            </span>
          </div>
        </div>
        <div className="dejavu-scenarios">
          <p className="scenario-bearish">
            弱気側（25分位）<strong>{pct(s.percentileRange?.[0])}</strong>
          </p>
          <p className="scenario-bullish">
            強気側（75分位）<strong>{pct(s.percentileRange?.[1])}</strong>
          </p>
        </div>
        <p className="muted">
          過去の経験分布です。Scoreは−1〜+1の方向の偏りで、将来の上昇確率ではありません。四分位の範囲も保証された予測区間ではありません。
        </p>
        <details>
          <summary>計算根拠と統計</summary>
          <p>{data.consensus.selection}</p>
          {data.statistics && <div>
            <h3>事例数による統計の変動（{horizon}営業日後）</h3>
            <p>上昇割合は過去事例の割合です。校正済み上昇確率ではありません。予測記録は従来の上位5件・v1を使用します。</p>
            <table><thead><tr><th>上限</th><th>有効件数</th><th>上昇割合</th><th>中央値</th></tr></thead><tbody>
              {data.statistics.comparisons.map((comparison) => {
                const stats = comparison.horizons[horizon];
                return <tr key={comparison.requestedCount}><td>{comparison.requestedCount}件</td><td>{stats.sampleCount}件{stats.sampleCount < comparison.requestedCount ? "（候補不足）" : ""}</td><td>{pct(stats.upRatio)}</td><td>{pct(stats.medianReturn)}</td></tr>;
              })}
            </tbody></table>
            <small>{data.statistics.methodVersion}</small>
          </div>}
          <p>
            走査候補 {data.candidateCount}件 / 重複除外後 {data.sampleCount}件 /
            表示・集計対象 {data.consensus.exampleIds.length}件
          </p>
          <p>
            平均 {pct(s.meanReturn)} / 最小 {pct(s.minReturn)} / 最大{" "}
            {pct(s.maxReturn)} / 類似度加重平均 {pct(s.weightedReturn)}
          </p>
          <p>
            重み = max(類似度÷100, 0)^{data.consensus.weightPower}。Score =
            Σ(重み×騰落率の符号)÷Σ重み。上昇割合は正の騰落率の件数÷有効件数。ゼロは横ばい。
          </p>
          <p>
            基準日 {data.asOf} / 取得締切 {data.cutoff} / {data.featureVersion}{" "}
            / {data.consensus.methodVersion}
          </p>
        </details>
      </section>
      <section className="card dejavu-explanation">
        <KabumaruPortrait pose={pose} />
        <div>
          <h2>かぶまるの解説</h2>
          <p>
            {explanation.isFetching
              ? "過去の事例と振り返りを確認しているよ…"
              : explanation.data?.summary ||
                d?.explanation ||
                "条件を満たす事例がないため分析できません。"}
          </p>
          {s.medianReturn !== null && (
            <p>
              {horizon}営業日後の過去事例は、上昇{s.up}件・下落{s.down}
              件・横ばい{s.flat}件。中央値は{pct(s.medianReturn)}だったよ。
              {s.reliability}として見てね。
            </p>
          )}
          {!!explanation.data?.reflections.memories.length && (
            <p>
              以前の類似分析の記録が
              {explanation.data.reflections.memories.length}
              件見つかったよ。下の反省ノートで実際の結果を確認してね。
            </p>
          )}
          <p className="muted">
            {explanation.data?.caution ||
              "価格の類似だけでは、ニュース・決算・値動きの原因は特定できません。"}{" "}
            解説は数値に基づく定型文です。
          </p>
          {explanation.error && (
            <p role="alert">
              解説の取得に失敗しました。表示済み数値による解説を使用しています。
            </p>
          )}
        </div>
      </section>
      <section className="card">
        <h2>パラレル相場チャート</h2>
        <p className="muted">
          横軸0が各窓の最終日。初日100で比較。右側は過去事例の実績のみです。
        </p>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chart}
              margin={{ right: 12, left: 0, bottom: 10 }}
            >
              <XAxis dataKey="day" />
              <YAxis domain={["auto", "auto"]} width={45} />
              <Tooltip />
              <ReferenceLine x={0} stroke="#888" />
              <Legend />
              <Line
                isAnimationActive={false}
                dataKey="current"
                name="比較元"
                stroke="#1589d0"
                strokeWidth={3}
                dot={false}
              />
              {data.examples.map((e, i) => (
                <Line
                  isAnimationActive={false}
                  key={e.id}
                  dataKey={`case${i}`}
                  name={`${e.end} 過去事例`}
                  stroke={
                    ["#41b3a3", "#d7a746", "#9a86c7", "#dd8b84", "#829ca8"][i]
                  }
                  dot={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <h3>過去事例のその後：中央値と四分位帯</h3>
        <p className="muted">
          各事例の基準日を0%として揃えた騰落率。帯は25〜75分位の経験分布です。
        </p>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data.consensus.trajectory.map((t) => ({
                ...t,
                band: t.lower === null ? null : [t.lower * 100, t.upper! * 100],
                median: t.median === null ? null : t.median * 100,
              }))}
            >
              <XAxis dataKey="day" />
              <YAxis unit="%" width={50} />
              <Tooltip />
              <Legend />
              <ReferenceLine y={0} stroke="#888" />
              <Area
                isAnimationActive={false}
                dataKey="band"
                name="過去の25〜75分位（%）"
                stroke="none"
                fill="#41b3a3"
                fillOpacity={0.22}
              />
              <Line
                isAnimationActive={false}
                dataKey="median"
                name="過去の中央値（%）"
                stroke="#41b3a3"
                dot={false}
                strokeWidth={3}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section className="card">
        <h2>デジャヴDNA</h2>
        {!!data.examples.length && (
          <label>
            分析する事例{" "}
            <select
              value={Math.min(example, data.examples.length - 1)}
              onChange={(e) => setExample(Number(e.target.value))}
            >
              {data.examples.map((e, i) => (
                <option value={i} key={e.id}>
                  {e.providerCode} · {e.start}〜{e.end}
                </option>
              ))}
            </select>
          </label>
        )}
        {d ? (
          <>
            <p>
              総合類似度 {d.score.toFixed(1)}点 / 最も似る：{d.mostSimilar} /
              最も異なる：{d.mostDifferent}
            </p>
            <div className="dejavu-dna">
              {d.elements.map((e) => (
                <div key={e.key}>
                  <span>{e.label}</span>
                  <meter
                    min={0}
                    max={100}
                    value={e.similarity ?? 0}
                    aria-label={`${e.label}の視覚用類似度`}
                  />
                  <span>{e.similarity?.toFixed(1) ?? "—"}</span>
                  <small>
                    重み{(e.weight * 100).toFixed(0)}% · 距離寄与{" "}
                    {e.contribution?.toFixed(3) ?? "—"}
                  </small>
                </div>
              ))}
            </div>
            <p className="muted">
              DNAの類似度は100×exp(−要素距離)。距離寄与は重み×要素距離で、小さいほど総合距離を押し上げません。総合類似度とは異なる視覚用の値です。
            </p>
          </>
        ) : (
          <p>分析できる過去事例がありません。</p>
        )}
      </section>
      <section className="card">
        <h2>過去の類似事例</h2>
        {!data.examples.length && (
          <p role="status">
            条件を満たす過去候補がありません。履歴・欠損・取得締切を確認してください。
          </p>
        )}
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>比較期間</th>
                <th>類似度 / 内訳</th>
                <th>翌営業日</th>
                <th>5営業日後</th>
                <th>20営業日後</th>
              </tr>
            </thead>
            <tbody>
              {data.examples.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.providerCode}
                    <br />
                    {e.start}〜{e.end}
                  </td>
                  <td>{e.score.toFixed(1)} / 100</td>
                  {[1, 5, 20].map((h) => (
                    <td key={h}>{pct(e.future[h])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>仮説を残す</h2>
        <p>
          表示中の上位事例から1・5・20営業日の研究仮説を記録します。原本は固定し、後日の評価を別記録で残します。
        </p>
        <div className="toolbar">
          <button
            disabled={busy || !data.examples.length}
            onClick={() => void act("forecast")}
          >
            このデジャヴから予測を記録
          </button>
          <button
            disabled={busy || !data.examples.length}
            onClick={() => void act("save")}
          >
            このデジャヴ相場を記憶する
          </button>
        </div>
        <p role="status">{busy ? "保存・確認中…" : message}</p>
      </section>
      <section className="card">
        <h2>過去の予測と答え合わせ</h2>
        <p className="muted">
          答え合わせは現在取得済みの日足による後日の評価です。分析当時の既知情報とは区別して表示しています。
        </p>
        <button disabled={busy} onClick={() => void act("evaluate")}>
          期限後の答え合わせ
        </button>
        {journal.isFetching && <p role="status">記録を読み込み中…</p>}
        {journal.error && <p role="alert">予測記録を取得できませんでした。</p>}
        {!journal.data?.length && (
          <p>この条件のデジャヴ予測はまだありません。</p>
        )}
        <div className="dejavu-journal">
          {journal.data?.map((p) => {
            const e = p.evaluations.at(-1);
            return (
              <article key={p.predictionId}>
                <strong>
                  {p.dataAsOf} → {p.targetSessionDate}（{p.horizonSessions}
                  営業日）
                </strong>
                <p>
                  仮説中央値 {pct(p.predictedReturn)} / 実績{" "}
                  {pct(e?.actualReturn)} / 誤差 {pct(e?.returnError)}
                </p>
                <p>
                  {e
                    ? `方向${e.directionMatch ? "一致" : "不一致"} · 過去の四分位範囲${e.inRange ? "内" : "外"} · Score ${p.dejavu?.consensusScore?.toFixed(3) ?? "—"} · ${p.sampleCount}事例`
                    : p.state.status === "missing"
                      ? "期限日の実績が不足しています。取得後に再評価します。"
                      : "実績取得待ち（pending）"}
                </p>
              </article>
            );
          })}
        </div>
      </section>
      <section className="card">
        <h2>MemWal反省ノート</h2>
        <p>
          {explanation.data?.reflections.search === "memwal-semantic"
            ? "MemWal意味検索＋ローカル記録"
            : "ローカルの振り返り（MemWal未使用）"}
        </p>
        {explanation.data?.reflections.error && (
          <p>{explanation.data.reflections.error}</p>
        )}
        {explanation.data?.reflections.memories.map((m) => (
          <article className="dejavu-reflection" key={m.recordId}>
            <strong>観測事実</strong>
            <p>{m.text.split(" 解釈：")[0]}</p>
            <strong>解釈・次回の注意</strong>
            <p>{m.interpretation}</p>
          </article>
        ))}
        {!explanation.data?.reflections.memories.length && (
          <p>
            この取得締切までに作られた評価記憶はありません。今答え合わせした記憶は最新日の分析で参照できます。
          </p>
        )}
        <p className="muted">
          記憶検索結果を統計母集団やScoreには使用しません。外部同期・検索は設定された送信許可に従います。
        </p>
        {memories}
      </section>
    </div>
  );
}
