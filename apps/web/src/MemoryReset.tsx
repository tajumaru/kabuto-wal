import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

type Plan = { id: string; state: string; namespaces: { name: string; memory_count: number; state: string; deleted?: number; error?: string }[] };
async function request(action: string, body: unknown): Promise<Plan> {
  const response = await fetch(`/api/memory-reset/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "検索リセットを完了できませんでした。");
  return data;
}
export function MemoryReset({ authenticated, memoryId }: { authenticated: boolean; memoryId?: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null), [confirmation, setConfirmation] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const queryClient = useQueryClient();
  async function run(execute: boolean) {
    setBusy(true); setError("");
    try {
      const result = await request(execute ? "execute" : "preview", execute ? { planId: plan!.id, confirmation, namespaces: selected } : memoryId ? { memoryId } : {});
      if (!execute) setSelected(memoryId ? result.namespaces.map(ns => ns.name) : []);
      setPlan(result); setConfirmation("");
      if (execute) void queryClient.invalidateQueries({ queryKey: ["/memories"] });
    } catch (e) {
      setError(execute ? `${(e as Error).message} 完了したか不明な場合は「対象を確認」で現在の件数を確認してください。` : (e as Error).message);
      if (execute) setPlan(null);
    } finally { setBusy(false); }
  }
  return <section className="card" aria-label="MemWal検索リセット">
    <h2>MemWalの検索結果から記憶を外す</h2>
    <p>MemWalが記憶を探すためのデータ（検索索引）を削除します。このアプリ内の記録は残り、引き続き読めます。</p>
    <div className="reset-scope-note">
      <strong>この記憶1件だけを外す操作ではありません</strong>
      <p>{memoryId ? "この記憶が入っているグループ（保存区分）を表示します。" : "対象のグループ（保存区分）を選んでください。"}選んだグループ内の記憶が、まとめてMemWalの検索対象から外れます。他のアプリで保存した記憶も、同じグループにあれば含まれます。</p>
    </div>
    <p>まず「対象を確認」で、グループと件数を確認してください。この時点では削除しません。</p>
    <details className="reset-details"><summary>原本と、検索に戻る場合について</summary>
      <p>この操作では、Walrusに保存された原本は削除しません。すでに削除済みの原本が戻ることもありません。</p>
      <p>原本が残っている記憶は、別途、検索索引の復元を行うと再び検索できるようになります。このアプリが既存の記録を自動で再送することはありません。新しく保存した記憶は、検索対象に追加されます。</p>
    </details>
    {!authenticated && <p>実モードで本人確認を完了すると利用できます。</p>}
    <button disabled={!authenticated || busy} onClick={() => void run(false)}>{busy ? "MemWalに確認中…" : "対象を確認"}</button>
    {plan && <>
      <p>保存区分：{plan.namespaces.length}件 · 確認時の検索用データ：{plan.namespaces.reduce((sum, ns) => sum + ns.memory_count, 0)}件</p>
      {plan.namespaces.length > 0 && <div className="tablewrap"><table><thead><tr><th>選択</th><th>保存区分</th><th>件数</th><th>実行結果</th></tr></thead><tbody>{plan.namespaces.map((ns) => <tr key={ns.name}><td><input type="checkbox" aria-label={`削除する区分 ${ns.name}`} checked={selected.includes(ns.name)} disabled={busy || plan.state !== "prepared"} onChange={e => { setConfirmation(""); setSelected(e.target.checked ? [...selected, ns.name] : selected.filter(name => name !== ns.name)); }} /></td><td style={{ overflowWrap: "anywhere" }}>{ns.name}</td><td>{ns.memory_count}</td><td>{ns.state === "completed" ? `${ns.deleted}件削除・0件を確認` : ns.state === "failed" ? ns.error : "未実行"}</td></tr>)}</tbody></table></div>}
      {plan.state === "prepared" && plan.namespaces.length > 0 && <>
        <p>選択中：{selected.length}区分・{plan.namespaces.filter(ns => selected.includes(ns.name)).reduce((sum, ns) => sum + ns.memory_count, 0)}件</p>
        <label>選択した区分の検索索引を削除する場合は「検索リセット」と入力してください。
          <input aria-label="検索リセットの確認" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <button disabled={busy || !authenticated || !selected.length || confirmation !== "検索リセット"} onClick={() => void run(true)}>選択した区分の検索索引を削除</button>
      </>}
      {plan.state === "completed" && <p role="status">選択した区分の検索索引削除が完了しました。Walrus上の原本を削除する操作は行っていません。</p>}
      {plan.state === "partial" && <p role="alert">検索リセットは未完了です。上の実行結果を確認し、「対象を確認」から現在の件数を確認し直してください。</p>}
      {plan.state === "prepared" && plan.namespaces.length === 0 && <p role="status">{memoryId ? "対象区分の検索索引は見つかりません。" : "このアカウントの検索用データは0件です。"}</p>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
