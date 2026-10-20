import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Service } from "./service";
import { JQuants } from "../../../packages/integrations/jquants";
import { JQuantsLimiter, RequestDeferred } from "../../../packages/integrations/jquants-limiter";
import { preserveEarnings, recordEarningsAttempt, readEarningsAt, type EarningsEndpoint } from "../../../packages/integrations/earnings-evidence";
import { analyzeEarnings } from "../../../packages/core/earnings-analysis";
import { earningsCode, type CompanyMaterials, type EarningsAcquisition } from "../../../packages/core/earnings-schema";
export async function companyMaterials(s: Service, code: string, cutoff: string): Promise<CompanyMaterials> {
  const safeRead = async (endpoint: EarningsEndpoint) => {
    try { return await readEarningsAt(s.store,code,endpoint,cutoff); }
    catch { return {evidence:[],attempt:{endpoint,code,fetchedAt:cutoff,status:"failed" as const,reason:"保存原本の整合性を確認できません",revision:null}}; }
  };
  const [summary, schedule] = await Promise.all([safeRead("summary"),safeRead("earnings-date")]);
  const invalid = (endpoint:EarningsEndpoint) => ({evidence:[],attempt:{endpoint,code,fetchedAt:cutoff,status:"failed" as const,reason:"保存原本のrevisionが矛盾しています",revision:null}});
  let safeSummary=summary,safeSchedule=schedule;
  try { analyzeEarnings(summary,{evidence:[],attempt:null},cutoff); } catch { safeSummary=invalid("summary"); }
  try { analyzeEarnings({evidence:[],attempt:null},schedule,cutoff); } catch { safeSchedule=invalid("earnings-date"); }
  return analyzeEarnings(safeSummary,safeSchedule,cutoff);
}
type FailureCode = NonNullable<NonNullable<EarningsAcquisition["results"]>[number]["errorCode"]>;
function failureCode(error: unknown): FailureCode {
  if (error instanceof RequestDeferred) return "rate-limit";
  const message = error instanceof Error ? error.message : "";
  if (/HTTP 401/.test(message)) return "authentication";
  if (/HTTP 403/.test(message)) return "permission";
  if (/HTTP 429/.test(message)) return "rate-limit";
  if (/通信|HTTP 5\d\d/.test(message)) return "network";
  return "invalid-response";
}
const failureMessages: Record<FailureCode,string> = {
  authentication:"認証エラー：J-Quants APIキーの設定を確認してください",
  permission:"権限不足：J-Quants Lightプランの権限を確認してください",
  "rate-limit":"レート制限・取得予算のため待機が必要です。時間をおいて再操作してください",
  network:"通信エラー：J-Quantsとの接続を確認できませんでした",
  "invalid-response":"API応答の形式・対象銘柄・履歴の整合性を検証できませんでした",
  storage:"保存エラー：決算原本の保存またはhash照合を確認できませんでした",
};
// Explicit owner action only. Never called by chat, scheduled agents or demo initialization.
export async function acquireEarnings(s: Service, code: string, provider?: JQuants, clock = () => new Date()): Promise<EarningsAcquisition> {
  earningsCode.parse(code);
  if (s.mode === "demo") return {status:"disabled",reason:"DEMOでは外部通信しません"};
  if (process.env.JQUANTS_PLAN !== "Light") return {status:"disabled",reason:"決算分析1.0はLightプランのみ取得可能です"};
  const key = process.env.JQUANTS_API_KEY;
  if (!provider && !key) return {status:"disabled",reason:"J-Quants認証が未設定です"};
  const master = await s.store.read<{providerCode:string}[]>("market/master.json",[]);
  if (!master.some(m => m.providerCode === code)) throw Error("取得済み銘柄一覧にないコードです");
  const started = Date.now(); let attempts = 0;
  const configuredRpm = process.env.JQUANTS_REQUESTS_PER_MINUTE;
  const base = provider ? null : new JQuantsLimiter(key!,s.store.root,"Light",configuredRpm ? Number(configuredRpm) : undefined);
  let lastHttpStatus: number | undefined;
  const client = provider ?? new JQuants(key!,async (...args)=>{lastHttpStatus=undefined; const response=await fetch(...args);lastHttpStatus=response.status;return response;},{plan:"Light",gate:{
    wait:async()=>{if(attempts >= 20 || Date.now()-started > 60000) throw new RequestDeferred(new Date(Date.now()+60000).toISOString()); await base!.wait(); attempts++;},
    deferUntil:async time=>{await base!.deferUntil(time);if(lastHttpStatus === 429) throw new RequestDeferred(new Date(time).toISOString());throw Error("J-Quants通信を確認できません");},
  }});
  // Network access outside Store lock; publication is one immutable snapshot per complete endpoint.
  const results: NonNullable<EarningsAcquisition["results"]> = [];
  for (const endpoint of ["summary","earnings-date"] as const) {
    let fetched=false,saved=false,hashVerified=false,rowCount:number|null=null,fetchedAt:string|null=null,revision:string|null=null;
    try {
      const rows = endpoint === "summary" ? await client.financialSummary({code}) : await client.earningsDates({code});
      fetched=true;rowCount=rows.length;fetchedAt=clock().toISOString();
      const timestamp=fetchedAt;
      await s.store.lock(async()=>{
        const e=await preserveEarnings(s.store,endpoint,code,rows,timestamp);
        saved=true;revision=e.revision;
        const verified=await readEarningsAt(s.store,code,endpoint,timestamp);
        if (!verified.evidence.some(v=>v.revision===e.revision && v.rawHash===e.rawHash)) throw Error("保存後照合失敗");
        // Verify row selection too: conflicting snapshots never count as checked.
        if (endpoint === "summary") analyzeEarnings(verified,{evidence:[],attempt:null},timestamp);
        else analyzeEarnings({evidence:[],attempt:null},verified,timestamp);
        hashVerified=true;
      });
      results.push({endpoint,status:"success",reason:rows.length ? "取得・保存・原本hash照合が完了しました" : "対象データなし（空の取得結果も保存・照合済み）",errorCode:null,fetched,saved,hashVerified,rowCount,fetchedAt,revision});
    } catch (error) {
      const errorCode=fetched ? "storage" : failureCode(error),reason=failureMessages[errorCode];
      // A broken disk must not mask the safe diagnostic with a raw exception.
      try { await s.store.lock(()=>recordEarningsAttempt(s.store,{endpoint,code,fetchedAt:clock().toISOString(),status:"failed",reason,revision:null})); } catch { /* returned status remains failed */ }
      results.push({endpoint,status:"failed",reason,errorCode,fetched,saved,hashVerified,rowCount,fetchedAt,revision});
    }
  }
  return {status:results.every(r=>r.status === "success") ? "success" : "failed",results};
}
export function registerEarnings(app: FastifyInstance, s: Service) {
  app.get("/api/research/earnings/:code",async req=>{
    const {code} = z.object({code:earningsCode}).parse(req.params);
    const {cutoff} = z.object({cutoff:z.string().datetime().optional()}).parse(req.query);
    const now = new Date().toISOString();
    if (cutoff && cutoff > now) throw Error("未来の基準日時は指定できません");
    return companyMaterials(s,code,cutoff ?? now);
  });
  // Uses createApp's existing owner session and same-origin mutation checks.
  app.post("/api/research/earnings/:code/acquire",async req=>{
    const {code} = z.object({code:earningsCode}).parse(req.params);
    z.object({confirmFetch:z.literal(true)}).strict().parse(req.body);
    return acquireEarnings(s,code);
  });
}
