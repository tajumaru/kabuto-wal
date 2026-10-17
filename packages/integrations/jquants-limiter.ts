import { createHash } from "node:crypto";
import path from "node:path";
import { Store } from "../storage/index";
import { planCapabilities } from "./jquants-plan";

export interface RequestGate {
  wait(): Promise<void>;
  deferUntil(time: number): Promise<void>;
}
export class RequestDeferred extends Error {
  constructor(public retryAt: string) {
    super(`API待機中。再開可能時刻 ${retryAt}`);
  }
}
export class JQuantsLimiter implements RequestGate {
  private budget: Store;
  private interval: number;
  constructor(
    key: string,
    root: string,
    plan: string,
    rpm?: number,
    private clock = () => Date.now(),
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {
    const id = createHash("sha256").update(key).digest("hex");
    this.budget = new Store(path.join(root, "market", "request-budgets", id));
    this.interval = Math.ceil(
      60000 / planCapabilities(plan, rpm).requestsPerMinute,
    );
  }
  async wait() {
    // Reserve only a slot that is due now. Another process can publish Retry-After
    // while we sleep; every wake rechecks the shared budget under a short lock.
    for (;;) {
      const wait = await this.budget.lock(async () => {
        const state = await this.budget.read("state.json", {
          nextAllowedAt: 0,
        });
        const delay = Math.max(0, state.nextAllowedAt - this.clock());
        if (!delay)
          await this.budget.write("state.json", {
            nextAllowedAt: this.clock() + this.interval,
          });
        return delay;
      });
      if (!wait) return;
      if (wait > 300000)
        throw new RequestDeferred(new Date(this.clock() + wait).toISOString());
      await this.sleep(wait);
    }
  }
  async deferUntil(time: number) {
    await this.budget.lock(async () => {
      const old = await this.budget.read("state.json", { nextAllowedAt: 0 });
      await this.budget.write("state.json", {
        nextAllowedAt: Math.max(old.nextAllowedAt, time),
      });
    });
  }
}
export function retryAfter(value: string | null, now: number) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return now + Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : null;
}
export async function jquantsRequest(
  url: string,
  key: string,
  fetcher: typeof fetch,
  gate: RequestGate,
) {
  const started = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    await gate.wait();
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      if (attempt === 3) throw Error("J-Quants通信を確認できません");
      await gate.deferUntil(Date.now() + 1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status < 500)
      throw Error(`J-Quants HTTP ${response.status}`);
    const until = Math.max(
      retryAfter(response.headers.get("retry-after"), Date.now()) ?? (response.status === 429 ? Date.now() + 60000 : 0),
      Date.now() + 1000 * 2 ** attempt + Math.floor(Math.random() * 250),
    );
    await gate.deferUntil(until);
    if (until - started > 300000)
      throw new RequestDeferred(new Date(until).toISOString());
    if (attempt === 3 && response.status === 429) throw new RequestDeferred(new Date(until).toISOString());
    if (attempt === 3)
      throw Error(`J-Quants HTTP ${response.status}（再試行上限）`);
  }
  throw Error("J-Quants取得失敗");
}
