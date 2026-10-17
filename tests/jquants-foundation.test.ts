import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/storage/index";
import {
  planCapabilities,
  dataWindow,
} from "../packages/integrations/jquants-plan";
import {
  JQuantsLimiter,
  jquantsRequest,
  retryAfter,
  RequestDeferred,
} from "../packages/integrations/jquants-limiter";
import {
  adjustedSeries,
  hash,
  type RawDaily,
} from "../packages/integrations/adjusted-series";
import { JQuants } from "../packages/integrations/jquants";
import {
  MarketIngestion,
  readDerivedSeries,
} from "../packages/integrations/market-ingestion";
const gate = { wait: async () => {}, deferUntil: async () => {} };
it("Retry-Afterのない429は1分待機し、制限継続時は再開可能な待機にする", async () => {
  const started = Date.now();
  const limiter = { wait: vi.fn(async () => {}), deferUntil: vi.fn<(time: number) => Promise<void>>().mockResolvedValue(undefined) };
  const fetcher = vi.fn().mockImplementation(async () => new Response("", { status: 429 }));
  await expect(jquantsRequest("https://api.jquants.com/v2/test", "fixture", fetcher, limiter)).rejects.toBeInstanceOf(RequestDeferred);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(limiter.deferUntil.mock.calls.every(call => Number(call[0]) >= started + 60000)).toBe(true);
});
const dates = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
const calendar = dates.map((date) => ({ date, open: true }));
const raw = (date: string, extra: Partial<RawDaily> = {}): RawDaily => ({
  Code: "72030",
  Date: date,
  O: 100,
  H: 100,
  L: 100,
  C: 100,
  Vo: 1000,
  Va: 200000000,
  AdjFactor: 1,
  ExRT: null,
  ...extra,
});
const observation = (row: RawDaily, time = "2026-10-16T09:00:00.000Z") => ({
  row,
  observedAt: time,
  revisionId: hash(row),
});

