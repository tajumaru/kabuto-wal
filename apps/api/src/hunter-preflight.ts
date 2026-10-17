import { createHash } from "node:crypto";
import type { Service } from "./service";
import type { Calendar } from "../../../packages/core/index";
import { hunterJobInputSchema, hunterPreflightSchema } from "../../../packages/core/hunter-schema";
import { dataWindow, planCapabilities } from "../../../packages/integrations/jquants-plan";

// Read local configuration/checkpoints only; never spend an API request to estimate one.
export async function hunterPreflight(service: Service, raw: unknown, now = new Date()) {
  const input = hunterJobInputSchema.parse(raw), demo = service.mode === "demo";
  const plan = process.env.JQUANTS_PLAN || "Free";
  const capabilities = planCapabilities(plan);
  const errors: string[] = [], warnings: string[] = [];
  const configured = process.env.JQUANTS_REQUESTS_PER_MINUTE;
  const rpm = configured ? Number(configured) : capabilities.requestsPerMinute;
  const validRpm = Number.isInteger(rpm) && rpm >= 1 && rpm <= capabilities.limit;
  if (!demo && input.kind !== "scan" && !validRpm) errors.push(`取得速度の設定を1〜${capabilities.limit}回/分にしてください。`);
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const window = dataWindow(plan, today);
  if (!demo && input.kind !== "scan" && (input.asOf < window.from || input.asOf > window.to || (input.from && input.from < window.from)))
    errors.push(`${plan}の取得可能期間は${window.from}〜${window.to}です。`);
  if (!demo && input.kind !== "scan" && !process.env.JQUANTS_API_KEY) errors.push("J-QuantsのAPIキーが未設定です。");
  const calendar = await service.store.read<Calendar>("market/calendar.json", []);
  const start = input.from ?? calendar.filter(d => d.open && d.date <= input.asOf).map(d => d.date).sort().slice(-80)[0] ?? input.asOf;
  const dates = calendar.filter(d => d.open && d.date >= start && d.date <= input.asOf).map(d => d.date).sort();
  const sessions = dates.length;
  if (!calendar.some(d => d.date === input.asOf)) warnings.push("対象日の営業日情報が未取得です。実取得時に確認します。");
  else if (!dates.includes(input.asOf)) errors.push("基準日が休場日です。営業日を指定してください。");
  if (sessions < 80) warnings.push(`保存済みカレンダーでは${sessions}営業日です。判定には連続80営業日が必要です。取得開始日を早めるか、既存の履歴があるか確認してください。`);
  const targets = input.kind === "correction" ? dates.slice(-5) : dates;
  let cachedDays = 0;
  for (const date of targets) {
    const revision = input.kind === "correction" ? input.revision! : "initial";
    const cp = await service.store.read<{ status: string } | null>(`market/ingestion/${date}/${revision}/checkpoint.json`, null);
    if (cp?.status === "completed") cachedDays++;
  }
  const external = !demo && input.kind !== "scan";
  const minimumRequests = external ? 1 + (targets.length - cachedDays) * 2 : 0;
  let waitSeconds = 0;
  const key = process.env.JQUANTS_API_KEY;
  if (external && key) {
    const id = createHash("sha256").update(key).digest("hex");
    const budget = await service.store.read<{ nextAllowedAt: number; day?:string; requests?:number } | null>(`market/request-budgets/${id}/state.json`, null);
    waitSeconds = Math.max(0, Math.ceil(((budget?.nextAllowedAt ?? 0) - now.getTime()) / 1000));
    const daily = process.env.JQUANTS_REQUESTS_PER_DAY ? Number(process.env.JQUANTS_REQUESTS_PER_DAY) : undefined;
    if (daily !== undefined && (!Number.isSafeInteger(daily) || daily < 1)) errors.push("日次取得予算は正の整数で指定してください。");
    if (daily !== undefined && budget?.day === today && (budget.requests ?? 0) >= daily) { waitSeconds=Math.max(waitSeconds,Math.ceil((Date.parse(`${today}T15:00:00.000Z`)-now.getTime())/1000)); warnings.push("ローカルの日次取得予算に達しました。次の日本時間の日付で再開できます。"); }
  }
  if (external) warnings.push("API回数・時間は下限の目安です。ページ分割、再試行、未取得の営業日情報で増えます。契約状態や他のアプリの消費量は確認できません。");
  return hunterPreflightSchema.parse({ plan: demo ? "fixture" : plan, windowFrom: window.from, windowTo: window.to,
    limit: capabilities.limit, rpm: validRpm ? rpm : 0, sessions, cachedDays, minimumRequests,
    minimumSeconds: external && validRpm ? Math.ceil(minimumRequests * 60 / rpm) : 0, waitSeconds, errors, warnings });
}
