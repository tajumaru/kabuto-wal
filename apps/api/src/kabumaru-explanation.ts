import { researchExplanationSchema, type ResearchEvidence, type ResearchExplanation, type ResearchResult } from "../../../packages/core/kabumaru-research-schema";
import { hash } from "../../../packages/integrations/adjusted-series";
import { verifyEvidence } from "./kabumaru-evidence";

const conditions: Record<string, string> = {
  drawdown: "高値からの下落", oversold: "売られすぎの指標", support: "直近安値の下げ止まり",
  above_sma5: "短期の平均価格の回復", sma5_rising: "短期平均の上向き", rsi_recovery: "RSI回復（値動きの強弱の改善）",
  macd_recovery: "MACD改善（値動きの勢いの改善）", volume_rebound: "出来高を伴う反発", lower_wick: "安値からの買い戻し", above_sma20: "中期平均の回復",
};
const risks: Record<string, string> = {
  new_low: "直近安値を更新", long_trend_down: "長期の平均価格は下降中", high_volatility: "値動きが大きい",
  low_liquidity: "売買代金が少ない", liquidity_unknown: "売買代金が未確認", no_trading_volume: "売買出来高がない",
  topix_unknown: "市場全体との比較は未確認", news_earnings_unchecked: "ニュース・決算は未確認", delayed_data: "契約による遅延データ",
  far_from_support: "直近安値から離れている", stale_data: "価格更新が遅れている", volume_ratio_unknown: "出来高倍率は不明",
};
const dnaLabels = new Set(["価格形状", "騰落率", "ローソク足", "出来高", "変動率"]);
const pct = (v: number | null) => v === null ? "確認できません" : `${(v*100).toFixed(2)}%`;
export function deterministicResearch(evidence: ResearchEvidence[]): ResearchExplanation {
  if (evidence.some(e => !verifyEvidence(e))) throw Error("Evidence IDが内容と一致しません");
  const statements: ResearchExplanation["statements"] = [];
  const add = (section: ResearchExplanation["statements"][number]["section"], text: string, ids: string[] = []) => {
    statements.push({ section, text, evidenceIds: ids, statementId: hash([section,text,ids]) });
  };
  const bottom = evidence.find(e => e.kind === "bottom");
  if (bottom?.kind === "bottom") {
    const f = bottom.facts, ids = [bottom.evidenceId];
    add("summary", f.status === "ready" ? `底打ちスコアは${f.score}点、分類は「${f.category}」です。これは株価上昇の確率ではありません。` : "判定に必要なデータが不足し、底打ち候補か確認できません。", ids);
    for (const c of f.metConditions) add("bullish", `${conditions[c]}が判定時点で一致しています。`, ids);
    if (!f.metConditions.length) add("bullish", "確認できる反転条件はありません。", ids);
    for (const r of f.risks) add("bearish", `${risks[r] ?? "追加の未確認リスク"}。反転の根拠と分けて確認してください。`, ids);
    const watch = [...new Set([...f.unmetConditions, "support", "volume_rebound", "above_sma20"])];
    add("watch", `今後は${watch.map(c => conditions[c]).filter(Boolean).join("、")}の継続・変化を観察します。将来の条件成立は未確認です。`, ids);
  } else add("summary", "対象銘柄の走査済み根拠がなく、確認できません。保存済みデータの走査とジョブ指定が必要です。");
  const dejavu = evidence.find(e => e.kind === "dejavu");
  if (dejavu?.kind === "dejavu") {
    for (const c of dejavu.facts.comparisons) add("dejavu", `上位${c.requestedCount}件の設定で、${c.horizon}営業日後の実際の標本は${c.sampleCount}件。中央値${pct(c.medianReturn)}、上昇割合${pct(c.upRatio)}、分位点${c.percentileRange?.map(pct).join("〜") ?? "確認できません"}です。上昇割合は未校正の過去分布です。`, [dejavu.evidenceId]);
    for (const e of dejavu.facts.examples) add("dejavu", `表示事例の類似度${e.similarity.toFixed(2)}。最も近い要素は${e.common && dnaLabels.has(e.common) ? e.common : "未確認"}、異なる要素は${e.different && dnaLabels.has(e.different) ? e.different : "未確認"}です。類似は将来の一致を保証しません。`, [dejavu.evidenceId]);
  } else add("dejavu", "非重複の類似事例は確認できません。履歴や取得時点を確認してください。");
  const evaluations = evidence.filter(e => e.kind === "evaluation");
  for (const e of evaluations) {
    if (e.kind !== "evaluation") continue;
    add("reflection", `${e.facts.experiment}の過去予測：${e.facts.horizon}営業日後の予測中央値${pct(e.facts.predictedReturn)}、実績${pct(e.facts.actualReturn)}、最大下落${pct(e.facts.maxDrawdown)}。値動きだけで成功・失敗の原因は断定できません。`, [e.evidenceId]);
  }
  if (!evaluations.length) add("reflection", "この取得時点で確認できる関連評価がなく、予測の成功・失敗は確認できません。");
  // Do not pool experiments, periods or horizons to answer the high-score question.
  const groups = new Map<string, typeof evaluations>();
  for (const e of evaluations) {
    if (e.kind !== "evaluation" || e.facts.score === null || e.facts.score < 80) continue;
    const key = `${e.facts.experiment}／${e.facts.period}／${e.facts.horizon}営業日／${e.facts.classification}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const [key, es] of groups) {
    const values = es.map(e => e.facts.actualReturn);
    add("reflection", `80点以上の関連記録（${key}）：評価済み${values.length}件、平均騰落率${pct(values.reduce((a,b) => a+b,0)/values.length)}。${values.length < 20 ? "少数標本で信頼性が低い集計です。" : "記録された仮説だけの集計です。"}`, es.map(e => e.evidenceId));
  }
  if (!groups.size) add("reflection", "80点以上の関連成績は、この時点の根拠から確認できません。");
  add("uncertainty", "記録された候補だけを比較する選択バイアスがあります。実運用・過去研究・walk-forwardは分けて解釈してください。原因の推測を観測事実として扱いません。");
  add("uncertainty", "標本数とデータ取得状況が少ない場合は判断材料が限定されます。信頼性の区分は株価上昇の確率ではありません。");
  return researchExplanationSchema.parse({ statements });
}
export function researchReliability(evidence: ResearchEvidence[], coverage: ResearchResult["dataCoverage"]): ResearchResult["reliability"] {
  const bottom = evidence.find(e => e.kind === "bottom");
  if (!bottom || bottom.kind !== "bottom" || bottom.facts.status !== "ready") return "根拠不足";
  if (!coverage?.complete || bottom.facts.continuousSessions < 80 || coverage.delayDays > 0) return "データ取得不完全";
  const d = evidence.find(e => e.kind === "dejavu");
  const sample = d?.kind === "dejavu" ? Math.min(...d.facts.comparisons.filter(c => c.requestedCount === 20).map(c => c.sampleCount), 20) : 0;
  return sample >= 20 && evidence.filter(e => e.kind === "evaluation").length >= 20 ? "十分な根拠" : "限定的な根拠";
}
// Configured models may select/reorder verified natural-language statements, never invent facts.
export function validateResearchExplanation(raw: unknown, catalog: ResearchExplanation): ResearchExplanation {
  const parsed = researchExplanationSchema.parse(raw), known = new Map(catalog.statements.map(s => [s.statementId,s]));
  if (new Set(parsed.statements.map(s => s.statementId)).size !== parsed.statements.length || parsed.statements.some(s => JSON.stringify(s) !== JSON.stringify(known.get(s.statementId))))
    throw Error("未検証の説明・数値・根拠ID");
  for (const section of ["summary", "bearish", "reflection", "uncertainty"] as const)
    if (catalog.statements.filter(s => s.section === section).some(s => !parsed.statements.some(p => p.statementId === s.statementId))) throw Error("必須の説明・注意事項がありません");
  return parsed;
}
