import { useResearchParams } from "./research-params";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import { StockPicker } from "./StockPicker";
import type { BottomAnalysis } from "../../../packages/core/bottom-schema";

const messages: Record<string, string> = {
  low_liquidity: "20営業日の平均売買代金が1億円未満です。",
  volume_history_empty:
    "前20営業日の出来高がゼロで、採点に必要な倍率を計算できません。",
  no_prices: "日足がありません。ホームで監視に追加し、日足を取得してください。",
  asof_not_observed: "基準日の価格は、その日時点の取得記録にありません。",
  insufficient_history: "連続80営業日の履歴が必要です。",
  missing_sessions: "取引カレンダーに対応する日足が不足しています。",
  inconsistent_adjustment_series:
    "日足の調整系列が揃っていません。全期間を同じ系列で取得してください。",
  invalid_ohlcv: "価格・出来高に欠損または不正値があります。",
  liquidity_unknown: "売買代金による流動性は未確認です。",
  topix_unknown: "TOPIXとの比較は未実装です。",
  news_earnings_unchecked: "ニュース・決算は確認していません。",
  stale_data: "最新の必要営業日まで日足が揃っていません。",
  delayed_data: "Freeプランの遅延データです。",
  long_trend_down: "60日平均は下降中で、終値も下回っています。",
  new_low: "直前5営業日の安値を更新しています。",
  high_volatility: "ATRが終値の8%を超えています。",
  far_from_support: "20日安値から10%以上離れています。",
  no_trading_volume: "最新日の出来高がゼロです。",
  volume_ratio_unknown: "前20日の出来高平均がゼロで、倍率を計算できません。",
};
const number = (v: number | null | undefined, percent = false) =>
  v == null
    ? "—"
    : `${(percent ? v * 100 : v).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}${percent ? "%" : ""}`;
