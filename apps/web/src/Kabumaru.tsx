import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { StockPicker } from "./StockPicker";
import { displayStockCode } from "./stock-search";
import type {
  AssistantNotice,
  KabumaruPose,
} from "../../../packages/core/assistant";
const poses: KabumaruPose[] = [
  "idle",
  "discover",
  "analyze",
  "thinking",
  "happy",
  "warning",
];
const poseNames = {
  idle: "待機",
  discover: "発見",
  analyze: "分析",
  thinking: "考え中",
  happy: "喜ぶ",
  warning: "注意",
};
const asset = (pose: KabumaruPose) =>
  `/characters/kabumaru/kabumaru_${pose}${pose === "discover" ? "_clean" : ""}.png`;
export function KabumaruPortrait({ pose }: { pose: KabumaruPose }) {
  return <img className="dejavu-kabumaru" src={asset(pose)} alt={`カブまる：${poseNames[pose]}`} />;
}
async function request(path: string, body?: unknown) {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...(body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "通信できませんでした");
  return data;
}
function readSeen(): string[] {
  try {
    const data = JSON.parse(localStorage.getItem("kabumaru-seen-v1") || "[]");
    return Array.isArray(data) ? data.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function Kabumaru({ authenticated }: { authenticated: boolean }) {
  const [open, setOpen] = useState(false),
    [code, setCode] = useState(""),
    [question, setQuestion] = useState(""),
    [events, setEvents] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [pose, setPose] = useState<KabumaruPose>("idle"),
    [error, setError] = useState(""),
    [seen, setSeen] = useState(readSeen),
    [bubbleVisible, setBubbleVisible] = useState(true),
    [settledNotice, setSettledNotice] = useState<string | null>(null),
    [saving, setSaving] = useState("");
  const panel = useRef<HTMLElement>(null),
    launcher = useRef<HTMLButtonElement>(null),
    mounted = useRef(true);
  const queryClient = useQueryClient();
  const {
    data: feed,
    isFetching: fetching,
    error: feedError,
  } = useQuery({
    queryKey: ["kabumaru-feed"],
    queryFn: () => request("/assistant"),
    enabled: authenticated,
    refetchInterval: 30000,
  });
  const { data: master = [] } = useQuery({
    queryKey: ["/master"],
    queryFn: () => request("/master"),
    enabled: authenticated && open,
  });
  const notices: AssistantNotice[] =
    authenticated && !feedError ? feed?.notices || [] : [];
  const unread = notices.filter((n) => !seen.includes(n.recordId)),
    latest = unread[0];
  const displayPose = busy
    ? pose
    : settledNotice === latest?.recordId || !latest
      ? "idle"
      : latest?.pose || "idle";
  useEffect(() => {
    mounted.current = true;
    for (const p of poses) {
      const img = new Image();
      img.src = asset(p);
    }
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  useEffect(() => {
    if (latest) setBubbleVisible(true);
  }, [latest?.recordId]);
  const markRead = () => {
    const ids = [
      ...new Set([...seen, ...notices.map((n) => n.recordId)]),
    ].slice(-500);
    setSeen(ids);
    try {
      localStorage.setItem("kabumaru-seen-v1", JSON.stringify(ids));
    } catch {
      /* UI storage may be disabled */
    }
    setBubbleVisible(false);
  };
  const close = () => {
    setOpen(false);
    launcher.current?.focus();
  };
  async function send() {
    if (!question.trim() || busy || !authenticated) return;
    setBusy(true);
    setError("");
    setPose("analyze");
    try {
      if (code) await request("/stocks/" + code + "/features");
      if (!mounted.current) return;
      setPose("thinking");
      const event = await request("/chat", {
        question: question.trim(),
        ...(code ? { code } : {}),
      });
      if (mounted.current) {
        setEvents((prev) => [...prev, event]);
        setQuestion("");
        await queryClient.invalidateQueries({ queryKey: ["kabumaru-feed"] });
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setPose("idle");
        setSettledNotice(latest?.recordId || null);
      }
    }
  }
  return (
    <div className="kabumaru" data-pose={displayPose}>
      {!open && latest && bubbleVisible && (
        <div className="kabumaru-bubble">
          <button
            className="kabumaru-dismiss"
            aria-label="吹き出しを閉じる"
            onClick={() => setBubbleVisible(false)}
          >
            ×
          </button>
          <span className="kabumaru-source">
            {latest.mode === "demo"
              ? "DEMO・架空データ"
              : latest.mode.toUpperCase()}{" "}
            · {latest.dataAsOf}
          </span>
          <p>{latest.title}</p>
          <Link to={latest.href} onClick={markRead}>
            根拠と詳細を見る →
          </Link>
        </div>
      )}
      {open && (
        <section
          ref={panel}
          tabIndex={-1}
          className="kabumaru-panel"
          role="dialog"
          aria-modal="false"
          aria-label="カブまるAIアシスタント"
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <header className="kabumaru-panel-header">
            <img
              src={asset(displayPose)}
              alt={`カブまる ${poseNames[displayPose]}`}
              width="64"
              height="64"
            />
            <div>
              <h2>カブまるAIアシスタント</h2>
              <small>
                {authenticated
                  ? busy
                    ? poseNames[pose]
                    : fetching
                      ? "通知を確認中"
                      : feed?.mode === "demo"
                        ? "DEMO・架空データ"
                        : "取得済みデータを振り返る"
                  : "本人ウォレットの認証が必要です"}
              </small>
            </div>
            <button onClick={close} aria-label="カブまるを閉じる">
              ×
            </button>
          </header>
          <div className="kabumaru-body">
            {!authenticated ? (
              <p>
                <Link to="/settings" onClick={close}>
                  設定画面で本人認証する →
                </Link>
              </p>
            ) : (
              <>
                <p className="kabumaru-info">
                  {feed?.note || "取得済みデータに基づいてお知らせします。"}{" "}
                  MemWal未接続時はローカルの根拠を表示します。
                </p>
                <StockPicker stocks={master} value={code} onChange={setCode} />
                <button
                  className="kabumaru-secondary"
                  onClick={() => setCode("")}
                >
                  ウォッチリスト全体を対象にする
                </button>
                <div className="kabumaru-questions">
                  {[
                    "ウォッチリストの注目銘柄を教えて",
                    "この銘柄の過去の分析と類似相場を振り返りたい",
                    "以前の予測と実際の結果を比較して",
                  ].map((q) => (
                    <button key={q} onClick={() => setQuestion(q)}>
                      {q}
                    </button>
                  ))}
                </div>
                <div className="kabumaru-notice-heading">
                  <h3>
                    お知らせ{" "}
                    {unread.length > 0 ? `・未読${unread.length}件` : ""}
                  </h3>
                  <button className="kabumaru-secondary" onClick={markRead}>
                    すべて既読にする
                  </button>
                </div>
                {notices.length === 0 && (
                  <p>
                    まだ通知はありません。株価未取得の場合、相場のお知らせは作りません。
                  </p>
                )}
                {notices.map((n) => (
                  <article
                    key={n.recordId}
                    className={"kabumaru-notice " + n.pose}
                  >
                    <img
                      src={asset(n.pose)}
                      alt={`カブまる ${poseNames[n.pose]}`}
                      width="42"
                      height="42"
                    />
                    <div>
                      <small>
                        {n.mode === "demo"
                          ? "DEMO・架空データ"
                          : n.mode.toUpperCase()}{" "}
                        · {n.dataAsOf} · {n.providerCode && displayStockCode(n.providerCode)}
                      </small>
                      <h4>{n.title}</h4>
                      <p>{n.text}</p>
                      <details>
                        <summary>数値と参照ID</summary>
                        <pre>
                          {JSON.stringify(
                            {
                              metrics: n.metrics,
                              evidenceIds: n.evidenceIds,
                              observedAt: n.observedAt,
                              source: n.source,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                      <Link
                        to={n.href}
                        onClick={() => {
                          markRead();
                          close();
                        }}
                      >
                        詳細分析へ →
                      </Link>
                    </div>
                  </article>
                ))}
                {events.map((event) => (
                  <article className="kabumaru-message" key={event.recordId}>
                    <h4>{event.question}</h4>
                    <p>{event.answer}</p>
                    <small>
                      {event.model} ·{" "}
                      {event.search === "memwal-semantic"
                        ? "MemWal意味検索"
                        : "ローカル根拠応答"}
                    </small>
                    {event.error && <p className="error">{event.error}</p>}
                    <details>
                      <summary>参照した記憶・データ</summary>
                      {event.evidence.map((e: any) => (
                        <div className="reference" key={e.recordId}>
                          <p>{e.text}</p>
                          <small>recordId: {e.recordId}</small>
                        </div>
                      ))}
                    </details>
                    <button
                      disabled={saving === event.recordId}
                      onClick={async () => {
                        setSaving(event.recordId);
                        try {
                          await request("/assistant/save-chat", {
                            eventId: event.recordId,
                          });
                          await queryClient.invalidateQueries({
                            queryKey: ["/memories"],
                          });
                          setError(
                            "会話をローカルへ保存しました。MemWal同期は接続・外部送信許可に従います。",
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setSaving("");
                        }
                      }}
                    >
                      この会話を記憶に保存
                    </button>
                  </article>
                ))}
                {busy && (
                  <p role="status">
                    {pose === "analyze"
                      ? "取得済みの数値を確認しているよ…"
                      : "記憶とデータを根拠に回答を考えているよ…"}
                  </p>
                )}
                {error && (
                  <p role="status" className="error">
                    {error}
                  </p>
                )}
                {feedError && <p className="error">{feedError.message}</p>}
              </>
            )}
          </div>
          {authenticated && (
            <form
              className="kabumaru-compose"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label htmlFor="kabumaru-question">カブまるへの質問</label>
              <textarea
                id="kabumaru-question"
                maxLength={3000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="証券コードや気になることを質問してね"
                disabled={busy}
              />
              <button disabled={busy || !question.trim()} type="submit">
                {busy ? "回答中…" : "カブまるに聞く"}
              </button>
            </form>
          )}
        </section>
      )}
      <button
        ref={launcher}
        className={"kabumaru-launcher pose-" + displayPose}
        aria-label={
          open ? "カブまるAIチャットを閉じる" : "カブまるAIチャットを開く"
        }
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <img
          src={asset(displayPose)}
          alt={`カブまる ${poseNames[displayPose]}`}
          width="112"
          height="112"
        />
        {unread.length > 0 && (
          <span
            className="kabumaru-badge"
            aria-label={`未読通知${unread.length}件`}
          >
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
        <span className="kabumaru-caption">カブまる</span>
      </button>
    </div>
  );
}
