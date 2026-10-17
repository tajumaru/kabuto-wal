import { researchInputSchema, researchResultSchema, type ResearchEvidence, type ResearchExplanation, type ResearchResult } from "../../../packages/core/kabumaru-research-schema";
import { deterministicResearch, validateResearchExplanation } from "./kabumaru-explanation";
import { verifyEvidence } from "./kabumaru-evidence";

export interface ResearchLLMProvider {
  generateExplanation(evidence: ResearchEvidence[], instruction: string): Promise<ResearchExplanation>;
}
// Only whitelisted numeric aggregates and verified sentences leave the process.
// No source records, names, chat text, wallets, revisions, API keys or MemWal prose.
export function externalResearchPayload(evidence: ResearchEvidence[], instruction: string) {
  const question = researchInputSchema.shape.question.parse(instruction);
  if (evidence.some(e => !verifyEvidence(e))) throw Error("根拠ID不一致");
  const catalog = deterministicResearch(evidence);
  return {
    instruction: `質問分類:${question}。catalogの文を選択・並べ替えて説明してください。文・数値・根拠IDを変更しないでください。summary/bearish/reflection/uncertaintyの文を省略しないでください。返却は {statements:[{statementId,section,text,evidenceIds}]} のJSONのみ。`,
    evidence: evidence.flatMap(e => {
      if (e.kind === "memory") return [];
      const facts = e.kind === "bottom" ? { score: e.facts.score, rsi: e.facts.rsi, drawdown: e.facts.drawdown, volumeRatio: e.facts.volumeRatio, continuousSessions: e.facts.continuousSessions }
        : e.kind === "dejavu" ? { comparisons: e.facts.comparisons }
        : e.kind === "evaluation" ? { actualReturn: e.facts.actualReturn, predictedReturn: e.facts.predictedReturn, maxDrawdown: e.facts.maxDrawdown, horizon: e.facts.horizon, score: e.facts.score }
        : { predictedReturn: e.facts.predictedReturn, horizon: e.facts.horizon, score: e.facts.score };
      return [{ evidenceId: e.evidenceId, kind: e.kind, facts }];
    }), catalog,
  };
}
export class ConfiguredResearchLlm implements ResearchLLMProvider {
  constructor(private url: string, private key = "", private fetcher: typeof fetch = fetch) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) throw Error("LLM接続先は認証情報を含まないHTTPS URLで指定してください");
  }
  async generateExplanation(evidence: ResearchEvidence[], instruction: string) {
    const payload = externalResearchPayload(evidence, instruction);
    const response = await this.fetcher(this.url, { method: "POST", headers: { "Content-Type": "application/json", ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
      signal: AbortSignal.timeout(2000), redirect: "error", body: JSON.stringify(payload) });
    if (!response.ok) throw Error("研究LLMの応答エラー");
    const text = await response.text();
    if (text.length > 200000) throw Error("研究LLMの応答上限");
    return validateResearchExplanation(JSON.parse(text), payload.catalog);
  }
}
export async function explainWithResearchLlm(result: ResearchResult, raw: unknown, provider?: ResearchLLMProvider, timeoutMs = 2000): Promise<ResearchResult> {
  const input = researchInputSchema.parse(raw);
  if (input.provider !== "configured-llm") return result;
  if (!input.allowExternalLlm || process.env.ALLOW_MARKET_DATA_TO_LLM !== "true" || process.env.ALLOW_RESEARCH_DATA_TO_LLM !== "true")
    return { ...result, warnings: [...result.warnings, "専用許可・既存の市場データ送信許可・今回の明示許可が揃わないため、ローカル説明を使用しました。"] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (process.env.RESEARCH_LLM_PROVIDER !== "configured-llm") throw Error("未設定");
    const selected = provider ?? new ConfiguredResearchLlm(process.env.RESEARCH_LLM_URL ?? "", process.env.LLM_API_KEY);
    const catalog = deterministicResearch(result.evidence);
    const explanation = await Promise.race([selected.generateExplanation(result.evidence, input.question), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("timeout")), timeoutMs); })]);
    return researchResultSchema.parse({ ...result, provider: "configured-llm", explanation: validateResearchExplanation(explanation, catalog) });
  } catch {
    return { ...result, warnings: [...result.warnings, "外部説明の接続・時間・根拠検証に失敗したため、ローカルの決定的説明に戻しました。"] };
  } finally { if (timer) clearTimeout(timer); }
}