export function BottomResearch({
  request,
}: {
  request: (url: string) => Promise<any>;
}) {
  const { code, date, invalid, update } = useResearchParams();
  const master = useQuery({
    queryKey: ["/master"],
    queryFn: () => request("/master"),
  });
  const result = useQuery<BottomAnalysis>({
    queryKey: ["bottom", code, date],
    queryFn: () =>
      request(
        `/bottom/analysis?code=${encodeURIComponent(code)}${date ? `&asOf=${date}` : ""}`,
      ),
    enabled: !!code && !invalid,
  });
  const data = code && !invalid ? result.data : undefined;
  return (
    <section className="bottom-research">
      <h1>底打ち研究</h1>
      <p>
        取得済みの日足から反転の条件を調べます。スコアは成功確率ではありません。
      </p>
      <div className="toolbar">
        <StockPicker
          stocks={master.data || []}
          value={code}
          onChange={(v) => update("code", v)}
          loading={master.isPending}
        />
        <label>
          基準日
          <input
            type="date"
            value={date}
            onChange={(e) => update("asOf", e.target.value)}
          />
        </label>
      </div>
      {invalid && <p role="alert">URLの銘柄コードまたは基準日が不正です。</p>}
      {!code && <p>銘柄を選択してください。</p>}
      {code && result.isPending && <p role="status">日足を解析しています…</p>}
      {code && result.error && <p role="alert">{result.error.message}</p>}
      {master.error && <p role="alert">銘柄一覧を取得できませんでした。</p>}
      {data && (
        <>
          <p>
            {data.mode === "demo" ? "DEMO · 架空データ" : "RESEARCH · 研究用"}{" "}
            ／ 基準日 {data.dataAsOf || "—"}
          </p>
          <p>
            取得時刻{" "}
            {data.observedAt
              ? new Date(data.observedAt).toLocaleString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                }) + " JST"
              : "—"}
          </p>
          <article className="card" aria-label="底打ち解析結果">
            <h2>{data.stage}</h2>
            <p className="bottom-score">
              {data.score === null ? "—" : data.score}
              <small> / 100点</small>
            </p>
            <p>未校正のルールスコアです。底打ち確定や購入推奨を示しません。</p>
            {data.status === "ready" && (
              <p>
                {data.candidatePrerequisite
                  ? "下落・売られ過ぎの前提条件に一致しています。"
                  : "下落・売られ過ぎの前提条件は揃っていません。"}
              </p>
            )}
            {data.reasonCodes.length > 0 && (
              <ul>
                {data.reasonCodes.map((r) => (
                  <li key={r}>{messages[r] || r}</li>
                ))}
              </ul>
            )}
          </article>
          <article className="card">
            <h2>確認が必要な点</h2>
            <ul>
              {data.riskCodes.map((r) => (
                <li key={r}>{messages[r] || r}</li>
              ))}
            </ul>
          </article>
          {data.indicators && (
            <>
              <article className="card">
                <h2>価格と移動平均</h2>
                <div className="chart" aria-label="80営業日の終値と移動平均">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.chart}>
                      <XAxis dataKey="sessionDate" minTickGap={80} />
                      <YAxis domain={["auto", "auto"]} width={70} />
                      <Tooltip />
                      <Legend />
                      <Line
                        dataKey="close"
                        name="調整後終値"
                        stroke="#2698d6"
                        dot={false}
                        isAnimationActive={false}
                      />
                      <Line
                        dataKey="sma5"
                        name="5日平均"
                        stroke="#d97706"
                        dot={false}
                        isAnimationActive={false}
                      />
                      <Line
                        dataKey="sma20"
                        name="20日平均"
                        stroke="#8b5cf6"
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <dl className="bottom-metrics">
                  {[
                    ["RSI14", number(data.indicators.rsi14)],
                    ["MACDヒストグラム", number(data.indicators.histogram)],
                    ["出来高倍率", number(data.indicators.volumeRatio)],
                    [
                      "60日高値からの下落率",
                      number(data.indicators.drawdown60, true),
                    ],
                    ["ATR / 終値", number(data.indicators.atrRatio, true)],
                    ["20日安値", number(data.indicators.low20)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </article>
              <article className="card">
                <h2>条件ごとの得点</h2>
                <div className="bottom-table">
                  <table>
                    <thead>
                      <tr>
                        <th>条件</th>
                        <th>判定</th>
                        <th>得点</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.conditions.map((c) => (
                        <tr key={c.code}>
                          <td>{c.label}</td>
                          <td>{c.met ? "一致" : "未一致"}</td>
                          <td>
                            {c.earnedPoints} / {c.maxPoints}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
              <p>
                かぶまる：一致した条件は
                {data.conditions.filter((c) => c.met).length}
                個だよ。反転の根拠と、確認が必要な点を一緒に見てね。
              </p>
            </>
          )}
          <Link
            className="button"
            to={`/similar?code=${code}${date ? `&asOf=${date}` : ""}`}
          >
            この銘柄のデジャヴ相場を見る
          </Link>
          <p>
            段階1：個別解析。全銘柄探索・予測記録・期限後評価は後続段階です。
          </p>
          <details>
            <summary>計算方法と根拠</summary>
            <p>
              直近80営業日を固定窓にして計算。RSI・ATRはWilder法、EMAは最初の期間の単純平均で初期化します。出来高倍率の分母は当日を除く20日平均です。全銘柄のランキングは後続段階です。
            </p>
            <p>
              平均売買代金（20営業日）：{number(data.averageTurnover20)} 円 ／{" "}
              {data.liquidity === "sufficient"
                ? "1億円以上"
                : data.liquidity === "low"
                  ? "1億円未満"
                  : "未確認"}
            </p>
            {data.adjustmentVersion && (
              <p>調整方法：{data.adjustmentVersion}</p>
            )}
            <p>
              {data.featureVersion} / {data.methodVersion}
            </p>
            <p className="bottom-hash">設定識別子 {data.configHash}</p>
          </details>
        </>
      )}
    </section>
  );
}
