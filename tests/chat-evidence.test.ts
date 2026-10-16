import { expect, it } from "vitest";
import { readablePredictionEvidence, predictionEvidence } from "../packages/core/chat-evidence";
import { LocalLlm } from "../packages/integrations/index";

it("保存済みの予測JSONを日本語と百分率で表示し内部IDを出さない", () => {
  const text = readablePredictionEvidence('この対象には保存済みの予測が3件あるよ。 予測（仮説） 2026-10-14→2026-10-15 : {"predictedReturn":-0.00065,"sampleCount":45,"evaluation":{"actualReturn":0.00463,"directionMatch":true,"recordId":"internal-id","revisionIds":["long-hash"]}}');
  expect(text).toContain("予測した値動き：-0.07%");
  expect(text).toContain("実際の値動き：+0.46%");
  expect(text).not.toContain("internal-id");
  expect(text).not.toContain("predictedReturn");
  expect(predictionEvidence({ predictedReturn: 0.01, sampleCount: 42 })).toContain("まだ検証結果が保存されていません");
});

it("予測と株価だけで当時の心配事が見つかったと回答しない", async () => {
  const result = await new LocalLlm().answer("この銘柄について前に何を心配していた？", [
    { recordId: "prediction", text: "予測（仮説） 2026-10-14→2026-10-15" },
    { recordId: "summary", text: "この対象には保存済みの予測が3件あるよ。" },
    { recordId: "price", text: "株価の事実（取得日足）終値174.5" },
  ]);
  expect(result.answer).toContain("心配事の記録は見つかりませんでした");
});
