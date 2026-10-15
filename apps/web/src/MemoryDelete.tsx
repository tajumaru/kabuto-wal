import { useEffect, useRef, useState } from "react";
import { createDAppKit, DAppKitProvider, useDAppKit, useCurrentAccount } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { MemoryDeletePreview } from "./MemoryContent";

type Config = { enabled: boolean; owner?: string; network: "mainnet" | "testnet" | null };
type Props = { memory: any; stocks: any[]; onDone: () => void; onClose: () => void };
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
  const [deleted, setDeleted] = useState(memory.sync?.status === "deleted");
  const endpoint = `memories/${memory.recordId}/remote-delete/`;
  const [canCancel, setCanCancel] = useState(memory.sync?.remoteDeletion?.state === "awaiting_signature");
  async function run(checkOnly: boolean, cancel = false) {
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
        hasBatch = true; setCanCancel(true);
        setMessage("2/2：削除対象を確認できました。ウォレットで削除取引の署名を承認してください。");
        const transaction = Transaction.from(prepared.txBytes);
        const signedTx = await kit.signTransaction({ transaction });
        setCanCancel(false);
        setMessage("削除取引を送信し、結果を確認中…");
        result = await request(endpoint + "submit", { token, signature: signedTx.signature });
      }
      if (result.state === "completed") {
        setDeleted(true); setMessage("MemWalから削除しました。アプリ内の記録は残し、利用停止にしました。"); onDone();
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
    <h3>MemWalから削除</h3>
    <MemoryDeletePreview memory={memory} stocks={stocks} />
    <p>MemWal上の記憶を削除します。元に戻せません。アプリ内の記録は残ります。「無効化」だけならウォレット署名は不要です。</p>
    <p>署名は本人確認と削除取引の2段階です。本人確認に成功しても、MemWal側でこの記憶が削除対象に含まれない場合は削除できません。</p>
    <p>ネットワーク：{config.network} · 他の端末や取得済みコピーの削除は保証されません。</p>
    <ConnectButton />
    {!ownerMatches && <p>このアプリの所有者ウォレットを接続してください。</p>}
    {!pending && !deleted && <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />内容を確認し、この記憶をMemWalから削除します</label>}
    <div className="toolbar">
      {!deleted && <button disabled={busy || !ownerMatches || (!pending && !confirmed)} onClick={() => void run(pending)}>{busy ? "ウォレット承認・結果確認中…" : pending ? "削除結果を確認" : "署名してMemWalから削除"}</button>}
      {pending && canCancel && !deleted && <button disabled={busy || !ownerMatches} onClick={() => void run(true, true)}>署名前の削除を中止</button>}
      <button disabled={busy} onClick={onClose}>閉じる</button>
    </div>
    <p role="status">{message}</p>
  </section>;
}
export default function MemoryDelete(props: Props) {
  const [setup, setSetup] = useState<{ config: Config; kit: ReturnType<typeof makeKit> }>();
  const [error, setError] = useState("");
  // Fetch only when this explicit deletion panel is opened; secrets stay server-side.
  useEffect(() => {
    let active = true;
    void request("memory-delete/config").then((config: Config) => {
      if (!config.enabled || !config.network) throw Error("削除には実モードとMEMWAL_NETWORK（mainnet/testnet）の設定が必要です。");
      const network = config.network;
      if (active) setSetup({ config, kit: makeKit(network) });
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  if (!setup) return <div className="card"><p role="status">{error || "削除設定を確認中…"}</p><button onClick={props.onClose}>閉じる</button></div>;
  return <DAppKitProvider dAppKit={setup.kit}><DeleteForm {...props} config={setup.config} /></DAppKitProvider>;
}
function makeKit(network: "mainnet" | "testnet") {
  return createDAppKit({ networks: [network], createClient: (selectedNetwork) => new SuiGrpcClient({ network: selectedNetwork, baseUrl: `https://fullnode.${selectedNetwork}.sui.io:443` }) });
}
