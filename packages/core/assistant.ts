import { createHash } from "node:crypto";
import type { Bar } from "./index";
export type KabumaruPose =
  "idle" | "discover" | "analyze" | "thinking" | "happy" | "warning";
export type AssistantNotice = {
  schemaVersion: 1;
  recordId: string;
  kind: string;
  pose: KabumaruPose;
  providerCode: string;
  name: string;
  dataAsOf: string;
  observedAt: string;
  createdAt: string;
  mode: string;
  source: string;
  title: string;
  text: string;
  metrics: Record<string, number | string>;
  evidenceIds: string[];
  href: string;
};
export function notice(
  input: Omit<AssistantNotice, "recordId" | "schemaVersion" | "createdAt">,
): AssistantNotice {
  const recordId = createHash("sha256")
    .update(
      JSON.stringify([
        input.mode,
        input.kind,
        input.providerCode,
        input.dataAsOf,
        input.evidenceIds,
        input.metrics,
      ]),
    )
    .digest("hex");
  return {
    schemaVersion: 1,
    recordId,
    createdAt: new Date().toISOString(),
    ...input,
  };
}
export function marketNotices(
  code: string,
  name: string,
  bars: Bar[],
  mode: string,
) {
  const latest = bars.at(-1),
    previous = bars.at(-2);
  if (!latest) return [];
  const base = {
    providerCode: code,
    name,
    dataAsOf: latest.sessionDate,
    observedAt: latest.availableAt,
    mode,
    source: mode === "demo" ? "fixture" : "jquants-v2",
    href: `/stocks/${code}`,
  };
  const result: AssistantNotice[] = [];
  if (
    latest.adjClose &&
    previous?.adjClose &&
    latest.seriesId === previous.seriesId
  ) {
    const change = latest.adjClose / previous.adjClose - 1;
    if (Math.abs(change) >= 0.05)
      result.push(
        notice({
          ...base,
          kind: change > 0 ? "price_up" : "price_down",
          pose: change > 0 ? "discover" : "warning",
          title: `${name}が${change > 0 ? "大きく上昇" : "大きく下落"}しているよ`,
          text: `${latest.sessionDate}の調整済み終値は${latest.adjClose.toLocaleString("ja-JP")}円。前の取得営業日（${previous.sessionDate}）比${(change * 100).toFixed(2)}%。出来高と過去の値動きも確認してみよう。`,
          metrics: {
            change,
            close: latest.adjClose,
            threshold: 0.05,
            previousDate: previous.sessionDate,
          },
          evidenceIds: [previous.revisionId, latest.revisionId],
        }),
      );
  }
  const prior = bars.slice(-21, -1);
  if (
    prior.length === 20 &&
    latest.volume !== null &&
    prior.every((b) => b.volume !== null && b.seriesId === latest.seriesId)
  ) {
    const average = prior.reduce((n, b) => n + b.volume!, 0) / 20,
      ratio = average > 0 ? latest.volume / average : 0;
    if (ratio >= 2)
      result.push(
        notice({
          ...base,
          kind: "volume_spike",
          pose: "analyze",
          title: `${name}の出来高が増えているよ`,
          text: `${latest.sessionDate}の出来高は${latest.volume.toLocaleString("ja-JP")}。直前20営業日の平均${Math.round(average).toLocaleString("ja-JP")}に対して${ratio.toFixed(2)}倍。価格変化と合わせて調べてみよう。`,
          metrics: { volume: latest.volume, average, ratio, threshold: 2 },
          evidenceIds: [...prior.map((b) => b.revisionId), latest.revisionId],
        }),
      );
  }
  return result;
}
