import { useState } from "react";
import {
  createDAppKit,
  DAppKitProvider,
  useDAppKit,
  useCurrentAccount,
} from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
const config = await (await fetch("/api/wallet-config")).json();
const network: "testnet" | "mainnet" =
  config.network === "testnet" ? "testnet" : "mainnet";
const kit = createDAppKit({
  networks: [network],
  createClient: (network) =>
    new SuiGrpcClient({
      network,
      baseUrl: config.endpoint,
    }),
});
export async function disconnectWallet() {
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const reason = result?.error === "Origin不一致"
      ? "画面のURLとサーバーのAPP_ORIGIN設定が一致していません。"
      : `サーバーがエラーを返しました（HTTP ${response.status}）。`;
    throw Error(`ログアウトできませんでした。${reason}`);
  }
  if (kit.stores.$connection.get().wallet) await kit.disconnectWallet();
  window.location.reload();
}
function Login() {
  const kit = useDAppKit(),
    account = useCurrentAccount(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="wallet-login">
      <div className="wallet-steps" aria-label="本人確認の流れ"><span><b>01</b> ウォレット接続</span><i aria-hidden="true">→</i><span><b>02</b> 署名で本人確認</span></div>
      <div className="wallet-connect-controls">
      <ConnectButton />
      {account && <button className="wallet-secondary" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await disconnectWallet();
        } catch (e) {
          setMessage((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>ウォレット接続解除</button>}
      </div>
      <p>
        {account
          ? "ウォレットは接続済みです。本人確認するには、下のボタンを押し、ウォレットに表示される署名リクエストを承認してください。"
          : "まずウォレットを接続してください。接続後、「本人確認を始める」を押し、ウォレットで署名を承認します。"}
      </p>
      <button
        className="wallet-verify"
        disabled={!account || busy}
        onClick={async () => {
          setBusy(true);
          setMessage("ウォレットを開いて、署名リクエストを承認してください。");
          try {
            const challenge = await (await fetch("/api/auth/challenge")).json();
            const signed = await kit.signPersonalMessage({
              message: new TextEncoder().encode(challenge.message),
            });
            const r = await fetch("/api/auth/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                nonce: challenge.nonce,
                signature: signed.signature,
              }),
            });
            const result = await r.json();
            if (!r.ok) throw Error(result.error);
            setMessage("本人認証が完了しました");
            window.location.reload();
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "ウォレットでの承認を待っています…" : "本人確認を始める"}
      </button>
      {message && <p className="wallet-feedback" role="status">{message}</p>}
      <div className="wallet-footer"><span>送金なし · ガス代なし · 認証は1時間有効</span><p>この操作はログインのための本人確認です。MemWalの連携設定は、本人確認後に「接続状態」で確認できます。</p></div>
    </div>
  );
}
export async function anchorPrediction(id: string) {
  if (network !== "testnet") throw Error("予測記録はtestnet限定です");
  const r = await fetch("/api/predictions/" + id + "/anchor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const p = await r.json();
  if (!r.ok) throw Error(p.error);
  const tx = new Transaction();
  tx.moveCall({
    target: `${p.packageId}::prediction_commitment::commit`,
    arguments: [
      tx.object(p.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(id))),
      tx.pure.vector("u8", Array.from(BufferlessHex(p.hash))),
      tx.pure.u64(p.generatedAt),
      tx.pure.vector(
        "u8",
        Array.from(new TextEncoder().encode(p.targetSessionDate)),
      ),
      tx.object("0x6"),
    ],
  });
  const result = await kit.signAndExecuteTransaction({ transaction: tx });
  if (result.FailedTransaction)
    throw Error(
      result.FailedTransaction.status.error?.message || "Sui取引失敗",
    );
  const digest = result.Transaction.digest;
  const client = new SuiGrpcClient({
    network: "testnet",
    baseUrl: config.endpoint,
  });
  const verified = await client.core.getTransaction({
    digest,
    include: { effects: true },
  });
  const transaction =
    "Transaction" in verified
      ? verified.Transaction
      : verified.FailedTransaction;
  if (!transaction) throw Error("取引結果未確認");
  const objects = transaction.effects?.changedObjects || [];
  let receiptId: string | undefined;
  for (const o of objects) {
    try {
      const { object } = await client.core.getObject({
        objectId: o.objectId,
        include: { json: true },
      });
      if (
        object.type ===
        `${p.packageId}::prediction_commitment::PredictionReceipt`
      ) {
        receiptId = object.objectId;
        break;
      }
    } catch {
      /* deleted/gas/registry */
    }
  }
  if (!receiptId)
    throw Error(
      "receiptが確認できません。再送せずtxDigestを確認してください：" + digest,
    );
  const response = await fetch("/api/predictions/" + id + "/receipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ receiptId, txDigest: digest }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
function BufferlessHex(hex: string) {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((v) => parseInt(v, 16)));
}
export default function Wallet() {
  return (
    <DAppKitProvider dAppKit={kit}>
      <Login />
    </DAppKitProvider>
  );
}
