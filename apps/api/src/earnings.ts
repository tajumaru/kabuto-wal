import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Service } from "./service";
import { JQuants } from "../../../packages/integrations/jquants";
import { JQuantsLimiter, RequestDeferred } from "../../../packages/integrations/jquants-limiter";
import { preserveEarnings, recordEarningsAttempt, readEarningsAt, type EarningsEndpoint } from "../../../packages/integrations/earnings-evidence";
import { analyzeEarnings } from "../../../packages/core/earnings-analysis";
import { earningsCode, type CompanyMaterials } from "../../../packages/core/earnings-schema";
export async function companyMaterials(s: Service, code: string, cutoff: string): Promise<CompanyMaterials> {
  const [summary, schedule] = await Promise.all([readEarningsAt(s.store,code,"summary",cutoff),readEarningsAt(s.store,code,"earnings-date",cutoff)]);
  return analyzeEarnings(summary,schedule,cutoff);
}
function failureReason(error: unknown) {
  if (error instanceof RequestDeferred) return `レート制限・取得予算で待機中（${error.retryAt}以降）`;
  const message = error instanceof Error ? error.message : "";
  if (/HTTP 40[13]/.test(message)) return "認証・Lightプラン権限を確認してください";
  if (/HTTP 429/.test(message)) return "レート制限のため取得できませんでした";
  if (/通信/.test(message)) return "通信エラーのため取得できませんでした";
  return "API応答または保存原本を検証できませんでした";
}
// Explicit owner action only. Never called by chat, scheduled agents or demo initialization.
export async function acquireEarnings(s: Service, code: string, provider?: JQuants, clock = () => new Date()) {
  earningsCode.parse(code);
  if (s.mode === "demo") return {status:"disabled",reason:"DEMOでは外部通信しません"};
  if (process.env.JQUANTS_PLAN !== "Light") return {status:"disabled",reason:"決算分析1.0はLightプランのみ取得可能です"};
  const key = process.env.JQUANTS_API_KEY;
  if (!provider && !key) return {status:"disabled",reason:"J-Quants認証が未設定です"};
  const master = await s.store.read<{providerCode:string}[]>("market/master.json",[]);
  if (!master.some(m => m.providerCode === code)) throw Error("取得済み銘柄一覧にないコードです");
  const started = Date.now(); let attempts = 0;
  const base = provider ? null : new JQuantsLimiter(key!,s.store.root,"Light");
  const client = provider ?? new JQuants(key!,fetch,{plan:"Light",gate:{
    wait:async()=>{if(attempts >= 20 || Date.now()-started > 60000) throw new RequestDeferred(new Date(Date.now()+60000).toISOString()); await base!.wait(); attempts++;},
    deferUntil:async time=>{await base!.deferUntil(time);throw new RequestDeferred(new Date(time).toISOString());},
  }});
  // Network access outside Store lock; publication is one immutable snapshot per complete endpoint.
  const results: {endpoint:EarningsEndpoint;status:string;reason:string}[] = [];
  for (const endpoint of ["summary","earnings-date"] as const) {
    try {
      const rows = endpoint === "summary" ? await client.financialSummary({code}) : await client.earningsDates({code});
      const fetchedAt = clock().toISOString();
      await s.store.lock(()=>preserveEarnings(s.store,endpoint,code,rows,fetchedAt));
      results.push({endpoint,status:"success",reason:rows.length ? "取得完了" : "対象データなし"});
    } catch (error) {
      const reason = failureReason(error);
      await s.store.lock(()=>recordEarningsAttempt(s.store,{endpoint,code,fetchedAt:clock().toISOString(),status:"failed",reason,revision:null}));
      results.push({endpoint,status:"failed",reason});
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
