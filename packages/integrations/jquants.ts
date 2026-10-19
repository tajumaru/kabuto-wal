import { randomUUID } from "node:crypto";
import { z } from "zod";
import { barSchema } from "../core/index";
import { earningsSummarySchema, earningsDateSchema } from "../core/earnings-schema";
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
  private plan: string;
  constructor(
    private key: string,
    private fetcher: typeof fetch = fetch,
    options: { gate?: RequestGate; root?: string; plan?: string } = {},
  ) {
    this.plan = options.plan ?? process.env.JQUANTS_PLAN ?? "Free";
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
    if (endpoint.startsWith("fins/")) {
      if (this.plan !== "Light") throw Error("決算分析1.0はJ-Quants Light専用です");
      const allowed = endpoint === "fins/summary" ? ["code", "date"] : endpoint === "fins/earnings-date" ? ["code", "date", "scheduled_date"] : [];
      if (!allowed.length || Object.keys(params).some(k => !allowed.includes(k))) throw Error("未対応の財務APIパラメータ");
      const count = Object.keys(params).length;
      if (!count || (endpoint === "fins/earnings-date" && count !== 1)) throw Error("財務APIの指定条件が不正です");
      for (const [k, v] of Object.entries(params)) {
        if (k === "code") z.string().regex(/^[0-9A-Z]{4,5}$/).parse(v);
        else z.string().date().parse(v.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"));
      }
    }
    if (
      !["equities/bars/daily", "equities/master", "markets/calendar", "fins/summary", "fins/earnings-date"].includes(
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
    if (endpoint.startsWith("fins/")) {
      const schema = endpoint === "fins/summary" ? earningsSummarySchema : earningsDateSchema;
      parsed.data = parsed.data.map(r => schema.parse(r));
      if (params.code && parsed.data.some(r => r.Code !== (params.code.length === 4 ? `${params.code}0` : params.code))) throw Error("対象外の銘柄が含まれています");
      if (params.date && parsed.data.some(r => (endpoint === "fins/summary" ? r.DiscDate : r.PubDate) !== params.date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"))) throw Error("対象外の日付が含まれています");
    }
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
  async financialSummary(params: { code?: string; date?: string }) {
    return (await this.pages("fins/summary", params)).map(r => earningsSummarySchema.parse(r));
  }
  async earningsDates(params: { code?: string; date?: string; scheduled_date?: string }) {
    return (await this.pages("fins/earnings-date", params)).map(r => earningsDateSchema.parse(r));
  }
  async calendar(from: string, to: string) {
    return (await this.pages("markets/calendar", { from, to })).map((r) => ({
      date: z.string().date().parse(r.Date),
      open: ["1", "2"].includes(String(r.HolDiv)),
    }));
  }
}
