import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

type Plan = { id: string; state: string; namespaces: { name: string; memory_count: number; state: string; deleted?: number; error?: string }[] };
async function request(action: string, body: unknown): Promise<Plan> {
  const response = await fetch(`/api/memory-reset/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "検索リセットを完了できませんでした。");
  return data;
}
export function MemoryReset({ authenticated }: { authenticated: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null), [confirmation, setConfirmation] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const queryClient = useQueryClient();
  async function run(execute: boolean) {
    setBusy(true); setError("");
    try {
      const result = await request(execute ? "execute" : "preview", execute ? { planId: plan!.id, confirmation } : {});
      setPlan(result); setConfirmation("");
      if (execute) void queryClient.invalidateQueries({ queryKey: ["/memories"] });
    } catch (e) {
      setError(execute ? `${(e as Error).message} 完了したか不明な場合は「対象を確認」で現在の件数を確認してください。` : (e as Error).message);
      if (execute) setPlan(null);
    } finally { setBusy(false); }
  }
  return <section className="card" aria-label="MemWal検索リセット">
    <h2>MemWalの検索用データをリセット</h2>
    <p>このウォレットの全保存区分を対象に、MemWalの検索用データを消します。他のアプリから保存した記憶も対象に含まれます。</p>
    <p>Walrus上の暗号化された原本は残ります。restore（索引の復元）を実行すると検索に戻ります。新しい記憶の保存によっても検索用データが増えます。</p>
    <p>このアプリ内の記録は引き続き参照できます。対象区分の既存記録は自動でMemWalへ再送しません。</p>
    {!authenticated && <p>実モードで本人確認を完了すると利用できます。</p>}
    <button disabled={!authenticated || busy} onClick={() => void run(false)}>{busy ? "MemWalに確認中…" : "対象を確認"}</button>
    {plan && <>
      <p>保存区分：{plan.namespaces.length}件 · 確認時の検索用データ：{plan.namespaces.reduce((sum, ns) => sum + ns.memory_count, 0)}件</p>
      {plan.namespaces.length > 0 && <div className="tablewrap"><table><thead><tr><th>保存区分</th><th>件数</th><th>実行結果</th></tr></thead><tbody>{plan.namespaces.map((ns) => <tr key={ns.name}><td style={{ overflowWrap: "anywhere" }}>{ns.name}</td><td>{ns.memory_count}</td><td>{ns.state === "completed" ? `${ns.deleted}件削除・0件を確認` : ns.state === "failed" ? ns.error : "未実行"}</td></tr>)}</tbody></table></div>}
      {plan.state === "prepared" && plan.namespaces.length > 0 && <>
        <label>上記すべての検索用データを消す場合は「検索リセット」と入力してください。
          <input aria-label="検索リセットの確認" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <button disabled={busy || !authenticated || confirmation !== "検索リセット"} onClick={() => void run(true)}>確認した全区分の検索用データをリセット</button>
      </>}
      {plan.state === "completed" && <p role="status">確認した全区分の検索リセットが完了しました。Walrus上の原本は残っています。</p>}
      {plan.state === "partial" && <p role="alert">検索リセットは未完了です。上の実行結果を確認し、「対象を確認」から現在の件数を確認し直してください。</p>}
      {plan.state === "prepared" && plan.namespaces.length === 0 && <p role="status">このアカウントの検索用データは0件です。</p>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
