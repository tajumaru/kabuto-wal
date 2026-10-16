import "dotenv/config";
import { z } from "zod";
import { Store } from "../packages/storage/index";
import { JQuants } from "../packages/integrations/jquants";
import { MarketIngestion } from "../packages/integrations/market-ingestion";
import {
  dataWindow,
  planCapabilities,
} from "../packages/integrations/jquants-plan";
import type { Calendar } from "../packages/core/index";

// Explicit range, bounded by the subscription; never fetch a whole market on startup.
const args = process.argv.slice(2).filter((a) => a !== "--");
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const from = z.string().date().parse(value("--from")),
  to = z.string().date().parse(value("--to"));
const plan = process.env.JQUANTS_PLAN || "Free",
  key = process.env.JQUANTS_API_KEY;
planCapabilities(plan);
if (process.env.APP_MODE !== "live" || !key)
  throw Error("APP_MODE=liveとJQUANTS_API_KEYが必要です");
const store = new Store(process.env.DATA_DIR || "./data/live");
const settings = await store.read("settings/settings.json", null);
if (settings?.mode !== "live")
  throw Error(
    "既存のlive保存先を指定してください。先に通常のアプリを初期化してください。",
  );
const window = dataWindow(
  plan,
  new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
);
if (from > to || from < window.from || to > window.to)
  throw Error("指定期間が契約範囲外です");
const provider = new JQuants(key, fetch, { root: store.root, plan });
const calendar = (await provider.calendar(from, to)).sort((a, b) =>
  a.date.localeCompare(b.date),
);
await store.lock(async () => {
  const old = await store.read<Calendar>("market/calendar.json", []);
  const merged = new Map(old.map((d) => [d.date, d]));
  for (const d of calendar) merged.set(d.date, d);
  await store.write(
    "market/calendar.json",
    [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)),
  );
});
const ingestion = new MarketIngestion(store, provider, plan);
for (const d of calendar.filter((d) => d.open)) {
  const result = await ingestion.ingestDate(
    d.date,
    value("--revision") || "initial",
  );
  console.log(
    JSON.stringify({
      date: d.date,
      status: result.status,
      pages: result.pages.length,
      count: result.pages.reduce((n, p) => n + p.count, 0),
    }),
  );
}
const code = value("--code");
if (code) {
  const asOf = calendar.filter((d) => d.open).at(-1)?.date;
  if (!asOf) throw Error("指定期間に営業日がありません");
  const result = await ingestion.series(
    code,
    asOf,
    new Date().toISOString(),
    from,
  );
  console.log(
    JSON.stringify({
      code,
      asOf,
      seriesId: result.seriesId,
      count: result.bars.length,
    }),
  );
}
