import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { JQuants } from "../packages/integrations/jquants";
import { demoBars } from "../fixtures/demo";
import { isStockQuoteQuestion, resolveQuoteStock } from "../apps/api/src/stock-quote";
import { dataWindow } from "../packages/integrations/jquants-plan";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("株価の質問で指定銘柄だけを取得し、調整前終値と日付を回答する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quote-"));
  try {
    vi.stubEnv("JQUANTS_API_KEY", "fixture-key");
    vi.stubEnv("JQUANTS_PLAN", "Free");
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network forbidden"));
    const s = new Service(root, "live", false);
    const end = dataWindow("Free", new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })).to;
    const bar = { ...demoBars("72030").at(-1)!, sessionDate: end, close: 2345, adjClose: 1234 };
    const daily = vi.spyOn(JQuants.prototype, "daily").mockResolvedValue([bar]);
    const result = await s.chat("7203の最新株価を教えて", "67580");
    expect(daily).toHaveBeenCalledTimes(1);
    expect(daily.mock.calls[0][0]).toBe("72030");
    expect(result.answer).toContain("2,345円");
    expect(result.answer).toContain(bar.sessionDate);
    expect(result.answer).toContain("リアルタイム株価ではありません");
    expect((await s.history("72030"))).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
    daily.mockRejectedValue(Error("fixture outage"));
    const fallback = await s.chat("この株の株価を教えて", "72030");
    expect(fallback.answer).toContain("最新の株価とは確認できていません");
    expect(fallback.answer).toContain("2,345円");
    daily.mockResolvedValue([]);
    expect((await s.chat("6758の株価はいくら？")).answer).toContain("終値を確認できませんでした");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("略称と短い質問から銘柄を選び、曖昧な名前や未知の名前で選択銘柄を取得しない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quote-names-"));
  const master = [
    { providerCode: "72030", name: "トヨタ自動車" },
    { providerCode: "33500", name: "メタプラネット" },
    { providerCode: "62010", name: "豊田自動織機" },
    { providerCode: "99990", name: "メタテスト" },
  ];
  try {
    vi.stubEnv("JQUANTS_API_KEY", "fixture-key");
    vi.stubEnv("JQUANTS_PLAN", "Free");
    const s = new Service(root, "live", false);
    await s.store.write("market/master.json", master);
    const end = dataWindow("Free", new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })).to;
    const daily = vi.spyOn(JQuants.prototype, "daily").mockImplementation(async code => [{
      ...demoBars("72030").at(-1)!, providerCode: code, sessionDate: end, close: 2345,
    }]);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network forbidden"));
    for (const [question, code] of [
      ["トヨタの株価は？", "72030"], ["トヨタの", "72030"],
      ["メタプラの？", "33500"], ["じゃあメタプラは？", "33500"],
      ["ﾒﾀﾌﾟﾗの最新株価を教えて", "33500"], ["メタプラネットの終値", "33500"],
    ]) {
      expect(isStockQuoteQuestion(question, master)).toBe(true);
      const event = await s.chat(question, "62010");
      expect(event.providerCode).toBe(code);
      expect(daily.mock.lastCall?.[0]).toBe(code);
      expect(event.answer).toContain("2,345円");
    }
    daily.mockClear();
    expect((await s.chat("メタの株価は？", "72030")).answer).toContain("候補が複数");
    expect((await s.chat("知らない会社の株価は？", "72030")).answer).toContain("銘柄を選ぶ");
    expect(daily).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(isStockQuoteQuestion("どう思うの？", master)).toBe(false);
    expect(isStockQuoteQuestion("トヨタの株価が下がった理由は？", master)).toBe(false);
    expect(resolveQuoteStock("この株の株価は？", master, "72030").code).toBe("72030");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("銘柄不足とDEMOでは外部APIを呼ばず、正式名を解決する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quote-demo-"));
  try {
    const daily = vi.spyOn(JQuants.prototype, "daily").mockRejectedValue(Error("forbidden"));
    const s = new Service(root, "demo", false);
    await s.store.write("market/master.json", [{ providerCode: "72030", name: "架空モビリティ" }]);
    await s.saveBars(demoBars("72030").slice(-1));
    expect((await s.chat("この株の株価を教えて")).answer).toContain("銘柄を選ぶ");
    expect((await s.chat("架空モビリティの株価を教えて")).answer).toContain("DEMOの架空データ");
    expect((await s.chat("6758の終値はいくら？")).answer).toContain("日足はありません");
    expect(daily).not.toHaveBeenCalled();
    expect(isStockQuoteQuestion("株価が下がった理由を教えて")).toBe(false);
    expect(isStockQuoteQuestion("株価とBTCの比較を教えて")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
