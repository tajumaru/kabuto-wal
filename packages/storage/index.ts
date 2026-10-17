import { promises as fs } from "node:fs";
import path from "node:path";
import {
  randomUUID,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
// Share the limit across stores and concurrent API requests.
let activeReads = 0;
const waitingReads: (() => void)[] = [];
async function readFileLimited(file: string) {
  if (activeReads >= 32) await new Promise<void>((resolve) => waitingReads.push(resolve));
  else activeReads++;
  try { return await fs.readFile(file, "utf8"); }
  finally {
    const next = waitingReads.shift();
    if (next) next();
    else activeReads--;
  }
}
export class Store {
  constructor(public root: string) {}
  path(key: string) {
    if (
      !key
        .split("/")
        .every((p) => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(p))
    )
      throw Error("不正な保存パス");
    if (
      key.includes("\\") ||
      key.split("/").some((p) => p === ".." || p.startsWith(".")) ||
      path.isAbsolute(key)
    )
      throw Error("不正な保存パス");
    return path.join(this.root, key);
  }
  async read<T = any>(key: string, fallback?: any): Promise<T> {
    try {
      return JSON.parse(await readFileLimited(this.path(key)));
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code === "ENOENT" &&
        fallback !== undefined
      )
        return fallback;
      throw e;
    }
  }
  async write(key: string, data: unknown, immutable = false) {
    const tracked=/^(predictions|evaluations|memories|sync|prices|revisions|market|research\/(?:results|chats|notebooks))\//.test(key);
    const token=randomUUID(),dirty=path.join(this.root,".store-mutations",token);
    if(tracked){await fs.mkdir(path.dirname(dirty),{recursive:true});await fs.writeFile(dirty,String(process.pid),{flag:"wx"});}
    try {
    const dest = this.path(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (immutable) {
      try {
        await fs.access(dest);
        throw Error("不変レコードは上書きできません");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    const temp = dest + ".tmp-" + randomUUID();
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Windows readers/virus scanners may briefly hold the destination open.
    // Retry the same atomic replacement; never unlink the existing record.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, dest); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 5 ||
          !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    if (process.platform !== "win32") {
      const dir = await fs.open(path.dirname(dest), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    } finally {
      if(tracked){await fs.writeFile(path.join(this.root,".store-generation"),token);await fs.rm(dirty,{force:true});}
    }
  }
  // App writes publish a generation before releasing their mutation marker. A
  // reader never trusts a generation while any source write is in progress.
  // A missing/dirty marker uses the legacy full-scan path, including old stores.
  async generation():Promise<string|null>{
    try {
      const before=await fs.readFile(path.join(this.root,".store-generation"),"utf8");
      const dirty=await fs.readdir(path.join(this.root,".store-mutations"));
      const after=await fs.readFile(path.join(this.root,".store-generation"),"utf8");
      return !dirty.length&&before===after&&/^[a-f0-9-]{36}$/.test(after)?after:null;
    }catch{return null;}
  }
  async files(prefix: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string, rel: string) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const key = rel + "/" + e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), key);
        else if (e.name.endsWith(".json")) out.push(key);
      }
    }
    try {
      await walk(this.path(prefix), prefix);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return out;
  }
  async all<T = any>(prefix: string): Promise<T[]> {
    const files = await this.files(prefix);
    const records: T[] = [];
    for (let i = 0; i < files.length; i += 32) {
      records.push(...await Promise.all(files.slice(i, i + 32).map((k) => this.read<T>(k))));
    }
    return records;
  }
  async lock<T>(fn: () => Promise<T>, waitMs = 120_000): Promise<T> {
    await fs.mkdir(this.root, { recursive: true });
    const lock = path.join(this.root, ".writer-lock");
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        await fs.mkdir(lock);
        await fs.writeFile(
          path.join(lock, "owner.json"),
          JSON.stringify({ pid: process.pid }),
        );
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          const owner = JSON.parse(
            await fs.readFile(path.join(lock, "owner.json"), "utf8"),
          );
          try {
            process.kill(owner.pid, 0);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ESRCH") {
              await fs.rm(lock, { recursive: true, force: true });
              continue;
            }
          }
        } catch {
          /* acquiring owner file */
        }
        if (Date.now() >= deadline)
          throw Error("別の処理（日足取得など）が実行中です。完了後にもう一度お試しください。");
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
  async rebuild() {
    await this.write(
      "indexes/predictions.json",
      (await this.files("predictions")).filter((k) =>
        k.endsWith("/original.json"),
      ),
    );
    await this.write("indexes/memories.json", await this.files("memories"));
  }
  async export(password: string) {
    if (password.length < 12)
      throw Error("バックアップのパスフレーズは12文字以上");
    const entries: Record<string, unknown> = {};
    for (const folder of [
      "settings",
      "market",
      "prices",
      "revisions",
      "features",
      "predictions",
      "evaluations",
      "chats",
      "memories",
      "indexes",
      "sync",
      "jobs",
      "commitments",
      "audit",
      "notifications",
      "assistant",
      "research",
    ])
      for (const key of await this.files(folder))
        entries[key] = await this.read(key);
    const salt = randomBytes(16),
      iv = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        scryptSync(password, salt, 32),
        iv,
      );
    const body = Buffer.concat([
      cipher.update(JSON.stringify(entries)),
      cipher.final(),
    ]);
    return Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString(
      "base64",
    );
  }
  async import(payload: string, password: string) {
    const b = Buffer.from(payload, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      scryptSync(password, b.subarray(0, 16), 32),
      b.subarray(16, 28),
    );
    cipher.setAuthTag(b.subarray(28, 44));
    const entries = JSON.parse(
      Buffer.concat([cipher.update(b.subarray(44)), cipher.final()]).toString(),
    );
    for (const key of Object.keys(entries)) {
      this.path(key);
      if (
        !/^(settings|market|prices|revisions|features|predictions|evaluations|chats|memories|indexes|sync|jobs|commitments|audit|notifications|assistant|research)\//.test(
          key,
        )
      )
        throw Error("バックアップ内に許可されないファイル");
    }
    for (const [key, value] of Object.entries(entries)) {
      if (key.endsWith("/original.json") || key.startsWith("research/results/") || /^market\/hunter\/cohorts\/[a-f0-9]{64}\//.test(key)) {
        const old = await this.read(key, null);
        if (old && JSON.stringify(old) !== JSON.stringify(value))
          throw Error("元予測と復元内容が競合しています");
      }
    }
    const current = await this.read("settings/settings.json", null);
    if (
      current &&
      entries["settings/settings.json"] &&
      (entries["settings/settings.json"] as any).mode !== current.mode
    )
      throw Error("デモと実データを同じDATA_DIRへ復元できません");
    for (const [key, value] of Object.entries(entries))
      await this.write(key, value);
    await this.rebuild();
  }
}
