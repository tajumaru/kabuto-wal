import { MemWal } from "@mysten-incubation/memwal";
import { randomUUID } from "node:crypto";
import { isCauseQuestion } from "../core/question";
import { barSchema, type Bar } from "../core/index";
import type { Store } from "../storage/index";
export interface MarketDataProvider {
  daily(code: string, from: string, to: string): Promise<Bar[]>;
}
export interface MemoryProvider {
  remember(text: string, namespace: string): Promise<{ job_id: string }>;
  waitForRememberJob(id: string): Promise<{ blob_id: string }>;
  recall(params: {
    query: string;
    namespace: string;
    limit: number;
  }): Promise<{ results: { text: string; distance: number }[] }>;
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
export class JQuants implements MarketDataProvider {
  constructor(
    private key: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async pages(endpoint: string, params: Record<string, string>) {
    const data: any[] = [];
    let pagination: string | undefined;
    const seen = new Set<string>();
    do {
      const q = new URLSearchParams({
        ...params,
        ...(pagination ? { pagination_key: pagination } : {}),
      });
      const result = await requestJson(
        `https://api.jquants.com/v2/${endpoint}?${q}`,
        { "x-api-key": this.key },
        this.fetcher,
      );
      if (!Array.isArray(result.data))
        throw Error("J-Quantsのレスポンス形式が一致しません");
      data.push(...result.data);
      pagination = result.pagination_key;
      if (pagination) {
        if (seen.has(pagination)) throw Error("ページキーの循環");
        seen.add(pagination);
      }
    } while (pagination);
    return data;
  }
  async daily(code: string, from: string, to: string) {
    const data = await this.pages("equities/bars/daily", { code, from, to });
    const availableAt = new Date().toISOString(),
      seriesId = randomUUID();
    return data.map((b) =>
      barSchema.parse({
        providerCode: b.Code,
        sessionDate: b.Date,
        close: b.C,
        adjClose: b.AdjC,
        volume: b.AdjVo,
        factor: b.AdjFactor ?? 1,
        revisionId: "pending",
        availableAt,
        seriesId,
        open: b.O ?? null,
        high: b.H ?? null,
        low: b.L ?? null,
        rawVolume: b.Vo ?? null,
        adjOpen: b.AdjO ?? null,
        adjHigh: b.AdjH ?? null,
        adjLow: b.AdjL ?? null,
      }),
    );
  }
  async master() {
    return this.pages("equities/master", {});
  }
  async calendar(from: string, to: string) {
    const rows = await this.pages("markets/calendar", { from, to });
    return rows.map((r) => ({
      date: r.Date,
      open: ["1", "2"].includes(String(r.HolDiv)),
    }));
  }
}
export function memwal(): MemoryProvider | null {
  if (!process.env.MEMWAL_ACCOUNT_ID || !process.env.MEMWAL_DELEGATE_KEY)
    return null;
  return MemWal.create({
    key: process.env.MEMWAL_DELEGATE_KEY,
    accountId: process.env.MEMWAL_ACCOUNT_ID,
    serverUrl: process.env.MEMWAL_SERVER_URL,
    namespace: "kabutowal:v1:profile",
  });
}
export async function syncMemories(
  store: Store,
  provider: MemoryProvider | null,
  allowMarket: boolean,
) {
  if (!provider) return;
  for (const memory of await store.all("memories")) {
    if (!memory.active || (memory.kind !== "user_memory" && !allowMarket))
      continue;
    const key = `sync/${memory.recordId}.json`;
    const state = await store.read(key, { status: "pending" });
    if (state.status === "synced" || state.status === "uncertain") continue;
    if (state.status === "submitting" && !state.jobId) {
      await store.write(key, {
        ...state,
        status: "uncertain",
        error: "受付直後の中断。自動再送は停止",
      });
      continue;
    }
    try {
      let jobId = state.jobId;
      if (!jobId) {
        await store.write(key, { ...state, status: "submitting" });
        const namespace = memory.namespace.replace(/^stock-memory:/, "kabutowal:");
        const accepted = await provider.remember(
          JSON.stringify({ ...memory, namespace }),
          namespace,
        );
        jobId = accepted.job_id;
        await store.write(key, { status: "accepted", jobId });
      }
      const result = await provider.waitForRememberJob(jobId);
      if (!result.blob_id) throw Error("MemWal保存完了のblob IDが未確認");
      await store.write(key, {
        status: "synced",
        jobId,
        blobId: result.blob_id,
      });
    } catch {
      await store.write(key, {
        ...(await store.read(key)),
        status: (await store.read(key)).jobId ? "accepted" : "uncertain",
        error:
          "同期未完了。既知jobを追跡し、受付不明の場合は自動再送しません。",
      });
    }
  }
}
export class LocalLlm implements LlmProvider {
  async answer(
    question: string,
    evidence: { recordId: string; text: string }[],
  ) {
    const causeQuestion = isCauseQuestion(question);
    const bitcoinQuestion = /ビットコイン|bitcoin|\bBTC\b/i.test(question);
    const priceEvidence = evidence.filter((e) => e.text.startsWith("株価の事実"));
    const memoryEvidence = evidence.filter((e) => !e.text.startsWith("株価の事実"));
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
