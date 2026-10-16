import type { BottomAnalysis } from "../../../packages/core/bottom-schema";

export function HunterPriceChart({ chart }: { chart: BottomAnalysis["chart"] }) {
  if (!chart.length) return <p>ローソク足を表示できるデータがありません。</p>;
  const lo = Math.min(...chart.map(b => b.low ?? b.close)), hi = Math.max(...chart.map(b => b.high ?? b.close));
  const y = (n: number) => 20 + (hi - n) / (hi - lo || 1) * 210;
  const x = (i: number) => 20 + i * 920 / chart.length;
  const maxVolume = Math.max(...chart.map(b => b.volume ?? 0), 1);
  return <figure className="hunter-candles"><svg viewBox="0 0 960 330" role="img" aria-label="80営業日のローソク足・5日平均・20日平均・出来高">
    {chart.map((b,i) => <g key={b.sessionDate}><title>{b.sessionDate} 終値{b.close} 出来高{b.volume ?? "未取得"}</title>
      <line x1={x(i)} x2={x(i)} y1={y(b.high ?? b.close)} y2={y(b.low ?? b.close)} stroke="currentColor" />
      <rect x={x(i)-3} width="6" y={Math.min(y(b.open ?? b.close), y(b.close))} height={Math.max(1, Math.abs(y(b.open ?? b.close)-y(b.close)))} fill={b.close >= (b.open ?? b.close) ? "#159a7a" : "#dc5b58"} />
      <rect x={x(i)-3} width="6" y={310-(b.volume ?? 0)/maxVolume*60} height={(b.volume ?? 0)/maxVolume*60} fill="#729bb8" />
    </g>)}
    {(["sma5", "sma20"] as const).map((key,n) => <polyline key={key} fill="none" stroke={n ? "#8b5cf6" : "#d97706"} strokeWidth="2" points={chart.flatMap((b,i) => b[key] === null ? [] : [`${x(i)},${y(b[key])}`]).join(" ")} />)}
    <text x="20" y="325" fill="currentColor">{chart[0].sessionDate}</text><text x="800" y="325" fill="currentColor">{chart.at(-1)!.sessionDate}</text>
  </svg><figcaption>ローソク足 ／ 橙：5日平均 ／ 紫：20日平均 ／ 下段：出来高（調整済み）</figcaption></figure>;
}
