import { MemWal } from "@mysten-incubation/memwal";
import { projectDejavuMemory } from "../core/dejavu-memory";
import { memwalEnvironment, memwalBinding } from "./memwal-config";

import { isCauseQuestion } from "../core/question";
import { randomUUID } from "node:crypto";
import { isPredictionEvidence } from "../core/chat-evidence";
import type { Bar } from "../core/index";
import type { Store } from "../storage/index";
import { normalizeSuiAddress } from "@mysten/sui/utils";
export interface MarketDataProvider {
  daily(code: string, from: string, to: string): Promise<Bar[]>;
}
export interface MemoryProvider {
  environmentBinding?: string;
  remember(text: string, namespace: string, options?: { idempotencyKey: string }): Promise<{ job_id: string }>;
  getRememberStatus?(id: string): Promise<{ job_id: string; status: string; blob_id?: string; owner?: string; namespace?: string }>;
  waitForRememberJob(id: string): Promise<{ blob_id: string; namespace?: string; owner?: string }>;
  recall(params: {
    query: string;
    namespace: string;
    limit: number;
  }): Promise<{ results: { text: string; distance: number; blob_id?: string }[] }>;
}
export interface LlmProvider {
  answer(
    question: string,
    evidence: { recordId: string; text: string }[],
  ): Promise<{ answer: string; references: string[] }>;
}
export async function requestJson(
  url: string,
  headers: Record<string, string> = {},
  fetcher: typeof fetch = fetch,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429 && attempt < 3) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            10000,
            Number(r.headers.get("retry-after") || 1) * 1000 * 2 ** attempt,
          ),
        ),
      );
      continue;
    }
    if (!r.ok) throw Error(`外部API HTTP ${r.status}`);
    return r.json();
  }
  throw Error("レート制限");
}
export { JQuants } from "./jquants";
export function memwal(): MemoryProvider | null {
  if (!process.env.MEMWAL_ACCOUNT_ID || !process.env.MEMWAL_DELEGATE_KEY)
    return null;
  const environment = memwalEnvironment();
  return Object.assign(MemWal.create({
    key: process.env.MEMWAL_DELEGATE_KEY,
    accountId: process.env.MEMWAL_ACCOUNT_ID,
    serverUrl: environment.serverUrl,
    namespace: "kabutowal:v1:profile",
  }), { environmentBinding: memwalBinding() });
}
export async function syncMemories(
  store: Store,
  provider: MemoryProvider | null,
  allowMarket: boolean,
  onlyIds?: string[],
) {
  const summary = { connected: !!provider, synced: 0, accepted: 0, failed: 0, uncertain: 0, skipped: 0 };
  if (!provider) return summary;
  for (const memory of await store.all("memories")) {
    if (onlyIds && !onlyIds.includes(memory.recordId)) continue;
    if (["notebook_research_summary","lab_experiment_summary"].includes(memory.kind) && memory.externalConsent !== true) { summary.skipped++; continue; }
    if (["hunter_reflection", "hunter_research_summary", "notebook_research_summary","lab_experiment_summary"].includes(memory.kind) &&
      (process.env.ALLOW_MARKET_DATA_TO_MEMWAL !== "true" || process.env.JQUANTS_MEMWAL_RIGHTS_CONFIRMED !== "true")) {
      summary.skipped++; continue;
    }
    if (!memory.active || (memory.kind !== "user_memory" && !allowMarket))
      continue;
    const key = `sync/${memory.recordId}.json`;
    const state = await store.read(key, { status: "pending" });
    if (["deleted","disabled"].includes(state.status) || state.remoteDeletion || state.searchResetAt || state.blobDeletedAt || state.directWalrusDeletion || memory.remoteDeletedAt) { summary.skipped++; continue; }
    try {
      await verifyMemoryBinding(store, key, state, memory, provider);
      if (state.status === "synced") { summary.skipped++; continue; }
      if (state.status === "failed" && state.terminal) { summary.failed++; continue; }
      // Old uncertain writes have no durable idempotency key. Never guess and replay them.
      if (["submitting", "uncertain"].includes(state.status) && !state.jobId && !state.idempotencyKey) {
        await store.write(key, { ...state, status: "uncertain", errorCode: "LEGACY_WRITE_UNCERTAIN", error: "旧送信の受付結果が不明です。自動再送を停止しています。" });
        summary.uncertain++; continue;
      }
      let jobId = state.jobId;
      if (!jobId) {
        const namespace = state.namespace || memory.namespace.replace(/^stock-memory:/, "kabutowal:");
        const idempotencyKey = state.idempotencyKey || randomUUID();
        const projection=memory.kind==="lab_experiment_summary"?Object.fromEntries(["recordId","runId","experimentId","methodVersion","parameters","candidateThreshold","hypothesis","period","stage","comparisons","evidenceId","reportId","adoptionStatus","warnings"].map(key=>[key,memory[key]])):memory.kind==="notebook_research_summary"?Object.fromEntries(["recordId","notebookId","theme","conditionCodes","period","cohortIds","outcomes","evidenceIds","methodVersion","warnings","displayedSuccessExamples","displayedFailureExamples"].map(key=>[key,memory[key]])):projectDejavuMemory({...memory,namespace});
        const pendingText = state.pendingText || JSON.stringify(projection);
        await store.write(key, { ...state, status: "submitting", namespace, idempotencyKey, pendingText, environmentBinding: provider.environmentBinding });
        const accepted = await provider.remember(
          pendingText,
          namespace,
          { idempotencyKey },
        );
        jobId = accepted.job_id;
        if (!jobId) throw Error("受付job IDがありません");
        await store.write(key, { ...(await store.read(key)), status: "accepted", jobId });
      }
      if (provider.getRememberStatus) {
        const job = await provider.getRememberStatus(jobId);
        if (job.status === "failed" || job.status === "not_found") {
          const current = await store.read(key);
          const failed = job.status === "failed";
          await store.write(key, {
            ...current,
            status: failed ? "failed" : "uncertain",
            blobId: job.blob_id || current.blobId,
            terminal: failed,
            errorCode: failed ? "JOB_FAILED" : "JOB_NOT_FOUND",
            error: !failed ? "受付ジョブを確認できません。新規送信は停止しています。"
              : job.blob_id ? "保存ジョブは失敗しましたがblob IDが報告されています。原本の状態を確認するまで新規送信を停止します。"
                : "保存ジョブが失敗しました。確認後に再試行できます。",
          });
          if (job.status === "failed") summary.failed++; else summary.uncertain++;
          continue;
        }
      }
      const result = await provider.waitForRememberJob(jobId);
      if (!result.blob_id) throw Error("MemWal保存完了のblob IDが未確認");
      await store.write(key, {
        ...(await store.read(key)),
        status: "synced",
        jobId,
        blobId: result.blob_id,
        namespace: result.namespace || memory.namespace.replace(/^stock-memory:/, "kabutowal:"),
        environmentBinding: provider.environmentBinding,
        error: undefined, errorCode: undefined, terminal: undefined,
        pendingText: undefined,
      });
      summary.synced++;
    } catch (e) {
      const current = await store.read(key, state);
      const status = (e as { status?: number }).status;
      const rejected = !current.jobId && [400, 401, 403, 422, 429].includes(status || 0);
      const bindingError = e instanceof MemoryBindingError;
      const next = bindingError ? "uncertain" : rejected ? "failed" : current.jobId ? "accepted" : "uncertain";
      await store.write(key, {
        ...current, status: next,
        errorCode: bindingError ? "ENVIRONMENT_UNVERIFIED" : rejected ? `HTTP_${status}` : current.jobId ? "JOB_PENDING" : "WRITE_UNCERTAIN",
        error: bindingError ? "保存先を検証できません。owner・namespace・blobと接続設定を確認してください。" : rejected ? `保存リクエストが拒否されました（HTTP ${status}）。設定・制限を確認後、同じ受付キーで再試行します。` : "同期未完了。既知jobを追跡し、受付不明の送信は保存済みの同じ受付キーだけで再試行します。",
      });
      summary[next]++;
    }
  }
  return summary;
}
export function syncWarning(summary: Awaited<ReturnType<typeof syncMemories>>) {
  return !summary.connected ? "MemWal未接続。記録はローカルに保存されています。" : summary.failed || summary.uncertain || summary.accepted
    ? `MemWal同期未完了：失敗 ${summary.failed}件・結果不明 ${summary.uncertain}件・受付中 ${summary.accepted}件。記憶の保存状態を確認してください。` : undefined;
}

