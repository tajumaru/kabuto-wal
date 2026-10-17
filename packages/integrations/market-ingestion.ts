import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../storage/index";
import { JQuants } from "./jquants";
import { RequestDeferred } from "./jquants-limiter";
import { dataWindow } from "./jquants-plan";
import {
  ADJUSTMENT_VERSION,
  adjustedSeries,
  hash,
  rawDailySchema,
  type RawDaily,
  type RawObservation,
} from "./adjusted-series";
import { barSchema } from "../core/index";
import type { Calendar } from "../core/index";

type PageRef = { hash: string; observedAt: string; count: number };
export type Checkpoint = {
  date: string;
  revision: string;
  status: "partial" | "completed";
  pages: PageRef[];
  seen: string[];
  next?: string;
  masterHash?: string;
  lease?: { token: string; expiresAt: number; pid?: number };
  error?: string;
};
export class MarketIngestion {
  constructor(
    private store: Store,
    private provider: Pick<JQuants, "master" | "page"> | null,
    private plan: string,
    private now = () => new Date(),
    private cancelled: () => Promise<boolean> = async () => false,
  ) {}
  async ingestDate(date: string, revision = "initial") {
    if (!this.provider) throw Error("取得用接続がありません");
    z.string().date().parse(date);
    z.string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .parse(revision);
    const today = this.now().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Tokyo",
    });
    const window = dataWindow(this.plan, today);
    if (date < window.from || date > window.to)
      throw Error("契約の取得可能期間外です");
    const calendar = await this.store.read<Calendar>(
      "market/calendar.json",
      [],
    );
    if (!calendar.some((d) => d.date === date && d.open))
      throw Error("現物株営業日のカレンダーが必要です");
    const base = `market/ingestion/${date}/${revision}`,
      key = `${base}/checkpoint.json`,
      token = randomUUID();
    let checkpoint: Checkpoint = await this.store.lock(async () => {
      const old = await this.store.read<Checkpoint>(key, {
        date,
        revision,
        status: "partial",
        pages: [],
        seen: [],
      });
      if (old.status === "completed") {
        const pointer = await this.store.read<Checkpoint>(
          `market/bottom-raw/${date}.json`,
          null,
        );
        if (
          !pointer ||
          (pointer.pages.at(-1)?.observedAt ?? "") <=
            (old.pages.at(-1)?.observedAt ?? "")
        )
          await this.store.write(`market/bottom-raw/${date}.json`, {
            base,
            ...old,
          });
        return old;
      }
      if (old.lease && old.lease.expiresAt > this.now().getTime()) {
        let alive = true;
        if (old.lease.pid) {
          try { process.kill(old.lease.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        }
        if (alive) {
          const deferred = new RequestDeferred(new Date(old.lease.expiresAt).toISOString());
          const until = new Date(old.lease.expiresAt).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit" });
          deferred.message = `同じ日付（${date}）の取得ロックが残っています。日本時間${until}以降に「中断した処理を再開」を押してください。取得済みデータは保持しています。`;
          throw deferred;
        }
      }
      const next = {
        ...old,
        lease: { token, expiresAt: this.now().getTime() + 900000, pid: process.pid },
      };
      await this.store.write(key, next);
      return next;
    });
    if (checkpoint.status === "completed") return checkpoint;
    const commit = async (next: Checkpoint) =>
      this.store.lock(async () => {
        const old = await this.store.read<Checkpoint>(key);
        if (old.lease?.token !== token)
          throw Error("取得leaseが変更されました");
        await this.store.write(key, next);
        checkpoint = next;
      });
    try {
      if (!checkpoint.masterHash) {
        const rows = await this.provider.master(date);
        if (!rows.length) throw Error("マスターが空のため取得を完了できません");
        const codes = rows.map((r) =>
          z
            .string()
            .regex(/^[A-Z0-9]{4,5}$/)
            .parse(r.Code),
        );
        if (new Set(codes).size !== codes.length)
          throw Error("マスターの銘柄が重複しています");
        const id = hash(rows);
        await this.store.lock(async () => {
          const target = `market/master-snapshots/${date}/${id}.json`;
          if (!(await this.store.read(target, null)))
            await this.store.write(
              target,
              { date, rows, observedAt: this.now().toISOString() },
              true,
            );
        });
        await commit({ ...checkpoint, masterHash: id });
      }
      const existingCodes = new Set<string>();
      for (const page of checkpoint.pages) {
        const body = await this.store.read<RawDaily[]>(
          `${base}/pages/${page.hash}.json`,
        );
        if (hash(body) !== page.hash) throw Error("取得ページが破損しています");
        for (const row of body) existingCodes.add(row.Code);
      }
      while (checkpoint.pages.length < 10000) {
        if (await this.cancelled()) throw Error("取得をキャンセルしました");
        const page = await this.provider.page(
          "equities/bars/daily",
          { date },
          checkpoint.next,
        );
        const rows = page.data.map((r) => rawDailySchema.parse(r));
        for (const row of rows) {
          if (row.Date !== date || existingCodes.has(row.Code))
            throw Error("日付不一致またはページ間銘柄重複");
          existingCodes.add(row.Code);
        }
        if (!rows.length) throw Error("日足が空のため取得を完了できません");
        if (page.next && checkpoint.seen.includes(page.next))
          throw Error("ページキーの循環");
        const id = hash(rows),
          observedAt = this.now().toISOString();
        await this.store.lock(async () => {
          const target = `${base}/pages/${id}.json`;
          if (!(await this.store.read(target, null)))
            await this.store.write(target, rows, true);
        });
        const next: Checkpoint = {
          ...checkpoint,
          error: undefined,
          pages: [
            ...checkpoint.pages,
            { hash: id, observedAt, count: rows.length },
          ],
          seen: page.next ? [...checkpoint.seen, page.next] : checkpoint.seen,
          next: page.next,
          status: page.next ? "partial" : "completed",
          lease: page.next
            ? { token, expiresAt: this.now().getTime() + 900000, pid: process.pid }
            : undefined,
        };
        if (!page.next) {
          await this.store.lock(async () => {
            const current = await this.store.read<Checkpoint>(key);
            if (current.lease?.token !== token)
              throw Error("取得leaseが変更されました");
            await this.store.write(key, next);
            await this.store.write(`market/bottom-raw/${date}.json`, {
              base,
              ...next,
            });
          });
          return next;
        }
        await commit(next);
      }
      throw Error("ページ数上限");
    } catch (error) {
      await this.store.lock(async () => {
        const current = await this.store.read<Checkpoint>(key);
        if (current.lease?.token === token)
          await this.store.write(key, {
            ...checkpoint,
            lease: undefined,
            error: error instanceof Error ? error.message : "取得失敗",
          });
      });
      throw error;
    }
  }
  async series(code: string, asOf: string, cutoff: string, from: string, indexedObservations?: RawObservation[], persist = true) {
    z.string()
      .regex(/^[A-Z0-9]{4,5}$/)
      .parse(code);
    z.string().date().parse(from);
    const calendar = await this.store.read<Calendar>(
      "market/calendar.json",
      [],
    );
    const observations: RawObservation[] = indexedObservations ?? [];
    for (const d of (indexedObservations ? [] : calendar).filter(
      (d) => d.open && d.date >= from && d.date <= asOf,
    )) {
      const dateBase = `market/ingestion/${d.date}`;
      // Include old completed runs as well, so cutoff can reconstruct revisions.
      for (const file of (await this.store.files(dateBase)).filter((p) =>
        p.endsWith("/checkpoint.json"),
      )) {
        const cp = await this.store.read<Checkpoint>(file);
        if (cp.status !== "completed") continue;
        for (const page of cp.pages) {
          if (Date.parse(page.observedAt) > Date.parse(cutoff)) continue;
          const body = await this.store.read<RawDaily[]>(
            `${file.slice(0, -16)}/pages/${page.hash}.json`,
          );
          if (hash(body) !== page.hash)
            throw Error("取得ページが破損しています");
          for (const row of body)
            if (row.Code === code)
              observations.push({
                row,
                revisionId: hash(rawDailySchema.parse(row)),
                observedAt: page.observedAt,
              });
        }
      }
    }
    const expected = calendar.filter(
      (d) => d.open && d.date >= from && d.date <= asOf,
    );
    if (
      !expected.length ||
      expected.some((d) => !observations.some((o) => o.row.Date === d.date))
    )
      throw Error("指定期間の原本不足");
    const result = adjustedSeries(observations, code, asOf, cutoff, calendar);
    if (persist) await this.store.lock(async () => {
      const target = `market/bottom-series/${code}/${asOf}/${result.seriesId}.json`;
      if (!(await this.store.read(target, null)))
        await this.store.write(
          target,
          { ...result, contentHash: hash(result) },
          true,
        );
    });
    return result;
  }
}

