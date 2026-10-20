import { PageTitle as Title } from "./PageTitle";
import "./Settings.css";
import { StockInsights } from "./StockInsights";
import { z } from "zod";
import { dejavuMemoriesSchema, dejavuResultSchema } from "../../../packages/core/dejavu-api-schema";
import { useResearchParams } from "./research-params";
import React, { useState, useEffect, useId, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ChatAnswer } from "./ChatAnswer";
import { CryptoWatch } from "./CryptoWatch";
import { ThemeToggle, initialTheme } from "./ThemeToggle";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  Link,
  useParams,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
} from "recharts";
import "./style.css";
import { StockPicker } from "./StockPicker";
import { displayStockCode } from "./stock-search";
import { Kabumaru } from "./Kabumaru";
const DejavuResearch = lazy(() => import("./DejavuResearch").then(m => ({ default: m.DejavuResearch })));
const BottomResearch = lazy(() => import("./BottomResearch").then(m => ({ default: m.BottomResearch })));
const KabumaruResearch = lazy(() => import("./KabumaruResearch").then(m => ({ default: m.KabumaruResearch })));
const KabumaruNotebook = lazy(() => import("./KabumaruNotebook").then(m => ({ default: m.KabumaruNotebook })));
const KabumaruLab = lazy(() => import("./KabumaruLab").then(m => ({ default: m.KabumaruLab })));
const KabumaruAgent = lazy(() => import("./KabumaruAgent").then(m => ({ default: m.KabumaruAgent })));
const ScoutAccuracy = lazy(() => import("./ScoutAccuracy").then(m => ({ default: m.ScoutAccuracy })));
const EarningsResearch = lazy(() => import("./EarningsResearch").then(m => ({ default: m.EarningsResearch })));
const BottomHunter = lazy(() => import("./BottomHunter").then(m => ({ default: m.BottomHunter })));
import { DailyFetch } from "./DailyFetch";
import { MemoryContent, memoryKindLabel, memorySyncLabel } from "./MemoryContent";
import { MemoryReset } from "./MemoryReset";
const Wallet = lazy(() => import("./wallet"));
const MemoryDelete = lazy(() => import("./MemoryDelete"));
export async function api(
  url: string,
  body?: unknown,
  method = "POST",
): Promise<any> {
  const r = await fetch("/api" + url, {
    credentials: "same-origin",
    ...(body !== undefined
      ? {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "通信エラー");
  return data;
}
const percent = (v: number | undefined | null) =>
  v == null ? "—" : (v * 100).toFixed(2) + "%";
const yen = (v: number | undefined | null) =>
  v == null
    ? "—"
    : "¥" + v.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
function useData(path: string, enabled = true) {
  return useQuery({ queryKey: [path], queryFn: () => api(path), enabled });
}
function Chart({
  data,
  field = "adjClose",
  color,
}: {
  data: any[];
  field?: string;
  color?: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const previous = data.at(-2)?.[field];
  const latest = data.at(-1)?.[field];
  const chartColor = color ?? (typeof previous === "number" && typeof latest === "number"
    ? latest > previous ? "#15803d" : latest < previous ? "#dc2626" : "#2698d6"
    : "#2698d6");
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={chartColor} stopOpacity={0.3} />
              <stop offset="1" stopColor={chartColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="sessionDate"
            minTickGap={80}
            tick={{ fontSize: 11 }}
          />
          <YAxis domain={["auto", "auto"]} width={65} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Area
            dataKey={field}
            name={field === "adjClose" ? "調整後終値" : field === "volume" ? "出来高" : "価格"}
            stroke={chartColor}
            fill={`url(#${gradientId})`}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
function Action({
  children,
  onClick,
  disabled = false,
  busyMessage,
  successMessage,
}: {
  children: React.ReactNode;
  onClick: () => Promise<unknown>;
  disabled?: boolean;
  busyMessage?: string;
  successMessage?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [complete, setComplete] = useState(false);
  const client = useQueryClient();
  return (
    <span className="action">
      <button
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setError("");
          setComplete(false);
          try {
            await onClick();
            void client.invalidateQueries().catch(() => undefined);
            setComplete(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <><span className="action-spinner" aria-hidden="true" />{busyMessage ? "日足を取得中…" : "処理中…"}</> : children}
      </button>
      {busyMessage && <span role="status" aria-live="polite" className="fetch-action-status">
        {busy ? busyMessage : complete ? successMessage : ""}
      </span>}
      {!busyMessage && complete && successMessage && <span role="status" aria-live="polite">{successMessage}</span>}
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </span>
  );
}
function SelectStock({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { data = [], isPending } = useData("/master");
  return (
    <StockPicker
      stocks={data}
      value={value}
      onChange={onChange}
      loading={isPending}
    />
  );
}
function MenuIcon({ kind }: { kind: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M9 3v18M9 10h12" /></>,
    chat: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5a8.5 8.5 0 0 1 17 0Z" /><path d="M8 10h8M8 14h5" /></>,
    similar: <><path d="m3 9 4-4 4 4 4-4 6 6M3 17l4-4 4 4 4-4 6 6" /></>,
    bottom: <><path d="M4 4v16h16M7 9l4 6 4-4 5 2" /><circle cx="11" cy="15" r="2" /></>,
    hunter: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5M11 7v8M7 11h8" /></>,
    predictions: <><path d="M4 20V4M4 20h16M8 15l5-5 3 2 5-7M16 5h5v5" /></>,
    memories: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7" /></>,
    settings: <><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
  };
  return <svg className="menu-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
function App() {
  const { data: status, error } = useData("/status");
  return (
    <div className="shell">
      <aside className="research-sidebar">
        <Link className="brand" to="/">
          <img
            className="logo"
            src="/brand/kabuto-wal-logo.png"
            alt="KABUTO WAL ロゴ"
            width="1254"
            height="1254"
          />
          <span>
            KABUTO WAL<small>相場を知る。判断を覚える。</small>
          </span>
        </Link>
        <div className="sidebar-ecosystem"><span>Sui</span><i aria-hidden="true" /> <span>Walrus</span></div>
        <p className="navlabel">相場と記憶のワークスペース</p>
        <nav aria-label="メインメニュー">
          {[
            ["/", "ホーム", "home"],
            ["/chat", "記憶チャット", "chat"],
            ["/similar", "類似相場", "similar"],
            ["/bottom", "底打ち研究", "bottom"],
            ["/bottom/hunter", "底打ちハンター", "hunter"],
            ["/research", "かぶまる研究", "similar"],
            ["/research/earnings", "決算チェック", "predictions"],
            ["/predictions", "予測と検証", "predictions"],
            ["/memories", "記憶一覧", "memories"],
            ["/settings", "設定", "settings"],
          ].map(([p, t, i]) => (
            <NavLink end key={p} to={p}>
              <MenuIcon kind={i} />
              {t}
            </NavLink>
          ))}
        </nav>
        <div className="sidefoot">
          <span className="dot" /> JSON 永続保存
          <small>
            KABUTO WAL · 個人用の株式研究アプリ
            <br />
            売買注文機能はありません
          </small>
        </div>
      </aside>
      <main>
        <header>
          <ThemeToggle />
          <Link className="header-brand" to="/">
            <img src="/brand/icon-192.png" alt="" width="192" height="192" />
            <span>KABUTO WAL</span>
          </Link>
          <span className="badge">
            {status?.mode === "demo"
              ? "DEMO · 架空データ"
              : status
                ? status.delayDays
                  ? "DELAYED · 12週遅延"
                  : "DAILY · 実データ"
                : "接続確認中"}
          </span>
        </header>
        <div className="content">
          {error && (
            <div className="error">
              {["本人ウォレット認証が必要", "セッション期限切れ", "無効なセッション"].includes(error.message)
                ? "本人確認が必要です。設定画面の「本人確認を始める」を押し、ウォレットで署名を承認してください。 "
                : error.message}
              <Link to="/settings#owner-wallet">本人確認の設定を開く →</Link>
            </div>
          )}
          <Suspense fallback={<p role="status">画面を準備中…</p>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/stocks/:code" element={<Stock />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/similar" element={<Similar />} />
            <Route path="/bottom" element={<BottomResearch request={api} />} />
            <Route path="/bottom/hunter" element={<BottomHunter request={api} />} />
            <Route path="/research" element={<KabumaruResearch request={api} />} />
            <Route path="/research/notebook" element={<KabumaruNotebook request={api} />} />
            <Route path="/research/lab" element={<KabumaruLab request={api} />} />
            <Route path="/research/agent" element={<KabumaruAgent request={api} />} />
            <Route path="/research/accuracy" element={<ScoutAccuracy request={api} />} />
            <Route path="/research/earnings" element={<EarningsResearch />} />
            <Route path="/predictions" element={<Predictions />} />
            <Route path="/memories" element={<Memories />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
          </Suspense>
        </div>
      </main>
      <Kabumaru authenticated={!!status && !error} />
    </div>
  );
}
function Home() {
  const queryClient = useQueryClient();
  const { data: stocks = [] } = useData("/watchlist"),
    { data: predictions = [] } = useData("/predictions");
  const [code, setCode] = useState("");
  return (
    <>
      <Title
        eyebrow="MARKET OVERVIEW"
        title="今日の相場、これまでの記憶。"
        description="過去の判断と照らし合わせて、次の仮説を育てる。"
      />
      <div className="toolbar">
        <SelectStock value={code} onChange={setCode} />
        <Action disabled={!code} successMessage="監視に追加しました。" onClick={async () => {
          const result = await api("/watchlist", { code });
          await queryClient.invalidateQueries({ queryKey: ["/watchlist"] });
          return result;
        }}>
          ＋ 監視に追加
        </Action>
        <Action
          disabled={!stocks.length}
          busyMessage={`ウォッチリスト${stocks.length}銘柄の日足を取得中です。過去データも再取得するため、時間がかかることがあります。`}
          successMessage="日足の取得処理が完了しました。各銘柄の基準日と、設定画面の実行履歴で結果を確認できます。"
          onClick={async () => {
            const job = await api("/jobs/fetch", {});
            if (job.status === "failed") {
              throw Error("日足の取得に失敗しました：" + (job.steps.find((step: any) => step.error)?.error || "設定画面の実行履歴を確認してください。"));
            }
          }}
        >日足を取得</Action>
      </div>
      <div className="stats">
        <div>
          <small>監視銘柄</small>
          <strong>
            {stocks.length}
            <em>/ 10</em>
          </strong>
        </div>
        <div>
          <small>検証待ち</small>
          <strong>
            {
              predictions.filter((p: any) => p.state.status === "pending")
                .length
            }
            <em>件</em>
          </strong>
        </div>
        <div>
          <small>研究の視点</small>
          <strong>
            1 / 5 / 20<em>営業日</em>
          </strong>
        </div>
      </div>
      <div className="sectionhead">
        <h2>ウォッチリスト</h2>
        <span>日足 · 調整後終値</span>
      </div>
      {stocks.length === 0 && (
        <div className="card empty">
          <h3>ここから、あなたの研究を始めましょう。</h3>
          <p>
            上の検索欄に証券コード・銘柄名を入力し、候補を選んで「＋
            監視に追加」を押してください。予測や記憶は、自分で作成・保存するまで空のままです。
          </p>
        </div>
      )}
      <div className="stockgrid">
        {stocks.map((s: any) => (
          <article className="card stockcard" key={s.providerCode}>
            <Link to={"/stocks/" + s.providerCode}>
              <span className="muted">{displayStockCode(s.displayCode || s.providerCode)}</span>
              <h3>{s.name}</h3>
              <div className="price">
                {yen(s.last?.adjClose)}
                <span className={s.change >= 0 ? "up" : "down"}>
                  {percent(s.change)}
                </span>
              </div>
              <MiniChart code={s.providerCode} />
              <small>
                基準日 {s.last?.sessionDate || "未取得"}
                <br />
                最終取得 {s.last?.availableAt || "—"}
              </small>
            </Link>
            <Action
              onClick={() => api("/watchlist/" + s.providerCode, {}, "DELETE")}
            >
              監視から外す
            </Action>
          </article>
        ))}
      </div>
      <CryptoWatch />
      <div className="callout">
        <span>◈</span>
        <div>
          <h3>記録した理由が、次の判断の手がかりに。</h3>
          <p>予測の原本を残し、期限後の結果を別記録で比較します。</p>
          <Link to="/chat">過去の考えを振り返る →</Link>
        </div>
      </div>
    </>
  );
}
function MiniChart({ code }: { code: string }) {
  const { data = [] } = useData("/stocks/" + code + "/history");
  return <Chart data={data.slice(-60)} />;
}
function Stock() {
  const { code = "72030" } = useParams(),
    { data = [] } = useData("/stocks/" + code + "/history"),
    { data: ms = [] } = useData("/master");
  const [period, setPeriod] = useState(120);
  const { data: metrics } = useData("/stocks/" + code + "/features");
  const memoryQuery = useData("/memories"), memories = memoryQuery.data ?? [];
  const predictionQuery = useData("/predictions"), predictions = predictionQuery.data ?? [];
  const last = data.at(-1);
  return (
    <>
      <Title
        eyebrow="STOCK RESEARCH"
        title={ms.find((m: any) => m.providerCode === code)?.name || displayStockCode(code!)}
        description={`基準日 ${last?.sessionDate || "—"} / 最終取得 ${last?.availableAt || "—"}`}
      />
      <div className="toolbar">
        {[60, 120, 250].map((n) => (
          <button key={n} onClick={() => setPeriod(n)}>
            {n}営業日
          </button>
        ))}
        <Link className="button" to={"/similar?code=" + code}>
          類似相場を探す
        </Link>
        {([1, 5, 20] as const).map((h) => (
          <Action
            key={h}
            onClick={() => api("/predictions", { code, horizon: h })}
          >
            {h}営業日予測
          </Action>
        ))}
      </div>
      <div className="card">
        <h2>
          {yen(last?.adjClose)} <span className="muted">調整後終値</span>
        </h2>
        <Chart data={data.slice(-period)} />
        <div className="volume">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.slice(-period)}>
              <Bar dataKey="volume" name="出来高" fill="#94c7e5" />
              <Tooltip />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="muted">
        数値手法は履歴を使用。価格レンジは経験分位であり保証された予測区間ではありません。
      </p>
      <Link to="/predictions">予測履歴を見る →</Link>
      {metrics && (
        <div className="card">
          <h3>相場の特徴 · {metrics.sessionDate}</h3>
          <dl>
            {[
              ["5日騰落率", percent(metrics.vector[0])],
              ["20日騰落率", percent(metrics.vector[1])],
              ["20日ボラティリティ", percent(metrics.vector[2])],
              ["出来高倍率", metrics.vector[3].toFixed(2) + "倍"],
              ["移動平均乖離", percent(metrics.vector[4])],
            ].map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      )}
      <StockInsights code={code} memories={memories} predictions={predictions} memoryLoading={memoryQuery.isPending} predictionLoading={predictionQuery.isPending} memoryError={!!memoryQuery.error} predictionError={!!predictionQuery.error} />
    </>
  );
}
function Similar() {
  const queryClient = useQueryClient();
  const { code, date, compare, invalid, update, hunterJobId } = useResearchParams();
  const compareEnabled = !!compare;
  const setCode = (value: string) => update("code", value);
  const setDate = (value: string) => update("asOf", value);
  const setCompare = (value: string) => update("compareCode", value);
  const { data, error } = useQuery({
    queryKey: ["dejavu-analysis", code, date, compare, hunterJobId],
    queryFn: async () => {
      const raw: unknown = await api(`/similar?${new URLSearchParams({ code, ...(date ? { asOf: date } : {}), ...(compare ? { compareCode: compare } : {}), ...(hunterJobId ? { hunterJobId } : {}) })}`);
      const unavailable = z.object({ ready: z.literal(false), message: z.string() }).safeParse(raw);
      return unavailable.success ? unavailable.data : dejavuResultSchema.parse(raw);
    },
    enabled: !!code && !invalid,
  });
  const analysis = data && "recordId" in data ? data : undefined;
  useEffect(() => {
    if (analysis?.recordId)
      void queryClient.invalidateQueries({ queryKey: ["kabumaru-feed"] });
  }, [analysis?.recordId, queryClient]);
  return (
    <>
      <Title
        eyebrow="PATTERN EXPLORER"
        title="カブまるのデジャヴ相場"
        description="20営業日のOHLCVから、過去の似た値動きを探します。類似度は将来の上昇確率ではありません。"
      />
      <div className="toolbar">
        <SelectStock value={code} onChange={setCode} />
        <label>
          <input
            type="checkbox"
            checked={compareEnabled}
            onChange={(e) => {
              setCompare(e.target.checked ? "67580" : "");
            }}
          />{" "}
          別銘柄と比較
        </label>
        {compareEnabled && (
          <SelectStock value={compare} onChange={setCompare} />
        )}
        <input
          type="date"
          aria-label="基準日"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <p className="muted">
        比較元 {displayStockCode(code)} / 候補 {displayStockCode(compare || code)} · 20営業日窓 ·
        欠損窓と未来実績を除外
      </p>
      {invalid && <p role="alert">URLの銘柄コードまたは基準日が不正です。</p>}
      {error && <p role="alert">{error.message}</p>}
      {!code && <p role="status">日足を取得した銘柄を選んでください。</p>}
      {data && "ready" in data && data.ready === false && <div className="card" role="status"><h3>日足データの準備が必要です</h3><p>{data.message}</p><Link to="/">ホームで監視銘柄と日足を確認 →</Link></div>}
      {analysis?.notificationWarning && <p role="status">{analysis.notificationWarning}</p>}
      {code && !data && !error && <p role="status">20営業日の特徴量と過去事例を分析中…</p>}
      {analysis && <DejavuResearch key={analysis.recordId} data={analysis} code={code} date={date} compare={compare} hunterJobId={hunterJobId} request={api} memories={<DejavuMemories code={code} date={date} saved="" />} />}
    </>
  );
}
function DejavuMemories({
  code,
  date,
  saved,
}: {
  code: string;
  date: string;
  saved: string;
}) {
  const { data, error } = useQuery({
    queryKey: ["dejavu-memories", code, date, saved],
    queryFn: async () =>
      dejavuMemoriesSchema.parse(await api("/dejavu/memories?code=" + code + (date ? "&asOf=" + date : ""))),
  });
  return (
    <details>
      <summary>保存したデジャヴ相場を検索</summary>
      {error && <p role="alert">{error.message}</p>}
      {data && (
        <>
          <p>
            {data.search === "memwal-semantic"
              ? "MemWal意味検索"
              : data.search === "local-demo"
                ? "デモのローカル記憶"
                : "ローカル記憶（MemWal未使用）"}
          </p>
          {data.error && <p>{data.error}</p>}
          {!data.memories.length && (
            <p>この時点で参照できる保存記憶はありません。</p>
          )}
          {data.memories.map((m) => (
            <p key={m.recordId}>
              {m.dataAsOf} · {m.payload.examples.length}事例 ·{" "}
              {m.mode === "demo" ? "架空" : "実データ"} ·{" "}
              {m.recordId.slice(0, 8)}
            </p>
          ))}
        </>
      )}
    </details>
  );
}
function Predictions() {
  const { data = [] } = useData("/predictions");
  const { data: summary = [] } = useData("/evaluations/summary");
  const [backtest, setBacktest] = useState<any>(null);
  const [code, setCode] = useState("72030"),
    [asOf, setAsOf] = useState(""),
    [horizon, setHorizon] = useState(5),
    [filter, setFilter] = useState("all");
  const completed = data.filter((p: any) => p.evaluations.length),
    shown = data.filter(
      (p: any) => filter === "all" || String(p.horizonSessions) === filter,
    );
  return (
    <>
      <Title
        eyebrow="FORECAST JOURNAL"
        title="予測を残す。結果から学ぶ。"
        description="過去サンプルの中央値・10/90百分位・上昇割合を記録。原本を変更せず、実績を追記します。"
      />
      <div className="toolbar">
        <SelectStock value={code} onChange={setCode} />
        <select
          aria-label="期限"
          value={horizon}
          onChange={(e) => setHorizon(Number(e.target.value))}
        >
          {[1, 5, 20].map((h) => (
            <option key={h} value={h}>
              {h}営業日
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="予測基準日"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
        <Action
          disabled={!code}
          onClick={() =>
            api("/predictions", { code, horizon, ...(asOf ? { asOf } : {}) })
          }
        >
          予測を生成
        </Action>
        <Action onClick={() => api("/evaluations", {})}>期限後の検証</Action>
        <Action
          disabled={!code}
          onClick={async () =>
            setBacktest(
              await api("/backtest?code=" + code + "&horizon=" + horizon),
            )
          }
        >
          数値バックテスト
        </Action>
      </div>
      {backtest && (
        <div className="card">
          <p>{backtest.note}</p>
          <p>
            walk-forward評価 {backtest.rows.length}件 / 除外 {backtest.excluded}
            件
          </p>
          <details>
            <summary>検証記録を見る</summary>
            <pre>{JSON.stringify(backtest, null, 2)}</pre>
          </details>
        </div>
      )}
      {summary.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>期限 / モード / 手法</th>
                <th>評価 / 未評価 / 欠損</th>
                <th>平均絶対誤差</th>
                <th>ゼロ予測誤差</th>
                <th>方向一致率</th>
                <th>分位内率</th>
                <th>Brier平均</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s: any) => (
                <tr key={s.key}>
                  <td>{s.key}</td>
                  <td>
                    {s.evaluated} / {s.pending} / {s.missing}
                  </td>
                  <td>{percent(s.mae)}</td>
                  <td>{percent(s.baselineMae)}</td>
                  <td>{percent(s.directionRate)}</td>
                  <td>{percent(s.inRangeRate)}</td>
                  <td>{s.meanBrier?.toFixed(4) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="stats">
        <div>
          <small>予測記録</small>
          <strong>
            {data.length}
            <em>件</em>
          </strong>
        </div>
        <div>
          <small>評価済み</small>
          <strong>
            {completed.length}
            <em>件</em>
          </strong>
        </div>
        <div>
          <small>未評価 / 欠損</small>
          <strong>
            {data.length - completed.length}
            <em>件</em>
          </strong>
        </div>
      </div>
      <select
        aria-label="期限別表示"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      >
        <option value="all">全期限</option>
        {[1, 5, 20].map((h) => (
          <option key={h} value={h}>
            {h}営業日
          </option>
        ))}
      </select>
      {shown.length === 0 && (
        <div className="card empty">
          まだ予測がありません。デモの過去基準日を選ぶと期限後検証を試せます。
        </div>
      )}
      {shown.map((p: any) => {
        const e = p.evaluations.at(-1);
        return (
          <article key={p.predictionId} className="card prediction">
            <div className="sectionhead">
              <h3>
                {displayStockCode(p.providerCode)} · {p.horizonSessions}営業日先
              </h3>
              <span className="badge">
                {p.mode} / {p.state.status}
              </span>
            </div>
            <div className="predictionnumbers">
              <div>
                <small>予測リターン</small>
                <strong>{percent(p.predictedReturn)}</strong>
              </div>
              <div>
                <small>期待価格</small>
                <strong>{yen(p.expectedPrice)}</strong>
              </div>
              <div>
                <small>過去の上昇割合</small>
                <strong>{percent(p.pUp)}</strong>
              </div>
            </div>
            <p>
              基準 {p.dataAsOf} → 期限 {p.targetSessionDate} / 候補{" "}
              {p.sampleCount}件
            </p>
            <p>
              経験分位 {percent(p.returnQuantiles[0])}〜
              {percent(p.returnQuantiles[1])}
            </p>
            <p>{p.reason}</p>
            <p className="muted">
              {p.falsification} / {p.methodVersion} / 証明：
              {p.commitment?.status === "anchored"
                ? p.commitment.priorEvidence
                  ? "事前アンカーあり"
                  : "期限後の記録（事前証明なし）"
                : "未アンカー"}
            </p>
            <Action
              onClick={async () => {
                const { anchorPrediction } = await import("./wallet");
                await anchorPrediction(p.predictionId);
              }}
            >
              testnetに任意記録
            </Action>
            {e && (
              <div className="result">
                実績 {percent(e.actualReturn)} / 誤差 {percent(e.returnError)} /
                方向 {e.directionMatch ? "一致" : "不一致"} / 分位内{" "}
                {e.inRange ? "はい" : "いいえ"} / Brier {e.brier.toFixed(4)} /
                ゼロ予測誤差 {percent(e.baselineError)}
              </div>
            )}
            <details>
              <summary>原本と評価revision</summary>
              <pre>{JSON.stringify(p, null, 2)}</pre>
            </details>
          </article>
        );
      })}
    </>
  );
}
function Chat() {
  const [code, setCode] = useState("72030"),
    [question, setQuestion] = useState(
      "この銘柄について前に何を心配していた？",
    ),
    [events, setEvents] = useState<any[]>([]);
  return (
    <>
      <Title
        eyebrow="MEMORY CONVERSATION"
        title="過去の自分と、対話する。"
        description="記憶を根拠に振り返る。ローカル応答と外部AIの接続状態を区別します。"
      />
      <SelectStock value={code} onChange={setCode} />
      <div className="chatlayout">
        <div>
          <div className="card promptcard">
            <small>こんな問いから</small>
            {[
              "この銘柄について前に何を心配していた？",
              "過去の外れ方を踏まえて今回の仮説を説明して",
              "先月の予測は実際どうなった？",
            ].map((q) => (
              <button key={q} onClick={() => setQuestion(q)}>
                {q} ↗
              </button>
            ))}
          </div>
          {events.map((e) => (
            <div className="card chatmessage" key={e.recordId}>
              <div className="userquestion">{e.question}</div>
              <ChatAnswer event={e} />
            </div>
          ))}
          <div className="chatinput">
            <textarea
              aria-label="質問"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <Action
              disabled={!code}
              onClick={async () => {
                const e = await api("/chat", { question, code });
                setEvents([...events, e]);
              }}
            >
              質問する →
            </Action>
          </div>
        </div>
        <div className="card">
          <h3>重要事項だけを記憶</h3>
          <p>長期的な方針や仮説を明示的に保存します。</p>
          <Action onClick={() => api("/memories", { text: question })}>
            入力内容を記憶に保存
          </Action>
          <p className="muted">
            記憶の文章は参照資料として扱います。設定変更やツール実行の指示には使用しません。
          </p>
        </div>
      </div>
    </>
  );
}
function Memories() {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<any>(null);
  const { data = [] } = useData("/memories");
  const { data: stocks = [] } = useData("/master");
  const [query, setQuery] = useState(""),
    [text, setText] = useState("");
  return (
    <div className="memory-library">
      <Title
        eyebrow="MEMORY LIBRARY"
        title="考えたことを、忘れない。"
        description="保存した方針・予測・似た値動きの分析を振り返れます。記録はこのアプリに保存されています。"
      />
      <div className="toolbar">
        <input
          aria-label="ローカル検索"
          placeholder="銘柄名・コード・記録の内容で検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          aria-label="新しい記憶"
          placeholder="記憶する方針・仮説"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Action onClick={() => api("/memories", { text })}>記憶を保存</Action>
      </div>
      {deleting && <Suspense fallback={<p>削除画面を準備中…</p>}><MemoryDelete key={deleting.recordId} memory={deleting} stocks={stocks} onClose={() => { setDeleting(null); void queryClient.invalidateQueries({ queryKey: ["/memories"] }); }} onDone={() => { void queryClient.invalidateQueries({ queryKey: ["/memories"] }); }} /></Suspense>}
      {data
        .filter((m: any) => [m.text, memoryKindLabel(m.kind), displayStockCode(m.providerCode || ""), stocks.find((s: any) => s.providerCode === m.providerCode)?.name || ""].some((value) => value.toLowerCase().includes(query.toLowerCase())))
        .map((m: any) => (
          <article className="card memory" key={m.recordId}>
            <div className="sectionhead">
              <span className="badge">{memoryKindLabel(m.kind)}</span>
              <span>
                {m.active ? "利用中" : "利用停止"} · {memorySyncLabel(m.sync?.status, m.sync?.blobId)}
              </span>
            </div>
            <MemoryContent memory={m} stocks={stocks} />
            <div className="toolbar memory-actions">
              <Action
                onClick={() =>
                  api("/memories/" + m.recordId, { active: !m.active }, "PATCH")
                }
              >
                {m.active ? "無効化" : "再有効化"}
              </Action>
              <Action
                onClick={async () => {
                  const corrected = window.prompt("訂正内容", m.text);
                  if (corrected)
                    await api(
                      "/memories/" + m.recordId,
                      { text: corrected },
                      "PATCH",
                    );
                }}
              >
                訂正する
              </Action>
              <button className={m.sync?.status === "deleted" ? "memory-review" : "memory-delete"} disabled={!m.sync?.blobId} onClick={() => setDeleting({ ...m })}>
                {m.sync?.status === "deleted" ? "blob削除済み・検索索引を確認" : m.sync?.directWalrusDeletion?.state === "executing" || m.sync?.remoteDeletion && !["failed", "rolled_back"].includes(m.sync.remoteDeletion.state) ? "削除結果を確認" : "MemWalから削除"}
              </button>
              {!m.sync?.blobId && <small>MemWal保存完了後に削除できます。</small>}
            </div>
          </article>
        ))}
    </div>
  );
}
function Settings() {
  const { data, error, isPending } = useQuery({
    queryKey: ["/status"],
    queryFn: () => api("/status"),
    refetchInterval: 30000,
    retry: false,
  });
  // In live mode /status is protected by the server's session validation.
  // Demo access and stale data after a failed session check are not authentication.
  const authenticated = !!data && data.mode !== "demo" && !error;
  const [password, setPassword] = useState(""),
    [payload, setPayload] = useState("");
  return (
    <div className="settings-page">
      <Title
        eyebrow="WORKSPACE SETTINGS"
        title="研究環境を整える。"
        description="ウォレットの本人確認、サービスの接続状態、保存データを管理します。"
      />
      <nav className="settings-nav" aria-label="設定項目"><a href="#owner-wallet">ウォレットと本人確認</a><a href="#service-connections">接続状態</a><a href="#settings-backup">バックアップ</a></nav>
      <div className="card wallet-card" id="owner-wallet">
        <div className="wallet-heading">
          <div className="wallet-symbol" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 13h5M7 5V3h10"/><circle cx="16" cy="14.5" r=".75" fill="currentColor" stroke="none"/></svg></div>
          <div><span className="wallet-eyebrow">WALLET & ACCESS</span><h2>ウォレットと本人確認</h2></div>
        </div>
        {isPending ? <p role="status">本人確認の状態を確認中…</p> : authenticated ? <>
          <div className="wallet-connected">
            <div><p className="wallet-status" role="status"><span className="wallet-status-dot" aria-hidden="true"/>本人確認済み</p><p className="wallet-description">本人ウォレットでの認証が完了しています。</p></div>
            <div className="wallet-disconnect">
          <Action onClick={async () => {
            const { disconnectWallet } = await import("./wallet");
            await disconnectWallet();
          }}>ウォレット接続解除</Action>
            </div>
          </div>
          <div className="wallet-footer"><span>認証の有効期間 · 1時間</span><p>MemWalの連携設定は「接続状態」で確認できます。認証の有効期限が切れると、再度本人確認が必要です。</p></div>
        </> : <>
        <Suspense
          fallback={
            <p className="brand-loading" role="status">
              <img src="/brand/icon-192.png" alt="" width="192" height="192" />
              KABUTO WAL · ウォレットを読み込み中…
            </p>
          }
        >
          <Wallet />
        </Suspense>
        </>}
      </div>
      <section id="service-connections" className="card connection-card" aria-labelledby="connection-title">
        <span className="settings-eyebrow">CONNECTED SERVICES</span><h2 id="connection-title">接続状態</h2>
        <p className="connection-intro">各機能の設定状況を確認できます。「設定済み」でも、実際に使えるかの確認は別途必要です。</p>
        {isPending ? <p role="status">接続状態を確認中…</p> : error ? <p role="alert">接続状態を取得できませんでした。上のウォレット欄で本人確認の状態を確認してください。</p> : data && <>
          <div className="connection-grid">
            {[
              { title: "株価データ", purpose: "銘柄や日足データの取得", status: data.market, help: "実接続が未検証の場合は、銘柄画面でデータを取得して確認してください。" },
              { title: "記憶の保存・検索（MemWal）", purpose: "記録した内容を保存し、あとで検索", status: data.memory, help: "下のボタンで、記憶の所有者とアプリのアクセス権限を確認します。保存・検索の動作確認は含みません。", action: true },
              { title: "AIの応答", purpose: "記録や株価をもとに回答", status: data.llm, help: "ローカル応答はアプリ内で作る回答です。外部AIに接続していなくても利用できます。" },
              { title: "予測の証明（Sui）", purpose: "予測を作成した証拠をブロックチェーンに記録", status: data.sui, help: "ウォレットでの本人確認とは別の機能です。未配備の場合、予測の証明は記録されません。" },
            ].map((item) => <article className="connection-item" key={item.title}>
              <h3>{item.title}</h3>
              <p className="connection-purpose">{item.purpose}</p>
              <p className="connection-state">{item.status || "状態を取得できません"}</p>
              <p className="connection-help">{item.help}</p>
              {item.action && <Action onClick={() => api("/connections/memwal", {})} successMessage="所有者とアプリのアクセス権限を確認しました。保存・検索の動作は未検証です。">MemWalのアクセス権限を確認</Action>}
            </article>)}
          </div>
          <div className="connection-permissions">
            <h3>株価データの外部送信</h3>
            <p className="connection-help">送信の許可設定です。接続の成功や、送信済みであることを示すものではありません。</p>
            <dl>
              <dt>記憶の保存先（MemWal）へ</dt><dd>{data.allowMemwal ? "送信を許可" : "送信しない"}</dd>
              <dt>外部AIへ</dt><dd>{data.allowLlm ? "送信を許可" : "送信しない"}</dd>
            </dl>
          </div>
        </>}
      </section>
      <div className="card settings-backup" id="settings-backup"><span className="settings-eyebrow">DATA & BACKUP</span><h2>暗号化バックアップ</h2>
        <p>
          全JSON記録・索引・同期状態・saltを暗号化。環境変数と認証nonceは含みません。
        </p>
        <input
          type="password"
          autoComplete="new-password"
          aria-label="バックアップパスフレーズ"
          placeholder="12文字以上のパスフレーズ"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="toolbar">
          <Action
            onClick={async () => {
              const result = await api("/backup/export", { password });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(
                new Blob([result.payload], {
                  type: "application/octet-stream",
                }),
              );
              a.download = "kabuto-wal.enc";
              a.click();
              URL.revokeObjectURL(a.href);
            }}
          >
            暗号化してエクスポート
          </Action>
          <input
            type="file"
            aria-label="バックアップファイル"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setPayload(await f.text());
            }}
          />
          <Action onClick={() => api("/backup/import", { password, payload })}>
            復元する
          </Action>
        </div>
      </div>
      <MemoryReset authenticated={authenticated} />
      <DailyFetch jobs={data?.jobs} />
    </div>
  );
}
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
document.documentElement.dataset.theme = initialTheme();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
