import { searchDejavuContext } from "./hunter-research";
import { notifyDejavu, saveDejavu, recallDejavu } from "./dejavu";
import { registerDejavuJournal } from "./dejavu-journal";
import { registerBottom } from "./bottom";
import { registerHunter, ensureHunterWatchMaster } from "./hunter";
import { syncMemories, syncWarning, verifyMemoryBinding } from "../../../packages/integrations/index";
import Fastify from "fastify";
import { DeleteApiError, registerMemoryDelete } from "./memory-delete";
import { registerMemoryReset } from "./memory-reset";
import { registerBlobDelete } from "./blob-delete";
import { fetchCryptoWatch } from "../../../packages/integrations/crypto-watch";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { z } from "zod";
import { Service, meta } from "./service";
import { collectNotices } from "./assistant";
import { demoBars } from "../../../fixtures/demo";
import { features } from "../../../packages/core/index";
import { aggregate, walkForward } from "../../../packages/core/analysis";
import {
  prepareAnchor,
  verifyAnchor,
} from "../../../packages/integrations/anchor";
const code = z.string().regex(/^[A-Z0-9]{4,5}$/);
const id = z.string().uuid();
export async function createApp(
  service = new Service(),
  allowedOrigins = [process.env.APP_ORIGIN || "http://localhost:5173"],
) {
  if (
    service.mode !== "demo" &&
    (!process.env.OWNER_ADDRESS ||
      !process.env.SESSION_SECRET ||
      process.env.SESSION_SECRET.length < 32)
  )
    throw Error("実モードにはOWNER_ADDRESSと32文字以上のSESSION_SECRETが必要");
  await service.init();
  let memwalVerified = false;
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie);
  const secret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
  app.setErrorHandler((err, req, reply) =>
    reply.code(err instanceof DeleteApiError ? err.statusCode : err instanceof Error && err.message.startsWith("別の処理（日足取得など）") ? 503 : 400).send({
      error: err instanceof Error ? err.message : "処理に失敗しました",
      ...(err instanceof DeleteApiError ? { code: err.code } : {}),
    }),
  );
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin &&
      !allowedOrigins.includes(req.headers.origin)
    )
      return reply.code(403).send({ error: "Origin不一致" });
    if (
      service.mode === "demo" ||
      req.url.startsWith("/api/auth/") ||
      req.url === "/api/wallet-config"
    )
      return;
    const value = req.cookies.session;
    const [payload, mac] = value?.split(".") || [];
    if (!payload || !mac)
      return reply.code(401).send({ error: "本人ウォレット認証が必要" });
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    if (
      mac.length !== expected.length ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
    )
      return reply.code(401).send({ error: "無効なセッション" });
    try {
      const session = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (
        session.expires < Date.now() ||
        session.owner !== process.env.OWNER_ADDRESS
      )
        throw Error();
    } catch {
      return reply.code(401).send({ error: "セッション期限切れ" });
    }
  });
  registerMemoryDelete(app, service);
  registerMemoryReset(app, service);
  registerBlobDelete(app, service);
  registerDejavuJournal(app, service);
  registerBottom(app, service);
  registerHunter(app, service);
  app.get("/api/auth/challenge", async () =>
    service.store.lock(async () => {
      const nonce = randomBytes(32).toString("hex"),
        hash = createHash("sha256").update(nonce).digest("hex");
      const challenge = {
        ...meta("nonce"),
        nonce,
        domain: process.env.APP_ORIGIN || "http://localhost:5173",
        network: process.env.SUI_NETWORK || "mainnet",
        purpose: "KABUTO WAL owner login",
        expires: Date.now() + 5 * 60 * 1000,
        used: false,
      };
      const message = JSON.stringify(challenge);
      await service.store.write(
        `nonces/${hash}.json`,
        { ...challenge, message },
        true,
      );
      return { message, nonce };
    }),
  );
  app.post("/api/auth/verify", async (req, reply) =>
    service.store.lock(async () => {
      const body = z
        .object({
          nonce: z.string().regex(/^[a-f0-9]{64}$/),
          signature: z.string().min(1),
        })
        .parse(req.body);
      const hash = createHash("sha256").update(body.nonce).digest("hex");
      const challenge = await service.store.read(`nonces/${hash}.json`, null);
      if (!challenge || challenge.used || challenge.expires < Date.now())
        return reply.code(401).send({ error: "nonce期限切れ・使用済み" });
      const pk = await verifyPersonalMessageSignature(
        Buffer.from(challenge.message),
        body.signature,
      );
      if (pk.toSuiAddress() !== process.env.OWNER_ADDRESS)
        return reply.code(403).send({ error: "OWNER_ADDRESS不一致" });
      await service.store.write(`nonces/${hash}.json`, {
        ...challenge,
        used: true,
      });
      const payload = Buffer.from(
        JSON.stringify({
          owner: pk.toSuiAddress(),
          expires: Date.now() + 3600000,
        }),
      ).toString("base64url");
      const mac = createHmac("sha256", secret).update(payload).digest("hex");
      reply.setCookie("session", payload + "." + mac, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.APP_ORIGIN?.startsWith("https://"),
        path: "/",
        maxAge: 3600,
      });
      return { ok: true };
    }),
  );
  app.post("/api/auth/logout", async (_, reply) => {
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/status", async () => ({
    mode: service.mode,
    delayDays:
      service.mode === "demo"
        ? 0
        : process.env.JQUANTS_PLAN === "Free"
          ? 84
          : 0,
    market:
      service.mode === "demo"
        ? "架空fixture"
        : process.env.JQUANTS_API_KEY
          ? "設定済み・実接続未検証"
          : "未接続",
    memory:
      service.mode === "demo"
        ? "ローカルデモ（意味検索なし）"
        : process.env.MEMWAL_ACCOUNT_ID
          ? memwalVerified
            ? "owner・delegate確認済み（保存・検索は未検証）"
            : "設定済み・owner/delegate確認が必要"
          : "未接続",
    llm:
      process.env.LLM_PROVIDER === "openai" &&
      process.env.LLM_API_KEY &&
      process.env.LLM_MODEL
        ? "外部LLM設定済み・実接続未検証"
        : "ローカル根拠応答（外部LLM未接続）",
    sui:
      process.env.ENABLE_SUI_COMMITMENTS === "true"
        ? "testnet予測アンカー設定あり・実接続未検証"
        : "本人署名 / 予測アンカー未配備",
    allowMemwal: process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true",
    allowLlm: process.env.ALLOW_MARKET_DATA_TO_LLM === "true",
    settings: await service.store.read("settings/settings.json"),
    jobs: (await service.store.all("jobs"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-5),
  }));
  app.get("/api/master", async () => service.store.read("market/master.json"));
  app.get("/api/crypto/watch", async () => service.store.read("crypto/watch-v2.json", {assets: [], fetchedAt: null}));
  app.post("/api/crypto/watch", async () => service.store.lock(() => fetchCryptoWatch(service.store)));
  app.get("/api/assistant", async () =>
    service.store.lock(() => collectNotices(service)),
  );
  app.post("/api/assistant/save-chat", async (req) =>
    service.store.lock(async () => {
      const body = z.object({ eventId: id }).parse(req.body);
      const event = await service.store.read(
        `chats/local/${body.eventId}.json`,
      );
      return service.addMemory(
        `保存した会話\n質問：${event.question}\n回答：${event.answer}\n参照ID：${event.references.join(", ")}`,
        "saved_chat",
        event.providerCode,
      );
    }),
  );
  app.get("/api/watchlist", async () => service.watch());
  app.post("/api/watchlist", async (req) =>
    service.store.lock(async () => {
      const body = z.object({ code, hunterJobId: id.optional() }).parse(req.body),
        ms = await service.store.read("market/master.json");
      const known = ms.some((m: { providerCode: string }) => m.providerCode === body.code);
      if (!known && !body.hunterJobId)
        throw Error("マスターにない提供コード");
      const w = await service.store.read("settings/watchlist.json");
      if (!w.codes.includes(body.code) && w.codes.length >= 10) throw Error("監視は10銘柄まで");
      if (!known && body.hunterJobId) await ensureHunterWatchMaster(service, body.code, body.hunterJobId, ms);
      await service.store.write("assistant/watch-state.json", {
        codes: [...w.codes],
        revision: Date.now().toString(),
      });
      if (!w.codes.includes(body.code)) {
        if (w.codes.length >= 10) throw Error("監視は10銘柄まで");
        w.codes.push(body.code);
      }
      if (
        service.mode === "demo" &&
        !service.seedDemo &&
        !(await service.history(body.code)).length
      )
        await service.saveBars(demoBars(body.code));
      await service.store.write("settings/watchlist.json", w);
      await collectNotices(service);
      return w;
    }, 5000),
  );
  app.delete("/api/watchlist/:code", async (req) =>
    service.store.lock(async () => {
      const c = code.parse((req.params as any).code),
        w = await service.store.read("settings/watchlist.json");
      await service.store.write("assistant/watch-state.json", {
        codes: [...w.codes],
        revision: Date.now().toString(),
      });
      w.codes = w.codes.filter((s: string) => s !== c);
      await service.store.write("settings/watchlist.json", w);
      await collectNotices(service);
      return w;
    }, 5000),
  );
  app.get("/api/stocks/:code/history", async (req) =>
    service.history(code.parse((req.params as any).code)),
  );
  app.get("/api/stocks/:code/features", async (req) => {
    const c = code.parse((req.params as any).code),
      bars = await service.history(c);
    return bars.length >= 21
      ? {
          sessionDate: bars.at(-1)!.sessionDate,
          featureVersion: "v1",
          ...features(bars, bars.length - 1),
        }
      : null;
  });
  app.get("/api/similar", async (req) => {
    const q = z
      .object({
        code,
        compareCode: code.optional(),
        hunterJobId: z.string().uuid().optional(),
        asOf: z
          .string()
          .date()
          .optional(),
      })
      .parse(req.query);
    let result;
    try {
      result = await searchDejavuContext(service, q.code, q.asOf, q.compareCode, q.hunterJobId);
    } catch (e) {
      const reason = e instanceof Error ? e.message : "";
      if (["比較元の日足なし", "基準日時点の連続20営業日日足が不足", "20営業日のOHLCVが必要です", "欠損・不正・異なる調整系列のOHLCV窓"].includes(reason)) {
        return { ready: false, reason, message: "類似相場の検索に必要な日足が揃っていません。ホームで対象銘柄を監視に追加し、「日足を取得」を押してください。取得済みの場合は、連続20営業日分のOHLCVがある基準日を選んでください。", examples: [] };
      }
      throw e;
    }
    let notificationWarning: string | undefined;
    try { await notifyDejavu(service, result); }
    catch { notificationWarning = "検索は完了しましたが、通知の更新はできませんでした。"; }
    return { ...result, ready: true, notificationWarning };
  });
  app.post("/api/dejavu/save", async (req) => {
    const q = z
      .object({
        code,
        compareCode: code.optional(),
        hunterJobId: z.string().uuid().optional(),
        asOf: z
          .string()
          .date()
          .optional(),
      })
      .parse(req.body);
    return saveDejavu(
      service,
      await searchDejavuContext(service, q.code, q.asOf, q.compareCode, q.hunterJobId),
    );
  });
  app.get("/api/dejavu/memories", async (req) => {
    const q = z
      .object({
        code,
        asOf: z
          .string()
          .date()
          .optional(),
      })
      .parse(req.query);
    return recallDejavu(
      service,
      q.code,
      q.asOf ||
        new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
    );
  });
  app.get("/api/predictions", async () => service.predictions());
  app.post("/api/predictions/:id/anchor", async (req) =>
    service.store.lock(() =>
      prepareAnchor(service.store, id.parse((req.params as any).id)),
    ),
  );
  app.post("/api/predictions/:id/receipt", async (req) =>
    service.store.lock(async () => {
      const body = z
        .object({
          receiptId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
          txDigest: z.string().min(20).max(100),
        })
        .parse(req.body);
      return verifyAnchor(
        service.store,
        id.parse((req.params as any).id),
        body.receiptId,
        body.txDigest,
      );
    }),
  );
  app.get("/api/wallet-config", async () => ({
    network: process.env.SUI_NETWORK || "mainnet",
    endpoint: process.env.SUI_ENDPOINT || "https://fullnode.mainnet.sui.io:443",
    commitments: process.env.ENABLE_SUI_COMMITMENTS === "true",
  }));
  app.get("/api/evaluations/summary", async () =>
    aggregate(await service.predictions()),
  );
  app.get("/api/backtest", async (req) => {
    const q = z
      .object({
        code,
        horizon: z.coerce
          .number()
          .refine((n) => [1, 5, 20].includes(n))
          .default(5),
      })
      .parse(req.query);
    return walkForward(
      await service.history(q.code),
      q.horizon as 1 | 5 | 20,
      500,
    );
  });
  app.post("/api/connections/memwal", async () =>
    service.store.lock(async () => {
      memwalVerified = false;
      const provider = await service.memoryProvider();
      if (!provider) throw Error("MemWal未設定（デモではローカル記憶）");
      await provider.recall({ query: "MemWal接続確認", namespace: "kabutowal:v1:profile", limit: 1 });
      memwalVerified = true;
      return {
        ok: true,
        check: await service.store.read("settings/memwal-check.json"),
      };
    }),
  );
  app.post("/api/predictions", async (req) =>
    service.store.lock(async () => {
      const b = z
        .object({
          code,
          horizon: z.union([z.literal(1), z.literal(5), z.literal(20)]),
          asOf: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .parse(req.body);
      return service.forecast(b.code, b.horizon, b.asOf);
    }),
  );
  app.post("/api/evaluations", async () => service.store.lock(async () => {
    const count = await service.evaluateDue();
    let syncError: string | undefined;
    if (service.mode !== "demo" && process.env.ALLOW_MARKET_DATA_TO_MEMWAL === "true") {
      try { syncError = syncWarning(await syncMemories(service.store, await service.memoryProvider(), true)); }
      catch { syncError = "評価は保存済み。MemWalは未接続のため次回ジョブで再同期します。"; }
    }
    return { count, syncError };
  }));
  app.get("/api/memories", async () => service.memories());
  app.post("/api/memories/:id/sync-retry", async (req) => service.store.lock(async () => {
    const memoryId = z.union([id, z.string().regex(/^[a-f0-9]{64}$/)]).parse((req.params as any).id);
    const key = `sync/${memoryId}.json`, memory = await service.store.read(`memories/${memoryId}.json`), state = await service.store.read(key);
    if (!memory.active || memory.remoteDeletedAt || state.blobId || state.searchResetAt || state.remoteDeletion || state.directWalrusDeletion || state.status !== "failed" || !state.terminal || !state.jobId) throw Error("確定失敗した保存ジョブだけを再試行できます。");
    if (memory.kind !== "user_memory" && process.env.ALLOW_MARKET_DATA_TO_MEMWAL !== "true") throw Error("外部送信が許可されていません。");
    const provider = await service.memoryProvider();
    if (!provider?.getRememberStatus) throw Error("MemWalの接続を確認できません。");
    await verifyMemoryBinding(service.store, key, state, memory, provider);
    const job = await provider.getRememberStatus(state.jobId);
    if (job.job_id !== state.jobId || job.status !== "failed") throw Error("保存ジョブの確定失敗を確認できません。再送を停止しました。");
    await service.store.write(key, { ...state, status: "pending", previousJobId: state.jobId, jobId: undefined, idempotencyKey: undefined, pendingText: undefined, terminal: undefined, error: undefined, errorCode: undefined });
    return { status: "pending", note: "次回の同期で保存を再試行します。" };
  }));
  app.post("/api/memories", async (req) =>
    service.store.lock(async () => {
      const b = z.object({ text: z.string().min(1).max(3000) }).parse(req.body);
      return service.addMemory(b.text);
    }),
  );
  app.patch("/api/memories/:id", async (req) =>
    service.store.lock(async () => {
      const memoryId = z.union([id, z.string().regex(/^[a-f0-9]{64}$/)]).parse((req.params as any).id),
        b = z
          .object({
            text: z.string().min(1).max(3000).optional(),
            active: z.boolean().optional(),
          })
          .parse(req.body);
      const key = `memories/${memoryId}.json`,
        old = await service.store.read(key);
      if (b.text === old.text) return { ok: true, note: "変更なし" };
      let replacement;
      if (b.text)
        replacement = await service.addMemory(
          b.text,
          old.kind,
          old.providerCode,
        );
      await service.store.write(key, {
        ...old,
        active: b.text ? false : (b.active ?? old.active),
        supersededBy: replacement?.recordId,
      });
      await service.store.write(
        `audit/${randomBytes(8).toString("hex")}.json`,
        { ...meta("memory_correction"), old, replacement },
      );
      return {
        ok: true,
        remoteNote: "アプリから除外。遠隔保存の削除は行いません",
      };
    }),
  );
  app.post("/api/chat", async (req) =>
    service.store.lock(async () => {
      const b = z
        .object({
          question: z.string().min(1).max(3000),
          code: code.optional(),
        })
        .parse(req.body);
      return service.chat(b.question, b.code);
    }),
  );
  app.post("/api/jobs/fetch", async () =>
    service.store.lock(() => service.job({ syncMemory: false })),
  );
  app.patch("/api/settings", async (req) =>
    service.store.lock(async () => {
      const b = z
        .object({ fetchTime: z.string().regex(/^\d{2}:\d{2}$/) })
        .parse(req.body);
      const settings = await service.store.read("settings/settings.json");
      await service.store.write("settings/settings.json", {
        ...settings,
        ...b,
      });
      return { ok: true, note: "cron時刻も運用側で変更してください" };
    }),
  );
  app.post("/api/backup/export", async (req) =>
    service.store.lock(async () => {
      const b = z.object({ password: z.string().min(12) }).parse(req.body);
      const payload = await service.store.export(b.password);
      await service.store.write(`backups/${Date.now()}.enc`, { payload });
      return { payload };
    }),
  );
  app.post("/api/backup/import", async (req) =>
    service.store.lock(async () => {
      const b = z
        .object({ password: z.string().min(12), payload: z.string().min(60) })
        .parse(req.body);
      await service.store.import(b.payload, b.password);
      return { ok: true };
    }),
  );
  const web = path.resolve("dist/web");
  if (existsSync(web)) {
    await app.register(staticFiles, { root: web });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api")
        ? reply.code(404).send({ error: "APIなし" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
