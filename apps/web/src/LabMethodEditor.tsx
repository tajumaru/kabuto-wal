import type { LabMethod } from "../../../packages/core/hunter-experiment-schema";
import { labFeatures } from "../../../packages/core/hunter-experiment-schema";
export const labFeatureLabels: Record<(typeof labFeatures)[number], string> = {
  drawdown: "60日下落",
  oversold: "RSI売られ過ぎ",
  support: "安値・支持",
  above_sma5: "5日平均回復",
  sma5_rising: "5日平均上向き",
  rsi_recovery: "RSI回復",
  macd_recovery: "MACD回復",
  volume_rebound: "出来高反転",
  lower_wick: "下ヒゲ",
  above_sma20: "20日平均回復",
};
export function LabMethodEditor({
  parameters,
  onChange,
  threshold,
  onThreshold,
}: {
  parameters: LabMethod["parameters"];
  onChange: (p: LabMethod["parameters"]) => void;
  threshold: number;
  onThreshold: (n: number) => void;
}) {
  return (
    <fieldset>
      <legend>実験方式の設定（本番は変更されません）</legend>
      <p>
        重みは合計100点へ正規化します。現行の候補安全条件を満たした銘柄に、追加閾値を適用します。
      </p>
      <div className="lab-grid">
        {labFeatures.map((k) => (
          <label key={k}>
            {labFeatureLabels[k]}
            <input
              type="number"
              min="0"
              max="100"
              step="0.5"
              value={Number.isFinite(parameters[k]) ? parameters[k] : ""}
              onChange={(e) =>
                onChange({ ...parameters, [k]: e.target.valueAsNumber })
              }
            />
          </label>
        ))}
      </div>
      <label>
        候補スコア閾値
        <input
          type="number"
          min="0"
          max="100"
          value={Number.isFinite(threshold) ? threshold : ""}
          onChange={(e) => onThreshold(e.target.valueAsNumber)}
        />
      </label>
    </fieldset>
  );
}