class MemoryBindingError extends Error {}
// Existing remote receipts must be proven against this authenticated account before adoption.
export async function verifyMemoryBinding(store: Store, key: string, state: any, memory: any, provider: MemoryProvider) {
  if (!provider.environmentBinding) return; // Injected local/test providers have no remote environment.
  if (state.environmentBinding) {
    if (state.environmentBinding !== provider.environmentBinding) throw new MemoryBindingError();
    return;
  }
  if (!state.jobId && !state.blobId) {
    if (["submitting", "uncertain"].includes(state.status)) throw new MemoryBindingError();
    return;
  }
  if (!state.jobId || !provider.getRememberStatus || !process.env.OWNER_ADDRESS) throw new MemoryBindingError();
  const job = await provider.getRememberStatus(state.jobId);
  if (job.job_id !== state.jobId || !job.owner || normalizeSuiAddress(job.owner) !== normalizeSuiAddress(process.env.OWNER_ADDRESS)
    || job.namespace !== (state.namespace || memory.namespace) || (state.blobId && (job.status !== "done" || job.blob_id !== state.blobId))) throw new MemoryBindingError();
  state.environmentBinding = provider.environmentBinding;
  state.namespace = job.namespace;
  await store.write(key, state);
}
export class LocalLlm implements LlmProvider {
  async answer(
    question: string,
    evidence: { recordId: string; text: string }[],
  ) {
    const causeQuestion = isCauseQuestion(question);
    const bitcoinQuestion = /ビットコイン|bitcoin|\bBTC\b/i.test(question);
    const priceEvidence = evidence.filter((e) => e.text.startsWith("株価の事実"));
    const memoryEvidence = evidence.filter((e) => !e.text.startsWith("株価の事実") && !isPredictionEvidence(e.text));
    let answer: string;
    const btcEvidence = evidence.filter((e) => e.recordId.startsWith("btc-"));
    if (causeQuestion) {
      answer = bitcoinQuestion
        ? "今ある根拠だけでは、ビットコインの下落が株価下落の原因かは判断できません。株価とビットコインの同じ期間の値動き、会社の発表や関連ニュースを確認する必要があります。同時に下がっていても、それだけでは原因とは断定できません。"
        : "結論：今ある記録だけでは、株価が動いた理由は判断できません。\n\n分かること：取得した日足の価格です。保存された質問や終値だけでは、下落の原因は分かりません。\n\n確認が必要なこと：下落した期間の会社の発表・決算・関連ニュースと、同じ期間の市場全体の値動きです。";
      if (priceEvidence.length) answer += `\n確認できた株価の記録：${priceEvidence.map((e) => e.text).join("\n")}`;
      answer += "\n現在はローカル応答です。外部のニュースを調べたり、自由なAI分析を行ったりする機能はこの応答では使っていません。";
    } else if (/心配|方針|以前|前に|過去の自分/.test(question) && !memoryEvidence.length) {
      answer = "この質問に答えられる過去の方針や心配事の記録は見つかりませんでした。株価の記録だけでは、当時あなたが何を考えていたかは分かりません。今後振り返りたい方針や仮説を「記憶に保存」で残してください。";
    } else {
      answer = evidence.length
        ? "関連する記録が見つかりました。下の参照資料を確認してください。現在はローカル応答のため、記録をもとに自由な文章で分析する外部AIは使用していません。"
        : "参照できる記憶や株価データが見つかりませんでした。銘柄の日足を取得するか、振り返りたい方針や仮説を明示的に保存してください。現在はローカル応答です。";
    }
    if (bitcoinQuestion && btcEvidence.length) answer = btcEvidence.map((e) => e.text).join("\n\n") + "\n\n" + answer;
    return {
      answer,
      references: evidence.map((e) => e.recordId),
    };
  }
}
