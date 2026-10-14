type Evidence = { recordId: string; text: string };
import { isCauseQuestion } from "../../../packages/core/question";
export function readableEvidence(text: string) {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (value) =>
    new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " JST",
  ).replace(/([\d,]+\.\d+)円/g, (_, price: string) => Math.round(Number(price.replaceAll(",", ""))).toLocaleString("ja-JP") + "円");
}
export function ChatAnswer({ event }: { event: { question?: string; answer: string; model: string; search: string; error?: string; evidence: Evidence[] } }) {
  const comparison = event.evidence.find((r) => r.recordId.startsWith("btc-compare-"));
  const values = comparison?.text.match(/(\d{4}-\d{2}-\d{2})→(\d{4}-\d{2}-\d{2})、株価 (-?\d+(?:\.\d+)?)％、BTC (-?\d+(?:\.\d+)?)％/);
  const price = event.evidence.find((r) => /^btc-\d+$/.test(r.recordId));
  const formattedPrice = price && readableEvidence(price.text).match(/：(.+?円)。観測時刻 (.+?)。/);
  let answer = event.answer;
  if (event.model === "local-grounded") {
    for (const r of event.evidence.filter((r) => r.recordId.startsWith("btc-"))) {
      if ((r === comparison && values) || (r === price && formattedPrice)) answer = answer.replace(r.text, "");
    }
    if (values || formattedPrice) answer = answer.replace("関連する記録が見つかりました。下の参照資料を確認してください。現在はローカル応答のため、記録をもとに自由な文章で分析する外部AIは使用していません。", "");
    if (isCauseQuestion(event.question || "") && answer.startsWith("関連する記録が見つかりました。")) {
      answer = "今ある記録だけでは、株価が動いた理由は判断できません。\n参照資料にある質問や終値だけでは、原因の説明にはなりません。下落した期間の会社の発表・決算・関連ニュースと、市場全体の値動きを確認する必要があります。\n現在のローカル応答ではニュースを自動で調べていません。";
    }
  }
  if (!answer.trim() && !values && !formattedPrice) answer = "この質問に答える説明を作成できませんでした。下の参照資料を確認してください。";
  return <>
    {values && <section className="btc-summary" aria-label="BTCと株価の比較">
      <h3>同じ期間の値動き</h3>
      <p>{values[1]} → {values[2]}</p>
      <table><thead><tr><th>対象</th><th>変動率</th></tr></thead><tbody>
        {[["選択した銘柄", values[3]], ["ビットコイン（円建て）", values[4]]].map(([name, value]) => <tr key={name}><td>{name}</td><td><strong>{Number(value) > 0 ? "+" : ""}{value}%</strong><span> {Number(value) > 0 ? "上昇" : Number(value) < 0 ? "下落" : "変化なし"}</span></td></tr>)}
      </tbody></table>
      <p>同じ期間の比較です。値動きの原因を示すものではありません。</p>
    </section>}
    {formattedPrice && <p className="btc-price"><strong>BTC参考価格：{formattedPrice[1]}</strong><br/><small>{formattedPrice[2]}時点</small></p>}
    {answer.trim() && <p style={{whiteSpace:"pre-line"}}>{readableEvidence(answer.trim())}</p>}
    <small>{event.model === "local-grounded" ? "ローカル応答" : event.model} · {event.search === "memwal-semantic" ? "MemWalで記憶検索" : "ローカル記録を参照"} {event.error}</small>
    {event.evidence.some((r) => r.recordId.startsWith("btc-")) && <p><a href="https://www.coingecko.com/en/coins/bitcoin" target="_blank" rel="noreferrer">価格データ：CoinGecko</a></p>}
    <details><summary>参照資料・取得時刻を見る（{event.evidence.length}件）</summary>
      {event.evidence.map((r) => <div className="reference" key={r.recordId}><p>{readableEvidence(r.text)}</p><details><summary>記録ID</summary><small style={{overflowWrap:"anywhere"}}>{r.recordId}</small></details></div>)}
    </details>
  </>;
}
