import { earningsSummarySchema, earningsDateSchema, companyMaterialsSchema, type EarningsSummary, type CompanyMaterials } from "./earnings-schema";
import type { EarningsEvidence, EarningsAttempt } from "../integrations/earnings-evidence";
export type EarningsInput = { evidence: EarningsEvidence[]; attempt: EarningsAttempt | null };
export function financialNumber(value: unknown): number | null {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
}
const time = (r: EarningsSummary) => `${r.DiscDate}T${r.DiscTime.length === 5 ? r.DiscTime + ":00" : r.DiscTime}+09:00`;
const basis = (r: EarningsSummary) => r.DocType.match(/FinancialStatements_(Consolidated|NonConsolidated)_(JP|IFRS|US|JMIS)$/)?.slice(1).join("_") ?? null;
const changed = (r: EarningsSummary) => ["MatChgSub","SigChgInC","ChgByASRev","ChgNoASRev","RetroRst"].some(k => r[k] === "true");
const forecastField = (prefix: string, field: string) => prefix === "NxF" && field === "NP" ? "NxFNp" : prefix + field;
const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
function previousYear(a: string, b: string) {
  return !!a && !!b && Number(a.slice(0,4)) - Number(b.slice(0,4)) === 1 && a.slice(4) === b.slice(4);
}
function comparable(a: EarningsSummary, b: EarningsSummary) {
  return basis(a) !== null && basis(a) === basis(b) && a.CurPerType === b.CurPerType &&
    previousYear(a.CurPerSt,b.CurPerSt) && previousYear(a.CurPerEn,b.CurPerEn) &&
    previousYear(a.CurFYSt,b.CurFYSt) && previousYear(a.CurFYEn,b.CurFYEn) &&
    Math.abs((day(a.CurPerEn)-day(a.CurPerSt))-(day(b.CurPerEn)-day(b.CurPerSt))) <= 86400000 && !changed(a) && !changed(b);
}
export function analyzeEarnings(summary: EarningsInput, schedule: EarningsInput, cutoff: string): CompanyMaterials {
  summary = {evidence:summary.evidence.filter(e=>e.fetchedAt <= cutoff),attempt:summary.attempt && summary.attempt.fetchedAt <= cutoff ? summary.attempt : null};
  schedule = {evidence:schedule.evidence.filter(e=>e.fetchedAt <= cutoff),attempt:schedule.attempt && schedule.attempt.fetchedAt <= cutoff ? schedule.attempt : null};
  const check = (input: EarningsInput) => ({status: input.attempt?.status === "failed" ? "failed" : input.evidence.length ? "checked" : "not-fetched",
    reason: input.attempt?.reason ?? "この時点までに取得した原本がありません", checkedAt: input.attempt?.fetchedAt ?? null,
    source: "jquants-v2", revisions: input.evidence.map(e => e.revision), evidence: input.evidence.map(e=>({revision:e.revision,rawHash:e.rawHash,fetchedAt:e.fetchedAt}))});
  const comments: string[] = [];
  // Retain all revisions on disk; choose the last observed version of each disclosure at this cutoff.
  const disclosures = new Map<string, { row: EarningsSummary; revision: string }>();
  for (const e of summary.evidence.filter(e => e.fetchedAt <= cutoff)) for (const raw of e.raw) {
    const r = earningsSummarySchema.parse(raw);
    if (Date.parse(time(r)) <= Date.parse(cutoff)) disclosures.set(r.DiscNo, {row:r, revision:e.revision});
  }
  const rows = [...disclosures.values()].sort((a,b) => Date.parse(time(a.row))-Date.parse(time(b.row)));
  const latest = rows.at(-1), actual = rows.filter(r => basis(r.row) !== null && r.row.CurPerSt && r.row.CurPerEn).at(-1);
  if (latest) comments.push(`最新開示は${latest.row.DiscDate} ${latest.row.DiscTime} JST、開示番号${latest.row.DiscNo}だよ。`);
  if (actual) {
    const a = actual.row, prior = rows.filter(b => comparable(a,b.row)).at(-1)?.row;
    comments.push(`実績の対象期間は${a.CurPerSt}〜${a.CurPerEn}（${a.CurPerType}、${basis(a)}）です。`);
    for (const [field,label] of [["Sales","売上高"],["OP","営業利益"],["OdP","経常利益"],["NP","純利益"]]) {
      const now = financialNumber(a[field]), before = prior ? financialNumber(prior[field]) : null;
      comments.push(now === null ? `${label}は記載がないため未確認です。` : before === null ? `${label}は${now.toLocaleString("ja-JP")}円。会計基準・連結区分・期間が揃う前年同期の値を確認できず、成長率は算出しません。` :
        `${label}は${now.toLocaleString("ja-JP")}円、前年同期${before.toLocaleString("ja-JP")}円。${before > 0 ? `前年同期比${((now/before-1)*100).toFixed(1)}%。` : "前年同期がゼロまたは赤字のため成長率は算出しません。"}`);
      if (field !== "Sales" && now !== null && now < 0) comments.push(`${label}は${before !== null && before >= 0 ? "赤字転落" : "赤字"}に注意してね。`);
      else if (field !== "Sales" && now !== null && before !== null && now < before) comments.push(`${label}は前年同期より減益です。`);
    }
  } else comments.push("期間と会計基準が確定する実績を確認できません。業績予想修正だけでは実績の成長率を計算しません。");
  // Forecast revisions may omit accounting basis. Only compare explicitly matching bases;
  // revision-only documents remain visible but are never assigned a guessed basis.
  const forecasts = rows.flatMap(({row:r}) => [
    {r, start:r.CurFYSt,end:r.CurFYEn,prefix:"F"},
    {r, start:r.NxtFYSt,end:r.NxtFYEn,prefix:"NxF"},
  ].filter(x => x.start && x.end));
  for (const [field,label] of [["Sales","売上高予想"],["OP","営業利益予想"],["OdP","経常利益予想"],["NP","純利益予想"],["DivAnn","年間配当予想（円/株）"]]) {
    const candidates = forecasts.filter(f => financialNumber(f.r[forecastField(f.prefix,field)]) !== null), current = candidates.at(-1);
    const previous = current && candidates.filter(f => f.r.DiscNo !== current.r.DiscNo && f.start === current.start && f.end === current.end && basis(f.r) !== null && basis(f.r) === basis(current.r) && !changed(f.r) && !changed(current.r)).at(-1);
    if (current && previous) comments.push(`${label}：${current.start}〜${current.end}、${financialNumber(previous.r[forecastField(previous.prefix,field)])} → ${financialNumber(current.r[forecastField(current.prefix,field)])}。${field === "DivAnn" ? "株式分割・併合による調整は未確認です。" : "同一基準・同一年度の開示値の比較です。"}`);
    else comments.push(`${label}の変更は、同一年度・会計基準・連結区分の比較根拠が足りず未確認です。${current ? `直近の記載値は${financialNumber(current.r[forecastField(current.prefix,field)])}（${current.start}〜${current.end}、開示日${current.r.DiscDate}）です。` : "予想値の記載も確認できません。"}`);
  }
  const schedules = new Map<string, {row: ReturnType<typeof earningsDateSchema.parse>; revision: string}>();
  for (const e of schedule.evidence.filter(e => e.fetchedAt <= cutoff)) for (const raw of e.raw) {
    const r = earningsDateSchema.parse(raw);
    // PubDate has no time. fetchedAt proves receipt by cutoff; reject only future publication dates.
    if (Date.parse(`${r.PubDate}T00:00:00+09:00`) <= Date.parse(cutoff)) {
      const key = r.FQName, old = schedules.get(key);
      if (!old || r.PubDate >= old.row.PubDate) schedules.set(key,{row:r,revision:e.revision});
    }
  }
  const today = new Date(cutoff).toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
  const next = [...schedules.values()].map(e => e.row).filter(r => r.SchDate && r.SchDate >= today).sort((a,b) => a.SchDate.localeCompare(b.SchDate))[0]?.SchDate ?? null;
  if (next) {
    const days = (day(next)-day(today))/86400000;
    comments.push(`次回決算発表予定日は${next}だよ。予定は変更されることがあります。`);
    if (days <= 7) comments.push("決算発表まで7日以内です。発表前後の急な値動きに注意してね。");
  } else comments.push([...schedules.values()].some(s => !s.row.SchDate) ? "発表予定日が未定へ変更された記録があります。旧予定日は使用しません。" : "この時点で有効な次回決算発表予定日は確認できません。");
  const earnings = check(summary), scheduleCheck = check(schedule);
  if (earnings.status === "checked" && !rows.length) {earnings.status = "no-data";earnings.reason = "取得済みですが基準日時点で使える開示データがありません";}
  if (scheduleCheck.status === "checked" && !schedules.size) {scheduleCheck.status = "no-data";scheduleCheck.reason = "取得済みですが基準日時点で使える予定日公表データがありません";}
  return companyMaterialsSchema.parse({cutoff, earnings, schedule:scheduleCheck,
    news:{status:"unchecked",reason:"ニュース取得機能は未実装です。決算確認はニュース確認を意味しません。"},
    latestDisclosure: latest ? {date:latest.row.DiscDate,time:latest.row.DiscTime,number:latest.row.DiscNo,period:`${latest.row.CurPerSt}〜${latest.row.CurPerEn}`,revision:latest.revision} : null,
    nextEarningsDate:next,comments});
}
