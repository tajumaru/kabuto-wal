import { randomUUID, createHash } from "node:crypto";
import { Store } from "../../../packages/storage/index";
import { OpenAiLlm } from "../../../packages/integrations/llm";
import { bitcoin, bitcoinAt } from "../../../packages/integrations/bitcoin";
import { verifyMemwalAccount } from "../../../packages/integrations/sui";
import { collectNotices } from "./assistant";
import { demoBars, calendar, master } from "../../../fixtures/demo";
import {
  evaluate,
  features,
  predictionSchema,
  quantile,
  similar,
  targetDate,
  type Bar,
  type Calendar,
  type Prediction,
} from "../../../packages/core/index";
import {
  JQuants,
  memwal,
  syncMemories,
  LocalLlm,
} from "../../../packages/integrations/index";
export const meta = (kind: string, source = "local") => ({
  schemaVersion: 1,
  recordId: randomUUID(),
  kind,
  createdAt: new Date().toISOString(),
  source,
});
export class Service {
  store: Store;
  mode: string;
  constructor(
    dir = process.env.DATA_DIR || "./data/personal",
    mode = process.env.APP_MODE || "demo",
    public seedDemo = process.env.DEMO_SEED === "true",
  ) {
    this.mode = mode;
    this.store = new Store(dir);
  }
  async init() {
    await this.store.lock(async () => {
      const existing = await this.store.read("settings/settings.json", null);
      if (existing && existing.mode !== this.mode)
        throw Error("demo/liveは異なるDATA_DIRを使用してください");
      if (existing?.seedDemo !== undefined) this.seedDemo = existing.seedDemo;
      for (const [key, value] of [
        [
          "settings/watchlist.json",
          {
            ...meta("watchlist"),
            codes:
              this.mode === "demo" && this.seedDemo
                ? master.slice(0, 3).map((m) => m.providerCode)
                : [],
          },
        ],
        ["market/master.json", this.mode === "demo" ? master : []],
        ["market/calendar.json", this.mode === "demo" ? calendar() : []],
      ] as [string, unknown][]) {
        if (!(await this.store.read(key, null)))
          await this.store.write(key, value);
      }
      if (!existing) {
        await this.store.write("settings/settings.json", {
          ...meta("settings"),
          mode: this.mode,
          seedDemo: this.seedDemo,
          fetchTime: "17:30",
          plan: process.env.JQUANTS_PLAN || "Free",
        });
        await this.store.write("settings/watchlist.json", {
          ...meta("watchlist"),
          codes:
            this.mode === "demo" && this.seedDemo
              ? master.slice(0, 3).map((s) => s.providerCode)
              : [],
        });
        await this.store.write(
          "market/master.json",
          this.mode === "demo" ? master : [],
        );
        await this.store.write(
          "market/calendar.json",
          this.mode === "demo" ? calendar() : [],
        );
      }
      if (
        this.mode === "demo" &&
        this.seedDemo &&
        (await this.store.read("settings/demo-ready.json", null))?.version !==
          "ohlcv-v2"
      ) {
        for (const m of master) await this.saveBars(demoBars(m.providerCode));
        if (!(await this.store.all("memories")).length)
          await this.addMemory(
            "短期の変動だけで判断せず、予測が外れた条件を振り返りたい。",
            "user_memory",
          );
        await this.store.write("settings/demo-ready.json", {
          ...meta("fixture_ready"),
          version: "ohlcv-v2",
        });
      }
      for (const j of await this.store.all("jobs"))
        if (j.status === "running")
          await this.store.write(`jobs/${j.recordId}.json`, {
            ...j,
            status: "interrupted",
            error: "前回の処理が中断。次の取得で再処理",
          });
      for (const file of (await this.store.files("predictions")).filter((k) =>
        k.endsWith("/original.json"),
      )) {
        const p = await this.store.read(file);
        const key = `predictions/${p.predictionId}/state.json`;
        if (!(await this.store.read(key, null)))
          await this.store.write(key, {
            ...meta("prediction_state"),
            status: "pending",
            recovered: true,
          });
      }
      for (const m of await this.store.all("memories")) {
        const key = `sync/${m.recordId}.json`;
        if (!(await this.store.read(key, null)))
          await this.store.write(key, { status: "pending" });
      }
      await this.store.rebuild();
    });
  }
  async memoryProvider() {
    if (this.mode === "demo") return null;
    const provider = memwal();
    if (!provider) return null;
    const check = await verifyMemwalAccount();
    await this.store.write("settings/memwal-check.json", {
      ...meta("memwal_identity_check"),
      ...check,
    });
    return provider;
  }
  async saveBars(bars: Bar[]) {
    const grouped = new Map<string, Bar[]>();
    const ms = await this.store.read("market/master.json", []);
    for (const b of bars) {
      const key = `prices/${b.providerCode}/${b.sessionDate.slice(0, 7)}.json`;
      if (!grouped.has(key)) grouped.set(key, await this.store.read(key, []));
      const rows = grouped.get(key)!;
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            b.close,
            b.adjClose,
            b.volume,
            b.factor,
            b.open,
            b.high,
            b.low,
            b.rawVolume,
            b.adjOpen,
            b.adjHigh,
            b.adjLow,
          ]),
        )
        .digest("hex");
      const old = rows.find((r) => r.sessionDate === b.sessionDate);
      const row = { ...b, revisionId: hash };
      // Preserve each acquisition as well as content revisions: equal prices
      // fetched again may belong to a different adjustment series.
      const observation = createHash("sha256")
        .update(JSON.stringify([b.availableAt, b.seriesId]))
        .digest("hex");
      const revisionPath = `revisions/${b.providerCode}/${b.sessionDate}/${hash}-${observation}.json`;
      if (!(await this.store.read(revisionPath, null)))
        await this.store.write(
          revisionPath,
          {
            ...meta(
              "price_revision",
              this.mode === "demo" ? "fixture" : "jquants-v2",
            ),
            ...row,
            inputRevisionIds: [hash],
            observedAt: b.availableAt,
            displayCode:
              ms.find((m: any) => m.providerCode === b.providerCode)
                ?.displayCode || b.providerCode,
          },
          true,
        );
      if (old) rows[rows.indexOf(old)] = row;
      else rows.push(row);
    }
    for (const [key, rows] of grouped)
      await this.store.write(
        key,
        rows.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate)),
      );
  }
  async history(code: string): Promise<Bar[]> {
    return (await this.store.all<Bar[]>(`prices/${code}`))
      .flat()
      .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  }
  async watch() {
    const w = await this.store.read("settings/watchlist.json");
    const ms = await this.store.read("market/master.json");
    return Promise.all(
      w.codes.map(async (code: string) => {
        const bars = await this.history(code),
          last = bars.at(-1),
          previous = bars.at(-2);
        return {
          ...ms.find((m: any) => m.providerCode === code),
          last,
          change:
            last?.adjClose && previous?.adjClose
              ? last.adjClose / previous.adjClose - 1
              : null,
        };
      }),
    );
  }
  async predictions(): Promise<any[]> {
    const files = (await this.store.files("predictions")).filter((k) =>
      k.endsWith("/original.json"),
    );
    const records = await Promise.all(
      files.map(async (key) => {
        const p = await this.store.read<Prediction>(key);
        const ev = await this.store.all(`evaluations/${p.predictionId}`);
        ev.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const receipt = await this.store.read(
          `commitments/${p.predictionId}.json`,
          null,
        );
        if (receipt) delete receipt.salt;
        return {
          ...p,
          evaluations: ev,
          state: await this.store.read(
            `predictions/${p.predictionId}/state.json`,
          ),
          commitment: receipt,
        };
      }),
    );
    return records.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  }
  async forecast(code: string, horizon: 1 | 5 | 20, date?: string) {
    const bars = await this.history(code),
      asOf = date || bars.at(-1)?.sessionDate;
    if (!asOf) throw Error("日足データなし");
    const input = bars.filter((b) => b.sessionDate <= asOf);
    const matches = similar(input, asOf, horizon);
    if (matches.sampleCount < 20)
      throw Error(
        `予測不能：重複を除いた候補${matches.sampleCount}件（最低20件）`,
      );
    const old = (await this.predictions()).find(
      (p) =>
        p.providerCode === code &&
        p.dataAsOf === asOf &&
        p.horizonSessions === horizon &&
        p.methodVersion === "neighbors-v1",
    );
    if (old) return old;
    const returns = matches.candidates
      .map((c) => c.future[horizon])
      .filter((r): r is number => r !== null);
    const price = input.at(-1)!.adjClose!;
    const now = new Date().toISOString(),
      id = randomUUID();
    const cal = await this.store.read<Calendar>("market/calendar.json");
    const target = targetDate(cal, asOf, horizon);
    const jst = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }),
      today = jst.slice(0, 10),
      time = jst.slice(11, 16);
    const expected = cal
      .filter(
        (d) =>
          d.open && (d.date < today || (d.date === today && time >= "17:30")),
      )
      .at(-1)?.date;
    const liveEligible =
      this.mode === "live" &&
      !date &&
      process.env.JQUANTS_PLAN !== "Free" &&
      !!process.env.JQUANTS_PLAN &&
      asOf === expected &&
      target > today;
    const p = predictionSchema.parse({
      ...meta("prediction", this.mode === "demo" ? "fixture" : "jquants-v2"),
      recordId: id,
      predictionId: id,
      providerCode: code,
      mode: this.mode === "demo" ? "demo" : liveEligible ? "live" : "research",
      generatedAt: now,
      dataAsOf: asOf,
      horizonSessions: horizon,
      targetSessionDate: target,
      referencePrice: price,
      referenceBasis: "adjusted-close / input revision frozen",
      predictedReturn: quantile(returns, 0.5),
      expectedPrice: price * (1 + quantile(returns, 0.5)),
      returnQuantiles: [quantile(returns, 0.1), quantile(returns, 0.9)],
      pUp: returns.filter((r) => r > 0).length / returns.length,
      sampleCount: returns.length,
      inputRevisionIds: input.slice(-21).map((b) => b.revisionId),
      candidateIds: matches.candidates.map((c) => c.id),
      featureVersion: "v1",
      methodVersion: "neighbors-v1",
      model: "local-numeric",
      promptVersion: "v1",
      reason:
        "非重複の過去類似窓から将来リターン中央値を算出。上昇割合は過去サンプル比率です。",
      falsification:
        "出来高や価格形状が類似窓から乖離した場合は仮説を再検討。因果は特定しません。",
    });
    await this.store.write(`predictions/${id}/original.json`, p, true);
    await this.store.write(`predictions/${id}/state.json`, {
      ...meta("prediction_state"),
      status: "pending",
    });
    await this.store.write(`features/${code}/${asOf}.json`, {
      ...meta(
        "market_features",
        this.mode === "demo" ? "fixture" : "jquants-v2",
      ),
      providerCode: code,
      sessionDate: asOf,
      featureVersion: "v1",
      inputRevisionIds: p.inputRevisionIds,
      ...matches.query,
    });
    if (
      process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true" ||
      this.mode === "demo"
    )
      await this.addMemory(
        `予測${p.predictionId}: ${asOf}基準、${horizon}営業日先の仮説。中央値リターン${p.predictedReturn}、候補${p.sampleCount}件。反証条件：${p.falsification}`,
        "prediction_memory",
        code,
      );
    await this.store.rebuild();
    return p;
  }
  async evaluateDue() {
    let count = 0;
    for (const p of await this.predictions()) {
      const bars = await this.history(p.providerCode);
      if (p.targetSessionDate > (bars.at(-1)?.sessionDate || "")) continue;
      const result = evaluate(p, bars);
      if (!result) {
        await this.store.write(`predictions/${p.predictionId}/state.json`, {
          ...meta("prediction_state"),
          status: "missing",
          reason: "期限日の価格欠損",
        });
        continue;
      }
      const hash = createHash("sha256")
        .update(JSON.stringify(result))
        .digest("hex");
      const key = `evaluations/${p.predictionId}/${hash}.json`;
      if (await this.store.read(key, null)) continue;
      await this.store.write(
        key,
        { ...meta("evaluation"), predictionId: p.predictionId, ...result },
        true,
      );
      await this.store.write(`predictions/${p.predictionId}/state.json`, {
        ...meta("prediction_state"),
        status: "evaluated",
      });
      await this.addMemory(
        `予測${p.predictionId}のリターン誤差は${(result.returnError * 100).toFixed(2)}%。原因は価格だけでは特定できません。`,
        "lesson",
        p.providerCode,
      );
      count++;
    }
    return count;
  }
  async addMemory(text: string, kind = "user_memory", code?: string) {
    const existing = (await this.store.all("memories")).find(
      (m) =>
        m.active &&
        m.text === text &&
        m.kind === kind &&
        m.providerCode === code,
    );
    if (existing) return existing;
    const memory = {
      ...meta(kind),
      text,
      active: true,
      providerCode: code,
      contentHash: createHash("sha256")
        .update(JSON.stringify([kind, code, text]))
        .digest("hex"),
      namespace: `kabutowal:v1:${kind === "user_memory" ? "profile" : kind === "prediction_memory" ? `prediction:${code}` : kind === "market_analysis" ? `market:${code}` : kind === "saved_chat" ? `chat:${code || "profile"}` : `lesson:${code}`}`,
    };
    await this.store.write(`memories/${memory.recordId}.json`, memory, true);
    await this.store.write(`sync/${memory.recordId}.json`, {
      status: "pending",
    });
    await this.store.rebuild();
    return memory;
  }
  async memories() {
    return Promise.all(
      (await this.store.all("memories"))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(async (m) => ({
          ...m,
          sync: await this.store.read(`sync/${m.recordId}.json`, {
            status: "pending",
          }),
        })),
    );
  }
  async chat(question: string, code?: string) {
    let records = (await this.memories()).filter(
      (m) =>
        m.active &&
        m.createdAt <= new Date().toISOString() &&
        (!m.providerCode || !code || m.providerCode === code),
    );
    let provider = null;
    let error: string | undefined;
    try {
      provider = await this.memoryProvider();
    } catch {
      error = "MemWal本人・delegateを確認できず、ローカル根拠応答を使用";
    }
    let search = this.mode === "demo" ? "local-demo" : "local-fallback";
    if (provider) {
      try {
        const namespaces = [
          "kabutowal:v1:profile",
          "kabutowal:v1:chat:profile",
          ...(code
            ? [
                `kabutowal:v1:prediction:${code}`,
                `kabutowal:v1:lesson:${code}`,
                `kabutowal:v1:market:${code}`,
                `kabutowal:v1:chat:${code}`,
              ]
            : []),
        ];
        const remotes = await Promise.all(
          [...namespaces, ...namespaces.map((ns) => ns.replace(/^kabutowal:/, "stock-memory:"))].map((namespace) =>
            provider!.recall({
              query:
                process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true"
                  ? question
                  : "利用者の方針 過去の仮説 検証の教訓",
              namespace,
              limit: 10,
            }),
          ),
        );
        const ids = remotes
          .flatMap((remote) => remote.results)
          .flatMap((r) => {
            try {
              return [JSON.parse(r.text).recordId];
            } catch {
              return [];
            }
          });
        records = records.filter((m) => ids.includes(m.recordId));
        search = "memwal-semantic";
      } catch {
        error = "MemWal未接続。ローカル記録に基づく応答";
      }
    }
    const localEvidence = records
      .slice(-5)
      .map((m) => ({ recordId: m.recordId, text: m.text }));
    const evidence = [...localEvidence];
    const related = (await this.predictions())
      .filter((p) => !code || p.providerCode === code)
      .slice(-3);
    if (related.length)
      evidence.push({
        recordId: related.at(-1)!.recordId,
        text: `この対象には保存済みの予測が${related.length}件あるよ。基準日・期限・実績を比較してみよう。`,
      });
    const previousAnalysis = records.filter(
      (m) => m.kind === "market_analysis",
    );
    if (previousAnalysis.length)
      evidence.push({
        recordId: previousAnalysis.at(-1)!.recordId,
        text: `この対象は前にも分析しているよ。参照できる分析記憶${previousAnalysis.length}件と、現在の取得済み数値を比べてみよう。`,
      });
    for (const p of related)
      evidence.push({
        recordId: p.recordId,
        text: `予測（仮説） ${p.dataAsOf}→${p.targetSessionDate} : ${JSON.stringify({ predictedReturn: p.predictedReturn, sampleCount: p.sampleCount, evaluation: p.evaluations.at(-1) || null })}`,
      });
    if (code) {
      const bars = await this.history(code),
        last = bars.at(-1);
      if (last)
        evidence.push({
          recordId: last.revisionId,
          text: `株価の事実（${this.mode === "demo" ? "架空" : "取得日足"}）基準日 ${last.sessionDate} 終値 ${last.adjClose} / 取得 ${last.availableAt}`,
        });
    }
    if (code && /分析|似た|類似|比較/.test(question)) {
      const bars = await this.history(code);
      if (bars.length >= 21) {
        try {
          const matches = similar(bars, bars.at(-1)!.sessionDate);
          evidence.push({
            recordId: `analysis-${code}-${bars.at(-1)!.sessionDate}`,
            text: `取得済み20営業日窓の数値分析：候補${matches.candidateCount}件、重複除外後${matches.sampleCount}件、上位類似${matches.examples.length}件。基準日${bars.at(-1)!.sessionDate}。価格形状の距離であり将来の確率ではありません。`,
          });
        } catch {
          evidence.push({
            recordId: `missing-${code}`,
            text: "欠損のため数値による類似分析を実行できません。",
          });
        }
      }
    }
    if (!code && /注目|おすすめ|ウォッチリスト/.test(question)) {
      const stocks = await this.watch();
      for (const s of stocks
        .filter((s) => s.change !== null)
        .sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!))
        .slice(0, 3))
        evidence.push({
          recordId: s.last!.revisionId,
          text: `ウォッチリストの変動幅による確認候補：${s.name} (${s.providerCode})、基準日${s.last!.sessionDate}、前営業日比${(s.change! * 100).toFixed(2)}%。投資推奨や利益予測ではありません。`,
        });
    }
    if (this.mode !== "demo" && /ビットコイン|bitcoin|\bBTC\b/i.test(question)) {
      try {
        const btc = await bitcoin(this.store);
        const latest = btc.prices.at(-1)!;
        evidence.push({ recordId: `btc-${latest[0]}`, text: `BTC価格（CoinGecko・円建て）：${latest[1].toLocaleString("ja-JP")}円。観測時刻 ${new Date(latest[0]).toISOString()}。取得時刻 ${btc.fetchedAt}。` });
        if (code) {
          const bars = (await this.history(code)).slice(-2);
          if (bars.length === 2) {
            const [previous, last] = bars;
            const a = bitcoinAt(btc.prices, previous.sessionDate), b = bitcoinAt(btc.prices, last.sessionDate);
            if (a && b && previous.adjClose !== null && last.adjClose !== null && previous.adjClose > 0) evidence.push({ recordId: `btc-compare-${code}-${last.sessionDate}`, text: `BTCと株価の比較：${previous.sessionDate}→${last.sessionDate}、株価 ${(100 * (last.adjClose / previous.adjClose - 1)).toFixed(2)}％、BTC ${(100 * (b[1] / a[1] - 1)).toFixed(2)}％。BTCは各日の日本時間15:30以前の直近観測値（最大2時間前）を使用：${new Date(a[0]).toISOString()} / ${new Date(b[0]).toISOString()}。同期間の変動比較であり因果関係を示しません。` });
            else evidence.push({recordId: "btc-comparison-unavailable", text: "株価の日付に対応するBTC観測値が不足しているため、同期間の比較はできません。"});
          }
        }
      } catch (e) {
        evidence.push({recordId: "btc-unavailable", text: e instanceof Error ? e.message : "BTC価格を取得できませんでした。"});
      }
    }
    const groupedEvidence = new Map<string, string[]>();
    for (const item of evidence) {
      const texts = groupedEvidence.get(item.recordId) || [];
      if (!texts.includes(item.text)) texts.push(item.text);
      groupedEvidence.set(item.recordId, texts);
    }
    evidence.splice(
      0,
      evidence.length,
      ...[...groupedEvidence].map(([recordId, texts]) => ({
        recordId,
        text: texts.join("\n"),
      })),
    );
    let model = "local-grounded";
    let answer;
    if (
      this.mode !== "demo" &&
      process.env.LLM_PROVIDER === "openai" &&
      process.env.LLM_API_KEY &&
      process.env.LLM_MODEL
    ) {
      const external =
        process.env.ALLOW_MARKET_DATA_TO_LLM === "true"
          ? evidence
          : localEvidence.filter(
              (e) =>
                records.find((m) => m.recordId === e.recordId)?.kind ===
                "user_memory",
            );
      // Questions may contain copied provider prices: deny all external calls until permission is explicit.
      if (process.env.ALLOW_MARKET_DATA_TO_LLM === "true") {
        try {
          answer = await new OpenAiLlm(
            process.env.LLM_API_KEY,
            process.env.LLM_MODEL,
          ).answer(question, external);
          model = process.env.LLM_MODEL;
        } catch {
          error = "外部LLM応答を検証できず、ローカル根拠応答へ切替";
        }
      }
    }
    answer ??= await new LocalLlm().answer(question, evidence);
    const event = {
      ...meta("chat"),
      question,
      providerCode: code,
      ...answer,
      evidence,
      search,
      error,
      model,
    };
    await this.store.write(`chats/local/${event.recordId}.json`, event, true);
    return event;
  }
  async job() {
    const j = { ...meta("job"), status: "running", steps: [] as any[] };
    await this.store.write(`jobs/${j.recordId}.json`, j);
    try {
      if (this.mode !== "demo") {
        if (!process.env.JQUANTS_API_KEY) throw Error("JQUANTS_API_KEY未設定");
        const provider = new JQuants(process.env.JQUANTS_API_KEY);
        const today = new Date().toLocaleDateString("sv-SE", {
          timeZone: "Asia/Tokyo",
        });
        const plan = process.env.JQUANTS_PLAN || "Free";
        const years = plan === "Free" ? 2 : plan === "Light" ? 5 : 10;
        const delay = plan === "Free" ? 84 : 0;
        const end = new Date(Date.now() - delay * 86400000)
          .toISOString()
          .slice(0, 10);
        const from = new Date(Date.now() - 86400000 * 365 * years)
          .toISOString()
          .slice(0, 10);
        const ms = await provider.master();
        await this.store.write(
          "market/master.json",
          ms.map((m) => ({
            providerCode: m.Code,
            displayCode: m.Code,
            name: m.CoName,
          })),
        );
        await this.store.write(
          "market/calendar.json",
          await provider.calendar(
            from,
            new Date(Date.now() + 86400000 * 90).toISOString().slice(0, 10),
          ),
        );
        const watch = await this.store.read("settings/watchlist.json");
        const cal = await this.store.read<Calendar>("market/calendar.json");
        const expected = cal
          .filter((d) => d.open && d.date <= end)
          .at(-1)?.date;
        for (const code of watch.codes) {
          const bars = (await provider.daily(code, from, end)).sort((a, b) =>
            a.sessionDate.localeCompare(b.sessionDate),
          );
          await this.saveBars(bars);
          if (bars.length >= 21) {
            const latest = bars.at(-1)!;
            await this.store.write(
              `features/${code}/${latest.sessionDate}.json`,
              {
                ...meta("market_features", "jquants-v2"),
                providerCode: code,
                sessionDate: latest.sessionDate,
                featureVersion: "v1",
                observedAt: new Date().toISOString(),
                availableAt: latest.availableAt,
                inputRevisionIds: bars.slice(-21).map((b) => b.revisionId),
                ...features(bars, bars.length - 1),
              },
            );
          }
          j.steps.push({
            step: "prices",
            code,
            count: bars.length,
            status: bars.at(-1)?.sessionDate === expected ? "ok" : "missing",
            dataAsOf: bars.at(-1)?.sessionDate,
            requestedThrough: end,
            today,
          });
        }
      }
      j.steps.push({ step: "evaluation", count: await this.evaluateDue() });
      if (process.env.ENABLE_AUTO_FORECAST === "true")
        for (const stock of await this.watch())
          for (const h of [1, 5, 20] as const) {
            try {
              await this.forecast(stock.providerCode, h);
            } catch (e) {
              j.steps.push({
                step: "forecast",
                code: stock.providerCode,
                horizon: h,
                error: (e as Error).message,
              });
            }
          }
      try {
        await syncMemories(
          this.store,
          await this.memoryProvider(),
          process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true",
        );
      } catch (e) {
        j.steps.push({
          step: "memwal",
          status: "unconnected",
          error: (e as Error).message,
        });
      }
      await collectNotices(this);
      j.status = "done";
    } catch (e) {
      j.status = "failed";
      j.steps.push({ error: (e as Error).message });
    }
    await this.store.write(`jobs/${j.recordId}.json`, j);
    return j;
  }
}