// Read-only adapter. Legacy paths and their series IDs are never rewritten.
export async function readDerivedSeries(
  store: Store,
  code: string,
  date: string | undefined,
  cutoff: string,
) {
  const files = await store.files(
    `market/bottom-series/${code}${date ? `/${date}` : ""}`,
  );
  const results: ReturnType<typeof adjustedSeries>[] = [];
  for (const file of files) {
    const stored = await store.read<
      ReturnType<typeof adjustedSeries> & { contentHash: string }
    >(file);
    const { contentHash, ...raw } = stored;
    if (hash(raw) !== contentHash)
      throw Error("調整系列の内容が破損しています");
    if (
      raw.adjustmentVersion !== ADJUSTMENT_VERSION ||
      !raw.inputManifest.length
    )
      throw Error("調整系列の形式が一致しません");
    if (
      raw.inputManifest.some((m) => !Number.isFinite(Date.parse(m.observedAt)))
    )
      throw Error("調整系列の取得時点が不正です");
    const asOf = raw.inputManifest.at(-1)!.date;
    if (
      (date && asOf !== date) ||
      raw.inputManifest.some(
        (m) => Date.parse(m.observedAt) > Date.parse(cutoff),
      )
    )
      continue;
    if (
      raw.seriesId !== hash([ADJUSTMENT_VERSION, code, asOf, raw.inputManifest])
    )
      throw Error("調整系列のmanifestが破損しています");
    const bars = raw.bars.map((b) => barSchema.parse(b));
    if (
      bars.length !== raw.inputManifest.length ||
      bars.some(
        (b, i) =>
          b.providerCode !== code ||
          b.seriesId !== raw.seriesId ||
          b.sessionDate !== raw.inputManifest[i].date ||
          b.availableAt !== raw.inputManifest[i].observedAt,
      )
    )
      throw Error("調整系列の参照が一致しません");
    results.push({ ...raw, bars });
  }
  return (
    results.sort(
      (a, b) =>
        b.bars.at(-1)!.sessionDate.localeCompare(a.bars.at(-1)!.sessionDate) ||
        Math.max(...b.inputManifest.map((m) => Date.parse(m.observedAt))) -
          Math.max(...a.inputManifest.map((m) => Date.parse(m.observedAt))),
    )[0] ?? null
  );
}
