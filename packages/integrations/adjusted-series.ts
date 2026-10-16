import { createHash } from "node:crypto";
import { z } from "zod";
import { barSchema, type Calendar } from "../core/index";

const price = z.number().positive().nullable();
export const rawDailySchema = z
  .object({
    Code: z.string().regex(/^[A-Z0-9]{4,5}$/),
    Date: z.string().date(),
    O: price,
    H: price,
    L: price,
    C: price,
    Vo: z.number().nonnegative().nullable(),
    Va: z.number().nonnegative().nullable(),
    AdjFactor: z.number().positive(),
    ExRT: z.enum(["1", "2", "3"]).nullish(),
  })
  .superRefine((b, ctx) => {
    const items = [b.O, b.H, b.L, b.C, b.Vo, b.Va];
    if (items.some((v) => v === null) && !items.every((v) => v === null))
      ctx.addIssue({ code: "custom", message: "OHLCV・売買代金の部分欠損" });
    if (
      b.H !== null &&
      (b.H < Math.max(b.O!, b.C!) || b.L! > Math.min(b.O!, b.C!) || b.H < b.L!)
    )
      ctx.addIssue({ code: "custom", message: "不正なOHLC" });
  });
export type RawDaily = z.infer<typeof rawDailySchema>;
export type RawObservation = {
  row: RawDaily;
  observedAt: string;
  revisionId: string;
};
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const ADJUSTMENT_VERSION = "raw-factor-asof-v1";
const rounded = (value: number | null, factor: number) =>
  value === null
    ? null
    : Math.round((value * factor + Number.EPSILON) * 10) / 10;

export function adjustedSeries(
  observations: RawObservation[],
  code: string,
  asOf: string,
  cutoff: string,
  calendar: Calendar,
) {
  z.string().date().parse(asOf);
  z.string().datetime().parse(cutoff);
  const known = new Map<string, RawObservation>();
  for (const entry of observations) {
    const b = rawDailySchema.parse(entry.row);
    if (
      b.Code !== code ||
      b.Date > asOf ||
      Date.parse(entry.observedAt) > Date.parse(cutoff)
    )
      continue;
    z.string().datetime().parse(entry.observedAt);
    if (hash(b) !== entry.revisionId) throw Error("原本hashが一致しません");
    const old = known.get(b.Date);
    if (!old || old.observedAt < entry.observedAt)
      known.set(b.Date, { ...entry, row: b });
    else if (
      old.observedAt === entry.observedAt &&
      old.revisionId !== entry.revisionId
    )
      throw Error("同時刻の原本が競合しています");
  }
  const rows = [...known.values()].sort((a, b) =>
    a.row.Date.localeCompare(b.row.Date),
  );
  if (!rows.length || rows.at(-1)!.row.Date !== asOf)
    throw Error("基準日の原本不足");
  const dates = calendar
    .filter((d) => d.open && d.date >= rows[0].row.Date && d.date <= asOf)
    .map((d) => d.date)
    .sort();
  if (
    dates.length !== rows.length ||
    dates.some((d, i) => d !== rows[i].row.Date)
  )
    throw Error("連続営業日の原本不足");
  const inputManifest = rows.map((r) => ({
    date: r.row.Date,
    revisionId: r.revisionId,
    observedAt: r.observedAt,
  }));
  const seriesId = hash([ADJUSTMENT_VERSION, code, asOf, inputManifest]);
  let priceFactor = 1,
    volumeFactor = 1;
  const bars = [...rows]
    .reverse()
    .map(({ row: b, observedAt, revisionId }) => {
      if (b.AdjFactor !== 1 && !b.ExRT)
        throw Error("企業行動区分がなく調整できません");
      const result = barSchema.parse({
        providerCode: code,
        sessionDate: b.Date,
        close: b.C,
        open: b.O,
        high: b.H,
        low: b.L,
        rawVolume: b.Vo,
        adjOpen: rounded(b.O, priceFactor),
        adjHigh: rounded(b.H, priceFactor),
        adjLow: rounded(b.L, priceFactor),
        adjClose: rounded(b.C, priceFactor),
        volume: rounded(b.Vo, 1 / volumeFactor),
        factor: b.AdjFactor,
        availableAt: observedAt,
        seriesId,
        revisionId: hash([
          ADJUSTMENT_VERSION,
          revisionId,
          priceFactor,
          volumeFactor,
        ]),
      });
      priceFactor *= b.AdjFactor;
      if (b.ExRT !== "3") volumeFactor *= b.AdjFactor;
      if (
        !Number.isFinite(priceFactor) ||
        !Number.isFinite(volumeFactor) ||
        priceFactor <= 0 ||
        volumeFactor <= 0
      )
        throw Error("調整係数が計算範囲外です");
      return result;
    })
    .reverse();
  return {
    bars,
    seriesId,
    adjustmentVersion: ADJUSTMENT_VERSION,
    inputManifest,
    turnover: rows.map((r) => ({ date: r.row.Date, value: r.row.Va })),
  };
}
