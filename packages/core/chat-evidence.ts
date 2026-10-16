const percent = (value: number) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;

export function predictionEvidence(data: {
  predictedReturn: number;
  sampleCount: number;
  evaluation?: { actualReturn?: number; directionMatch?: boolean } | null;
}) {
  const lines = [`予測した値動き：${percent(data.predictedReturn)}（比較した過去の事例：${data.sampleCount}件）`];
  if (typeof data.evaluation?.actualReturn === "number") {
    lines.push(`実際の値動き：${percent(data.evaluation.actualReturn)}`);
    if (typeof data.evaluation.directionMatch === "boolean")
      lines.push(`上がる・下がる・横ばいの予測：${data.evaluation.directionMatch ? "実績と一致" : "実績と不一致"}`);
  } else lines.push("結果：まだ検証結果が保存されていません。");
  return lines.join("\n");
}

// Also format old saved conversations without rewriting their stored evidence.
export function readablePredictionEvidence(text: string): string {
  return text.replace(/(予測（仮説）\s+\d{4}-\d{2}-\d{2}→\d{4}-\d{2}-\d{2})\s*:\s*(\{[^\n]*\})/g, (original, label: string, json: string) => {
    try {
      const data = JSON.parse(json);
      if (typeof data.predictedReturn !== "number" || !Number.isFinite(data.predictedReturn) || typeof data.sampleCount !== "number") return original;
      return `${label}\n${predictionEvidence(data)}`;
    } catch { return original; }
  });
}

export function isPredictionEvidence(text: string) {
  return /^(予測（仮説）|この対象には保存済みの予測)/.test(text);
}
