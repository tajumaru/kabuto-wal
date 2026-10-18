import { useState } from "react";
import { z } from "zod";
import {
  agentAttestationSchema,
  agentAttestationNetworkSchema,
} from "../../../packages/core/kabumaru-agent-attestation";
export function AgentSuiAttestation({
  id,
  request,
}: {
  id: string;
  request: (url: string, body?: unknown) => Promise<unknown>;
}) {
  const [network, setNetwork] = useState<"local" | "testnet" | "mainnet">(
      "local",
    ),
    [hash, setHash] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function act(verify: boolean) {
    setBusy(true);
    try {
      if (verify) {
        const r = z
          .object({
            localVerified: z.boolean(),
            chainVerified: z.literal(false),
          })
          .parse(
            await request(`/research/agent/sessions/${id}/attestation/verify`, {
              network,
              manifestHash: hash,
            }),
          );
        setMessage(
          r.localVerified
            ? "ローカル原本のhashと対象が一致しました。チェーン上の検証は未実施です。"
            : "hashまたは対象ネットワークが一致しません。",
        );
      } else {
        const r = agentAttestationSchema.parse(
          await request(
            `/research/agent/sessions/${id}/attestation?network=${network}`,
          ),
        );
        setHash(r.manifestHash);
        setMessage(
          "ローカルの研究証跡を生成しました。送信・署名は行いません。",
        );
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "照合できませんでした");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Sui研究証跡</h2>
      <p>
        初期状態はローカルhashのみ。専用の安全な署名・gas見積・チェーン照合フローは未実装のため、送信機能はありません。
      </p>
      <label>
        証跡の対象
        <select
          aria-label="証跡の対象"
          value={network}
          onChange={(e) => {
            setNetwork(agentAttestationNetworkSchema.parse(e.target.value));
            setHash("");
            setMessage("");
          }}
        >
          <option value="local">ローカルのみ</option>
          <option value="testnet">testnet向けローカル証跡</option>
          <option value="mainnet">mainnet向けローカル証跡</option>
        </select>
      </label>
      <p>トランザクション：未作成 ／ gas見積：未対応 ／ digest：未送信</p>
      <button disabled={busy} onClick={() => void act(false)}>
        研究manifest hashを生成
      </button>
      <label>
        照合するhash
        <input
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          maxLength={64}
        />
      </label>
      <button
        disabled={busy || !/^[a-f0-9]{64}$/.test(hash)}
        onClick={() => void act(true)}
      >
        ローカル原本と照合
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
