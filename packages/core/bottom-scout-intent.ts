import { z } from "zod";
export const scoutIntentSchema = z.object({
  kind: z.enum(["ranking", "detail", "review"]),
  count: z.number().int().min(1).max(10),
  code: z
    .string()
    .regex(/^[0-9A-Z]{5}$/)
    .nullable(),
  date: z.string().date().nullable(),
  relative: z.enum(["latest", "yesterday"]),
  needsCode: z.boolean(),
});
export type ScoutIntent = z.infer<typeof scoutIntentSchema>;
export function parseScoutIntent(
  question: string,
  selectedCode?: string,
): ScoutIntent | null {
  const q = question.normalize("NFKC");
  if (!/底打|反発しそう|反転しそう|底値候補/.test(q)) return null;
  const countText = q.match(/(\d+)\s*(?:つ|銘柄|件|社)/)?.[1],
    kanji = q.match(/([一二三四五六七八九十])\s*(?:つ|銘柄|件|社)/)?.[1],
    count = countText
      ? Number(countText)
      : kanji
        ? "一二三四五六七八九十".indexOf(kanji) + 1
        : 5;
  const match = q.replace(/\d{4}-\d{2}-\d{2}/g, "")
      .match(
        /(?:^|[^0-9A-Z])([0-9]{4}|[0-9]{3}[A-Z]|[0-9A-Z]{5})(?![0-9A-Z])/i,
      )?.[1]
      ?.toUpperCase(),
    detail = !!match || /この銘柄|この株|そろそろ底打/.test(q),
    code = match ?? (detail ? selectedCode?.toUpperCase() : undefined),
    review = /どうな|結果|成績|振り返/.test(q) && /昨日|過去|候補/.test(q);
  return scoutIntentSchema.parse({
    kind: review ? "review" : detail ? "detail" : "ranking",
    count: Math.max(1, Math.min(10, count)),
    code: code ? (code.length === 4 ? `${code}0` : code) : null,
    date: q.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
    relative: /昨日/.test(q) ? "yesterday" : "latest",
    needsCode: detail && !code && !review,
  });
}
