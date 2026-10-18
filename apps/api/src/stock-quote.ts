import { JQuants } from "../../../packages/integrations/jquants";
import { dataWindow } from "../../../packages/integrations/jquants-plan";
import { meta, type Service } from "./service";

type QuoteStock = { providerCode: string; name: string };
const normalizeName = (value: string) => value.normalize("NFKC").toUpperCase().replace(/\s+/g, "");

export function resolveQuoteStock(question: string, master: QuoteStock[], selectedCode?: string) {
  const q = normalizeName(question);
  const explicit = q.match(/(?:^|[^0-9A-Z])([0-9]{4}0|[0-9]{3}[A-Z]0|[0-9]{4}|[0-9]{3}[A-Z])(?![0-9A-Z])/i)?.[1];
  if (explicit) return { code: explicit.length === 4 ? `${explicit}0` : explicit, candidates: [] };
  if (/^(この株|この銘柄)(?:の|は|株価|終値|[?？]|$)/.test(q))
    return { code: selectedCode, candidates: [] };
  const subject = q.replace(/^(?:じゃあ|では|それなら|次は|あと)[、,]?/, "")
    .split(/の|は|株価|終値/)[0].replace(/[?？。！!]+$/g, "");
  if (!subject || /^(この株|この銘柄|今|現在|最新)$/.test(subject))
    return { code: selectedCode, candidates: [] };
  const exact = master.filter(m => normalizeName(m.name) === subject);
  // Common short names are resolved against the master, never to an invented code.
  const aliases: Record<string, string> = { トヨタ: "トヨタ自動車", メタプラ: "メタプラネット" };
  const alias = master.filter(m => normalizeName(m.name) === aliases[subject]);
  const candidates = exact.length ? exact : alias.length ? alias
    : subject.length >= 2 ? master.filter(m => normalizeName(m.name).includes(subject)) : [];
  return { code: candidates.length === 1 ? candidates[0].providerCode : undefined, candidates };
}

export function isStockQuoteQuestion(question: string, master: QuoteStock[] = []) {
  const q = question.normalize("NFKC");
  if (/なぜ|何故|理由|原因|比較|予測|分析|底打|ビットコイン|bitcoin|\bBTC\b/i.test(q)) return false;
  return /株価|終値/.test(q)
    || (/^(?:(?:じゃあ|では|それなら|次は|あと)[、,\s]*)?.{2,30}(?:の|は)[?？。\s]*$/.test(q)
      && resolveQuoteStock(q, master).candidates.length > 0);
}

export async function stockQuote(service: Service, question: string, selectedCode?: string) {
  const master = await service.store.read<QuoteStock[]>("market/master.json", []);
  const { code, candidates } = resolveQuoteStock(question, master, selectedCode);
  let answer = "銘柄を選ぶか、証券コードを指定して「7203の株価を教えて」のように聞いてね。";
  if (candidates.length > 1) answer = `銘柄の候補が複数あります：${candidates.slice(0, 5).map(m => `${m.name}（${m.providerCode.slice(0, 4)}）`).join("、")}。銘柄名か証券コードを指定してね。`;
  const evidence: { recordId: string; text: string }[] = [];
  if (code) {
    let refreshed = false;
    let fetchedDate: string | undefined;
    let failure = "";
    if (service.mode !== "demo") {
      try {
        if (!process.env.JQUANTS_API_KEY) throw Error("API未設定");
        const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
        const window = dataWindow(process.env.JQUANTS_PLAN || "Free", today);
        const start = new Date(`${window.to}T00:00:00Z`);
        start.setUTCDate(start.getUTCDate() - 30);
        const from = [window.from, start.toISOString().slice(0, 10)].sort().at(-1)!;
        const bars = await new JQuants(process.env.JQUANTS_API_KEY, fetch, { root: service.store.root })
          .daily(code, from, window.to);
        if (!bars.length || bars.some(b => b.providerCode !== code || b.sessionDate < from || b.sessionDate > window.to))
          throw Error("対象の日足を確認できません");
        fetchedDate = bars.filter(b => b.close !== null).map(b => b.sessionDate).sort().at(-1);
        if (!fetchedDate) throw Error("終値がありません");
        await service.saveBars(bars);
        refreshed = true;
      } catch {
        failure = "日足の最新取得に失敗しました。";
      }
    }
    const last = (await service.history(code))
      .filter(b => b.close !== null && (!refreshed || b.sessionDate === fetchedDate)).at(-1);
    if (last && last.close !== null) {
      const name = master.find(m => m.providerCode === code)?.name;
      const price = last.close.toLocaleString("ja-JP", { maximumFractionDigits: 4 });
      answer = `${name ? `${name} ` : ""}(${code.slice(0, 4)})の${last.sessionDate}の終値は${price}円です。\n`
        + (service.mode === "demo" ? "DEMOの架空データです。実際の株価ではありません。"
          : refreshed ? "J-Quantsから日足を取得しました。契約プランで取得できる直近の終値で、リアルタイム株価ではありません。"
            : `${failure}保存済みの終値を表示しています。最新の株価とは確認できていません。`);
      evidence.push({ recordId: last.revisionId, text: `${answer}\n取得時刻：${last.availableAt}` });
    } else {
      answer = service.mode === "demo" ? "この銘柄のDEMO日足はありません。" : `${failure}この銘柄の終値を確認できませんでした。`;
    }
  }
  const event = { ...meta("chat"), question, providerCode: code, answer, evidence,
    references: evidence.map(e => e.recordId), numericClaims: [], search: "local-fallback", model: "local-grounded" };
  await service.store.write(`chats/local/${event.recordId}.json`, event, true);
  return event;
}
