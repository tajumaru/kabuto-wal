import { useState } from "react";
import { z } from "zod";
export function AgentMemoryPanel({
  id,
  request,
}: {
  id: string;
  request: (url: string, body?: unknown) => Promise<unknown>;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function act(kind: "memory" | "sync" | "recall") {
    setBusy(true);
    try {
      const r = await request(
        `/research/agent/sessions/${id}/${kind}`,
        kind === "memory" ? {} : { confirmExternal: true },
      );
      setMessage(
        kind === "memory"
          ? `ローカル記憶：${z.object({ status: z.string() }).parse(r).status}。外部送信はしていません。`
          : JSON.stringify(r),
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "処理できませんでした");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>研究記憶</h2>
      <p>正本はローカル。削除済み記憶は再生成・再送信しません。</p>
      <button disabled={busy} onClick={() => void act("memory")}>
        研究記憶をローカル保存
      </button>
      <label className="agent-check">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(e) => setConfirm(e.target.checked)}
        />
        利用者の別操作として今回のMemWal外部同期・検索を許可する
      </label>
      <button disabled={busy || !confirm} onClick={() => void act("sync")}>
        研究記憶をMemWal同期
      </button>
      <button disabled={busy || !confirm} onClick={() => void act("recall")}>
        MemWalを原本照合検索
      </button>
      <p>
        環境の送信許可・権利確認も必要です。エージェントはこの操作を呼べません。
      </p>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