it("Freeの遅延を含む窓、閏日、Premium、未知プラン・超過を検査", () => {
  expect(dataWindow("Free", "2026-10-17")).toEqual({
    from: "2024-07-25",
    to: "2026-07-25",
  });
  expect(dataWindow("Light", "2024-02-29").from).toBe("2019-02-28");
  expect(planCapabilities("Premium")).toMatchObject({
    years: 20,
    requestsPerMinute: 400,
  });
  expect(() => planCapabilities("unknown")).toThrow();
  expect(() => planCapabilities("Free", 6)).toThrow();
});
it("同じキー・保存先の別インスタンスが予算とRetry-Afterを共有", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jq-budget-"));
  let now = 100000;
  const waits: number[] = [],
    sleep = async (ms: number) => {
      waits.push(ms);
      now += ms;
    };
  const a = new JQuantsLimiter(
    "secret-test-key",
    dir,
    "Free",
    4,
    () => now,
    sleep,
  );
  const b = new JQuantsLimiter(
    "secret-test-key",
    dir,
    "Free",
    4,
    () => now,
    sleep,
  );
  try {
    await a.wait();
    await b.wait();
    expect(waits).toEqual([15000]);
    await a.deferUntil(now + 60000);
    await b.wait();
    expect(waits.at(-1)).toBe(60000);
    await a.deferUntil(now + 400000);
    await expect(b.wait()).rejects.toBeInstanceOf(RequestDeferred);
    const contents = JSON.stringify(await new Store(dir).all("market"));
    expect(contents).not.toContain("secret-test-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("429のHTTP-dateを短縮せず、各retryをgateに通し、401を再試行しない", async () => {
  const now = Date.now(),
    at = new Date(Math.floor(now / 1000) * 1000 + 60000).toUTCString();
  expect(retryAfter("60", now)).toBe(now + 60000);
  expect(retryAfter(at, now)).toBe(Date.parse(at));
  const limiter = {
    wait: vi.fn(async () => {}),
    deferUntil: vi.fn(async () => {}),
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": at } }),
    )
    .mockResolvedValueOnce(new Response('{"data":[]}'));
  await jquantsRequest(
    "https://api.jquants.com/v2/test",
    "fake",
    fetcher,
    limiter,
  );
  expect(limiter.wait).toHaveBeenCalledTimes(2);
  expect(limiter.deferUntil).toHaveBeenCalledWith(Date.parse(at));
  fetcher.mockReset().mockResolvedValue(new Response("", { status: 401 }));
  await expect(
    jquantsRequest("https://api.jquants.com/v2/test", "fake", fetcher, limiter),
  ).rejects.toThrow("401");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("分割・併合・ライツと未来係数・取得時点を区別して再構成", () => {
  const rows = [
    raw(dates[0], { C: 100, O: 100, H: 100, L: 100 }),
    raw(dates[1], {
      C: 50,
      O: 50,
      H: 50,
      L: 50,
      Vo: 2000,
      AdjFactor: 0.5,
      ExRT: "1",
    }),
    raw(dates[2], { C: 100, O: 100, H: 100, L: 100, AdjFactor: 2, ExRT: "2" }),
  ];
  const before = adjustedSeries(
    rows.map((r) => observation(r)),
    "72030",
    dates[1],
    "2026-10-17T00:00:00.000Z",
    calendar,
  );
  expect(before.bars.map((b) => b.adjClose)).toEqual([50, 50]);
  expect(before.bars.map((b) => b.volume)).toEqual([2000, 2000]);
  const after = adjustedSeries(
    rows.map((r) => observation(r)),
    "72030",
    dates[2],
    "2026-10-17T00:00:00.000Z",
    calendar,
  );
  expect(after.bars.map((b) => b.adjClose)).toEqual([100, 100, 100]);
  expect(new Set(after.bars.map((b) => b.seriesId)).size).toBe(1);
  const rights = adjustedSeries(
    [
      observation(raw(dates[0])),
      observation(raw(dates[1], { AdjFactor: 0.8, ExRT: "3" })),
    ],
    "72030",
    dates[1],
    "2026-10-17T00:00:00.000Z",
    calendar,
  );
  expect(rights.bars[0].adjClose).toBe(80);
  expect(rights.bars[0].volume).toBe(1000);
  expect(() =>
    adjustedSeries(
      [observation(raw(dates[0])), observation(raw(dates[2]))],
      "72030",
      dates[2],
      "2026-10-17T00:00:00.000Z",
      calendar,
    ),
  ).toThrow("連続");
  expect(() =>
    adjustedSeries(
      rows.map((r) => observation(r)),
      "72030",
      dates[2],
      "2026-10-15T00:00:00.000Z",
      calendar,
    ),
  ).toThrow("原本不足");
  expect(() =>
    adjustedSeries(
      [observation(raw(dates[0], { AdjFactor: 0.5, ExRT: null }))],
      "72030",
      dates[0],
      "2026-10-17T00:00:00.000Z",
      calendar,
    ),
  ).toThrow("企業行動");
});
it("ページ中断から再開し、完了原本・売買代金・バックアップを保持", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jq-ingest-")),
    store = new Store(dir);
  let crash = true;
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/master"))
      return new Response(
        JSON.stringify({
          data: [
            { Code: "72030", CoName: "test", Sector33: "test" },
            { Code: "67580" },
          ],
        }),
      );
    const date = url.searchParams.get("date")!;
    if (!url.searchParams.get("pagination_key"))
      return new Response(
        JSON.stringify({ data: [raw(date)], pagination_key: "next" }),
      );
    if (crash) throw Error("connection interrupted");
    return new Response(
      JSON.stringify({ data: [raw(date, { Code: "67580" })] }),
    );
  });
  const provider = new JQuants("fake", fetcher as typeof fetch, { gate });
  const ingestion = new MarketIngestion(
    store,
    provider,
    "Light",
    () => new Date("2026-10-17T01:00:00.000Z"),
  );
  try {
    await store.write("market/calendar.json", calendar);
    await expect(ingestion.ingestDate(dates[0])).rejects.toThrow();
    const checkpoint = await store.read(
      `market/ingestion/${dates[0]}/initial/checkpoint.json`,
    );
    expect(checkpoint.pages).toHaveLength(1);
    expect(checkpoint.next).toBe("next");
    expect(checkpoint.lease).toBeUndefined();
    crash = false;
    fetcher.mockClear();
    await ingestion.ingestDate(dates[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("pagination_key=next");
    await ingestion.ingestDate(dates[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const series = await ingestion.series(
      "72030",
      dates[0],
      "2026-10-18T00:00:00.000Z",
      dates[0],
    );
    expect(series.turnover[0].value).toBe(200000000);
    expect(
      await readDerivedSeries(
        store,
        "72030",
        dates[0],
        "2026-10-18T00:00:00.000Z",
      ),
    ).not.toBeNull();
    expect(
      await readDerivedSeries(
        store,
        "72030",
        dates[0],
        "2026-10-16T00:00:00.000Z",
      ),
    ).toBeNull();
    const encrypted = await store.export("test-passphrase-long");
    const restored = new Store(path.join(dir, "restored"));
    await restored.import(encrypted, "test-passphrase-long");
    expect(
      (
        await readDerivedSeries(
          restored,
          "72030",
          dates[0],
          "2026-10-18T00:00:00.000Z",
        )
      )?.seriesId,
    ).toBe(series.seriesId);
    await expect(ingestion.ingestDate("2026-10-18")).rejects.toThrow("契約");
    await expect(
      ingestion.series("72030", dates[1], "2026-10-18T00:00:00.000Z", dates[0]),
    ).rejects.toThrow("指定期間");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
