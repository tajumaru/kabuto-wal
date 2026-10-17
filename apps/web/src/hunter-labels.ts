const labels: Record<string, string> = {
  insufficient_history: "履歴不足（80営業日が必要）", missing_sessions: "日足に欠損あり",
  invalid_ohlcv: "価格・出来高に不備あり", no_prices: "日足未取得", no_raw_prices: "分析用データ未取得",
  adjustment_failed: "調整データの作成失敗", asof_not_observed: "基準日の価格未取得",
  inconsistent_adjustment_series: "調整系列の不一致", volume_history_empty: "出来高の履歴不足",
  topix_unknown: "TOPIX比較なし", news_earnings_unchecked: "ニュース・決算未確認",
  liquidity_unknown: "流動性未確認", low_liquidity: "売買代金が少ない", stale_data: "最新日まで未取得",
  delayed_data: "遅延データ", long_trend_down: "長期下落傾向", new_low: "直近安値を更新",
  high_volatility: "値動きが大きい", far_from_support: "支持線から乖離",
  no_trading_volume: "出来高なし", volume_ratio_unknown: "出来高倍率を計算できません",
  master_date_mismatch: "銘柄情報の日付不一致", unknown_product: "商品区分未確認",
  non_common_share: "普通株以外", unknown_or_other_market: "対象外・未確認の市場",
};
export function hunterLabel(code: string) {
  if (labels[code]) return labels[code];
  if (code.startsWith("excluded_product_")) return "対象外の商品区分";
  return /^[a-z][a-z0-9_]*$/.test(code) ? "データの確認が必要" : code;
}
export const acquisitionLabel = { ready: "取得済み", missing: "未取得", failed: "取得失敗" };
