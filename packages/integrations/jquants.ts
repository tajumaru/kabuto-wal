import { randomUUID } from "node:crypto";
import { z } from "zod";
import { barSchema } from "../core/index";
import {
  JQuantsLimiter,
  jquantsRequest,
  type RequestGate,
} from "./jquants-limiter";

const paginationSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  pagination_key: z.string().min(1).max(2048).nullish(),
});
export class JQuants {
  private gate: RequestGate;
  constructor(
    private key: string,
    private fetcher: typeof fetch = fetch,
    options: { gate?: RequestGate; root?: string; plan?: string } = {},
  ) {
    const rpm = process.env.JQUANTS_REQUESTS_PER_MINUTE;
    this.gate =
      options.gate ??
      new JQuantsLimiter(
        key,
        options.root ?? process.env.DATA_DIR ?? "./data/personal",
        options.plan ?? process.env.JQUANTS_PLAN ?? "Free",
        rpm ? Number(rpm) : undefined,
      );
  }
  async page(
    endpoint: string,
    params: Record<string, string>,
    cursor?: string,
  ) {
    if (
      !["equities/bars/daily", "equities/master", "markets/calendar"].includes(
        endpoint,
      )
    )
      throw Error("未対応API");
    const q = new URLSearchParams({
      ...params,
      ...(cursor ? { pagination_key: cursor } : {}),
    });
    const parsed = paginationSchema.parse(
      await jquantsRequest(
        `https://api.jquants.com/v2/${endpoint}?${q}`,
        this.key,
        this.fetcher,
        this.gate,
      ),
    );
    if (!parsed.data.length && parsed.pagination_key)
      throw Error("空ページに継続キーがあります");
    return { data: parsed.data, next: parsed.pagination_key ?? undefined };
  }
  async pages(endpoint: string, params: Record<string, string>) {
    const data: Record<string, unknown>[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    for (let n = 0; n < 10000; n++) {
      const page = await this.page(endpoint, params, cursor);
      data.push(...page.data);
      if (!page.next) return data;
      if (seen.has(page.next)) throw Error("ページキーの循環");
      seen.add(page.next);
      cursor = page.next;
    }
    throw Error("ページ数上限");
  }
  async daily(code: string, from: string, to: string) {
    const data = await this.pages("equities/bars/daily", { code, from, to });
    const availableAt = new Date().toISOString(),
      seriesId = randomUUID();
    return data.map((b) =>
      barSchema.parse({
        providerCode: b.Code,
        sessionDate: b.Date,
        close: b.C,
        adjClose: b.AdjC,
        volume: b.AdjVo,
        factor: b.AdjFactor ?? 1,
        revisionId: "pending",
        availableAt,
        seriesId,
        open: b.O ?? null,
        high: b.H ?? null,
        low: b.L ?? null,
        rawVolume: b.Vo ?? null,
        adjOpen: b.AdjO ?? null,
        adjHigh: b.AdjH ?? null,
        adjLow: b.AdjL ?? null,
      }),
    );
  }
  async master(date?: string) {
    return this.pages("equities/master", date ? { date } : {});
  }
  async calendar(from: string, to: string) {
    return (await this.pages("markets/calendar", { from, to })).map((r) => ({
      date: z.string().date().parse(r.Date),
      open: ["1", "2"].includes(String(r.HolDiv)),
    }));
  }
}
