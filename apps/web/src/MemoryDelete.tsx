import { useEffect, useRef, useState } from "react";
import { createDAppKit, DAppKitProvider, useDAppKit, useCurrentAccount } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { MemoryDeletePreview } from "./MemoryContent";
import { MemoryReset } from "./MemoryReset";

type Config = { enabled: boolean; owner?: string; network: "mainnet" | "testnet" | null; endpoint?: string };
type Props = { memory: any; stocks: any[]; onDone: (sync?: any) => void; onClose: () => void };
function isBlobDeleted(memory: any) {
  return memory.sync?.status === "deleted" || !!memory.remoteDeletedAt || memory.sync?.directWalrusDeletion?.state === "completed" || memory.sync?.remoteDeletion?.state === "completed";
}
function DeleteHeading({ deleted = false }: { deleted?: boolean }) {
  return <header className="delete-zone-heading">
    <span className="delete-zone-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg></span>
    <div><p className="delete-zone-label">削除操作エリア</p><h3>{deleted ? "削除済みデータの確認・検索からの削除" : "保存データ・検索からの削除"}</h3></div>
  </header>;
}
async function request(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => { throw Error("アプリのサーバーに接続できません。サーバーの起動状態を確認してください。削除取引に署名済みの場合は、接続復旧後に「削除結果を確認」を使ってください。"); });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "削除処理に失敗しました。");
  return data;
}
function DeleteForm({ memory, stocks, onDone, onClose, config }: Props & { config: Config }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);
  const kit = useDAppKit(), account = useCurrentAccount();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(!!memory.sync?.remoteDeletion && !["failed", "rolled_back"].includes(memory.sync.remoteDeletion.state));
  const [deleted, setDeleted] = useState(isBlobDeleted(memory));
  const blobDeleted = deleted || isBlobDeleted(memory);
  const endpoint = `memories/${memory.recordId}/remote-delete/`;
  const batchId = useRef(memory.sync?.remoteDeletion?.batchId);
  const [canCancel, setCanCancel] = useState(memory.sync?.remoteDeletion?.state === "awaiting_signature");
  async function run(checkOnly: boolean, cancel = false) {
    if (blobDeleted && !checkOnly) return;
    setBusy(true); setMessage("");
    let hasBatch = pending;
    try {
      setMessage("MemWalの本人確認を準備中…");
      const challenge = await request(endpoint + "challenge", {});
      setMessage("1/2：ウォレットで本人確認のメッセージ署名を承認してください。この署名だけでは記憶は削除されません。");
      const signed = await kit.signPersonalMessage({ message: new TextEncoder().encode(challenge.challenge) });
      const { token } = await request(endpoint + "verify", { challengeId: challenge.challengeId, signature: signed.signature });
      let result;
      setMessage(checkOnly ? "削除結果を確認中…" : "本人確認済み。MemWalの削除対象一覧で、この記憶を確認中…");
      if (checkOnly) result = await request(endpoint + (cancel ? "cancel" : "status"), { token });
      else {
        // From this point on, a failed network request requires reconciliation, not a new batch.
        setPending(true);
        const prepared = await request(endpoint + "prepare", { token });
        batchId.current = prepared.batchId;
        hasBatch = true; setCanCancel(true);
        setMessage("2/2：削除対象を確認できました。ウォレットで削除取引の署名を承認してください。");
        const transaction = Transaction.from(prepared.txBytes);
        const signedTx = await kit.signTransaction({ transaction });
        setCanCancel(false);
        setMessage("削除取引を送信し、結果を確認中…");
        result = await request(endpoint + "submit", { token, signature: signedTx.signature });
      }
      if (result.state === "completed" && result.searchVerification?.state !== "not_observed") {
        setPending(true); setCanCancel(false); setMessage(result.searchVerification?.note || "削除取引は完了しました。検索結果からの消失は未確認です。削除結果を再確認してください。"); onDone({ status: "deleted", remoteDeletion: { batchId: batchId.current, ...result } });
      } else if (result.state === "completed") {
        setDeleted(true); setMessage("削除取引が完了しました。今回の上位50件の検索では対象blobは未検出です。検索索引全体からの消失は未確認です。アプリ内の記録は残し、利用停止にしました。"); onDone({ status: "deleted", remoteDeletion: { batchId: batchId.current, ...result } });
      } else if (["failed", "rolled_back"].includes(result.state)) {
        setPending(false); setMessage("削除は完了しませんでした。対象を確認して再度お試しください。");
      } else {
        setCanCancel(result.state === "awaiting_signature");
        setPending(true); setMessage(result.note || "削除は未完了です。しばらくしてから削除結果を確認してください。署名を中止した場合は、準備した処理の期限が切れるまでお待ちください。");
      }
    } catch (error) { setPending(hasBatch); setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  const ownerMatches = !!account && account.address.toLowerCase() === config.owner?.toLowerCase();
  return <section ref={panel} tabIndex={-1} className="card memory-delete" aria-label="MemWalから記憶を削除">
    <DeleteHeading deleted={blobDeleted} />
    <MemoryDeletePreview memory={memory} stocks={stocks} />
    <p>MemWal上の記憶を削除します。元に戻せません。アプリ内の記録は残ります。「無効化」だけならウォレット署名は不要です。</p>
    <p>署名は本人確認と削除取引の2段階です。削除APIは旧V1の追跡済みblob専用で、現在の保存APIで作成した記憶は対象外の場合があります。名前空間全体の検索リセットは別の操作です。</p>
    <p>ネットワーク：{config.network} · 他の端末や取得済みコピーの削除は保証されません。</p>
    <ConnectButton />
    {!ownerMatches && <p>このアプリの所有者ウォレットを接続してください。</p>}
    {blobDeleted && <p role="status">Walrusのblob削除済みです。新しい削除操作はできません。既存取引の結果確認と検索索引の確認は別に行えます。</p>}
    {!pending && !blobDeleted && <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />内容を確認し、この記憶をMemWalから削除します</label>}
    <div className="toolbar">
      {(!blobDeleted || pending) && <button className={pending ? "delete-primary" : "delete-danger"} disabled={busy || !ownerMatches || (!pending && !confirmed)} onClick={() => void run(pending)}>{busy ? "ウォレット承認・結果確認中…" : pending ? "削除結果を確認" : "署名してMemWalから削除"}</button>}
      {pending && canCancel && <button disabled={busy || !ownerMatches} onClick={() => void run(true, true)}>署名前の削除を中止</button>}
      <button className="delete-close" disabled={busy} onClick={onClose}>閉じる</button>
    </div>
    <p role="status">{message}</p>
  </section>;
}
function DirectDeleteForm({ memory, stocks, onDone, onClose, config }: Props & { config: Config }) {
  const kit = useDAppKit(), account = useCurrentAccount();
  const original = memory.sync?.directWalrusDeletion;
  const [state, setState] = useState(isBlobDeleted(memory) ? "completed" : original?.state || "idle");
  const [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false), [message, setMessage] = useState("");
  const [plan, setPlan] = useState<any>(original);
  const [showReset, setShowReset] = useState(false);
  const [indexState, setIndexState] = useState<"checking" | "present" | "absent" | "error">("checking");
  const [indexCheck, setIndexCheck] = useState(0);
  useEffect(() => {
    let active = true;
    setIndexState("checking");
    void request("memory-reset/availability", { memoryId: memory.recordId })
      .then(result => { if (active) { setIndexState(result.available ? "present" : "absent"); if (!result.available) setShowReset(false); } })
      .catch(() => { if (active) setIndexState("error"); });
    return () => { active = false; };
  }, [memory.recordId, memory.sync, indexCheck]);
  const blobDeleted = isBlobDeleted(memory) || state === "completed";
  const matches = !!account && account.address.toLowerCase() === config.owner?.toLowerCase();
  const endpoint = `memories/${memory.recordId}/blob-delete/`;
  async function run(action: "prepare" | "submit" | "status" | "cancel") {
    if (blobDeleted && (action === "prepare" || action === "submit")) return;
    setBusy(true); setMessage("");
    try {
      let result;
      if (action === "submit") {
        const signed = await kit.signTransaction({ transaction: Transaction.from(plan.txBytes) });
        // The backend executes only its prepared bytes and verifies the owner signature.
        setState("executing");
        result = await request(endpoint + "submit", { planId: plan.id, signature: signed.signature });
      } else result = await request(endpoint + action, {});
      setState(result.state); if (action === "prepare") setPlan(result);
      setMessage(result.note || (result.state === "awaiting_signature" ? "対象blobを照合し、削除取引の事前検証が完了しました。対象オブジェクトを確認して署名してください。" : result.state === "failed" ? "取引が失敗しました。再準備できます。" : result.state === "cancelled" ? "未送信の準備を中止しました。" : ""));
      if (result.state === "completed") onDone();
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="card memory-delete" aria-label="MemWalから記憶を削除">
    <DeleteHeading deleted={blobDeleted} />
    <MemoryDeletePreview memory={memory} stocks={stocks} />
    {!blobDeleted && <p><strong>保存データを消す：</strong>Walrusに保存したこの記憶を削除します。元に戻せません。実行にはウォレットでの承認と、SUIの手数料が必要です。</p>}
    {indexState === "present" && <p><strong>検索に出ないようにする：</strong>この保存区分にはMemWalの検索索引があります。検索からも消したい場合は、下の「保存区分の検索索引削除」を使ってください。</p>}
    <p>どちらを実行しても、このアプリ内の記録は残ります。</p>
    <details><summary>削除できる範囲について</summary><p>取得済みのコピーやキャッシュは、これらの操作では消去を保証できません。</p></details>
    <ConnectButton />
    {!matches && <p>このアプリの所有者ウォレットを接続してください。</p>}
    {blobDeleted ? <p role="status">Walrusのblob削除済みです。</p> : <>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />内容を確認し、このblobを削除します</label>
      {!["awaiting_signature", "executing"].includes(state) && <button disabled={busy || !matches || !confirmed} onClick={() => void run("prepare")}>対象blobと削除取引を確認</button>}
      {["awaiting_signature", "executing"].includes(state) && plan?.txBytes && <>
        <p style={{ overflowWrap: "anywhere" }}>対象オブジェクト：{plan?.objectId}</p>
        <p>署名期限：{plan?.expiresAt ? new Date(plan.expiresAt).toLocaleString("ja-JP") : "不明"}</p>
        {state === "executing" && <p>送信結果が不明な場合は、まず結果を確認してください。再送は保存済みの同じ取引だけを使用します。</p>}
        <button className="delete-danger" disabled={busy || !matches || !confirmed} onClick={() => void run("submit")}>{state === "executing" ? "同じ削除取引に署名して再送" : "署名してblobを削除"}</button>
        {state === "awaiting_signature" && <button disabled={busy} onClick={() => void run("cancel")}>署名前の削除を中止</button>}
      </>}
    </>}
    {(plan?.digest || original?.digest) && <button className="delete-primary" disabled={busy} onClick={() => void run("status")}>削除結果を確認</button>}
    <p role="status">{busy ? "処理中・ウォレット承認待ち…" : message}</p>
    <div className="delete-footer">
    {indexState === "present" && <button aria-expanded={showReset} disabled={busy} onClick={() => setShowReset(!showReset)}>保存区分の検索索引削除を{showReset ? "閉じる" : "開く"}</button>}
    {indexState === "checking" && <span role="status">MemWalの検索索引を確認中…</span>}
    {indexState === "absent" && <span role="status">この保存区分の検索索引はありません。</span>}
    {indexState === "error" && <span role="status">検索索引の有無を確認できませんでした。<button disabled={busy} onClick={() => setIndexCheck(n => n + 1)}>再確認</button></span>}
    <button className="delete-close" disabled={busy} onClick={onClose}>閉じる</button>
    </div>
    {showReset && indexState === "present" && <MemoryReset authenticated={matches} memoryId={memory.recordId} onCompleted={() => setIndexCheck(n => n + 1)} />}
  </section>;
}
export default function MemoryDelete(props: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [legacy, setLegacy] = useState(false);
  const [completed, setCompleted] = useState(isBlobDeleted(props.memory));
  const [updatedSync, setUpdatedSync] = useState<any>();
  const blobDeleted = completed || isBlobDeleted(props.memory);
  const sync = { ...props.memory.sync, ...updatedSync };
  const hasLegacyBatch = !!sync.remoteDeletion?.batchId;
  const formProps = { ...props, memory: { ...props.memory, sync: { ...sync, ...(blobDeleted ? { status: "deleted" } : {}) } }, onDone: (result?: any) => { setCompleted(true); if (result) setUpdatedSync(result); props.onDone(); } };
  const [setup, setSetup] = useState<{ config: Config; kit: ReturnType<typeof makeKit> }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!setup || !area.current) return;
    area.current.focus({ preventScroll: true });
    area.current.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, [setup, props.memory]);
  // Fetch only when this explicit deletion panel is opened; secrets stay server-side.
  useEffect(() => {
    let active = true;
    void request("memory-delete/config").then((config: Config) => {
      if (!config.enabled || !config.network) throw Error("削除には実モードとMEMWAL_NETWORK（mainnet/testnet）の設定が必要です。");
      const network = config.network;
      if (active) setSetup({ config, kit: makeKit(network, config.endpoint) });
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  if (!setup) return <div className="card"><p role="status">{error || "削除設定を確認中…"}</p><button onClick={props.onClose}>閉じる</button></div>;
  return <div ref={area} tabIndex={-1} className="memory-delete-area"><DAppKitProvider dAppKit={setup.kit}>
    {(!blobDeleted || hasLegacyBatch) && <label><input type="checkbox" checked={legacy} onChange={e => setLegacy(e.target.checked)} />{blobDeleted ? "旧V1の削除取引の結果を確認する" : "旧V1のSecurity Delete APIを使用する"}</label>}
    {legacy && (!blobDeleted || hasLegacyBatch) ? <DeleteForm {...formProps} config={setup.config} /> : <DirectDeleteForm {...formProps} config={setup.config} />}
  </DAppKitProvider></div>;
}
function makeKit(network: "mainnet" | "testnet", endpoint?: string) {
  return createDAppKit({ networks: [network], createClient: (selectedNetwork) => new SuiGrpcClient({ network: selectedNetwork, baseUrl: endpoint || `https://fullnode.${selectedNetwork}.sui.io:443` }) });
}
