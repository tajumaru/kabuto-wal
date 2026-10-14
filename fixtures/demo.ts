import type { Bar, Calendar } from "../packages/core/index";
export const master = [
  { providerCode: "72030", displayCode: "7203", name: "架空モビリティ" },
  {
    providerCode: "67580",
    displayCode: "6758",
    name: "架空エンターテインメント",
  },
  { providerCode: "99840", displayCode: "9984", name: "架空通信グループ" },
  { providerCode: "130A0", displayCode: "130A", name: "架空テクノロジー" },
];
export function calendar(): Calendar {
  const out: Calendar = [];
  for (
    let t = Date.UTC(2019, 0, 1);
    t <= Date.UTC(2028, 11, 31);
    t += 86400000
  ) {
    const d = new Date(t),
      date = d.toISOString().slice(0, 10);
    out.push({
      date,
      open:
        d.getUTCDay() !== 0 &&
        d.getUTCDay() !== 6 &&
        !["01-01", "01-02", "01-03", "12-31"].includes(date.slice(5)),
    });
  }
  return out;
}
export function demoBars(code: string): Bar[] {
  let price = 1000 + master.findIndex((m) => m.providerCode === code) * 500;
  return calendar()
    .filter((d) => d.open && d.date <= "2026-10-09")
    .map((d, i) => {
      price *=
        1 +
        0.003 * Math.sin(i / 13) +
        0.006 * Math.sin(i * 1.713 + code.charCodeAt(0)) +
        0.0001;
      return {
        providerCode: code,
        sessionDate: d.date,
        close: +price.toFixed(2),
        adjClose: +price.toFixed(2),
        adjOpen: +(price * (1 - 0.002 * Math.sin(i))).toFixed(2),
        adjHigh: +(price * 1.008).toFixed(2),
        adjLow: +(price * 0.992).toFixed(2),
        seriesId: "demo-ohlcv-v1",
        volume: Math.round(1000000 * (1.2 + 0.5 * Math.sin(i / 9))),
        factor: 1,
        revisionId: `demo-${code}-${d.date}`,
        availableAt: d.date + "T08:30:00.000Z",
      };
    });
}
