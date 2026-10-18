import { randomUUID } from "node:crypto";
import type { Service } from "./service";
import { scoutResearch } from "./bottom-scout";
import { scoutReplySchema } from "../../../packages/core/bottom-scout-schema";
import { parseScoutIntent } from "../../../packages/core/bottom-scout-intent";
// Explicitly narrow: no external LLM, memory provider, signer, or command tools.
export async function scoutChat(
  s: Service,
  question: string,
  code?: string,
  now = new Date(),
) {
  const parsed = parseScoutIntent(question, code);
  if (!parsed) throw Error("底打ち探索の対象外です");
  return s.store.lock(async () => {
    const scout = scoutReplySchema.parse(
        await scoutResearch(s, question, code, now),
      ),
      answer =
        scout.status === "clarification"
          ? scout.notes.join("\n")
          : scout.status === "review"
            ? `保存済み候補の振り返りだよ。基準日${scout.asOf}。5・10・20営業日後の確定した結果だけを表示します。`
            : scout.rows.length
              ? `${scout.mode === "demo" ? "DEMOの架空データで、" : "取得済み実データの対象内で、"}${scout.intent === "detail" ? (scout.rows[0].candidate ? "反発候補の条件があります。" : "現時点では反発候補の条件が揃っていません。") : "底打ち候補を" + scout.rows.length + "銘柄見つけたよ。"}基準日${scout.asOf}。スコアは上昇確率ではありません。\n${scout.rows
                  .map(
                    (r, i) =>
                      `${i + 1}. ${r.name}（${r.code}）：${r.score}点。根拠：${
                        r.contributions
                          .filter((c) => c.met)
                          .map((c) => c.label)
                          .join("、") || "条件未成立"
                      }。注意：${r.risks.join("、")}`,
                  )
                  .join("\n")}`
              : scout.status === "no-candidates"
                ? `基準日${scout.asOf}、確認できた対象内に条件を満たす底打ち候補はありません。銘柄数を埋めるために候補を作りません。`
                : scout.notes.join("\n");
    const recordId = randomUUID(),
      references = [
        ...(scout.reportId ? [scout.reportId] : []),
        ...scout.rows.flatMap((r) => r.inputRevisionIds),
      ],
      event = {
        schemaVersion: 1,
        kind: "chat",
        recordId,
        createdAt: now.toISOString(),
        question,
        providerCode: code,
        answer,
        references,
        evidence: scout.reportId
          ? [
              {
                recordId: scout.reportId,
                text: `基準日${scout.asOf}。解析${scout.scope?.analyzable ?? 0}銘柄。${scout.notes.join(" ")}`,
              },
            ]
          : [],
        search: "local-bottom-scout",
        model: "deterministic-bottom-scout-v1",
        scout,
      };
    await s.store.write(`chats/local/${recordId}.json`, event, true);
    return event;
  });
}
