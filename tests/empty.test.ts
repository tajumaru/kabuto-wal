import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { createApp } from "../apps/api/src/server";
it("空の初期化と再起動で銘柄・株価・予測・記憶を自動補充しない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stock-empty-"));
  try {
    const service = new Service(root, "demo", false);
    await service.init();
    expect(await service.watch()).toEqual([]);
    expect(await service.predictions()).toEqual([]);
    expect(await service.memories()).toEqual([]);
    expect(await service.store.files("prices")).toEqual([]);
    const restart = new Service(root, "demo", true);
    await restart.init();
    expect(restart.seedDemo).toBe(false);
    expect(await restart.watch()).toEqual([]);
    expect(await restart.memories()).toEqual([]);
    const memory = await restart.addMemory("自分の方針");
    await new Service(root, "demo", true).init();
    expect((await restart.memories()).map((m) => m.recordId)).toEqual([
      memory.recordId,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("空でも銘柄追加後は選んだ銘柄だけにデモ日足を用意する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stock-empty-add-"));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const service = new Service(root, "demo", false);
    app = await createApp(service);
    const result = await app.inject({
      method: "POST",
      url: "/api/watchlist",
      payload: { code: "130A0" },
    });
    expect(result.statusCode).toBe(200);
    expect((await service.watch()).map((s) => s.providerCode)).toEqual([
      "130A0",
    ]);
    expect((await service.history("130A0")).length).toBeGreaterThan(20);
    expect(await service.history("72030")).toEqual([]);
    expect(await service.memories()).toEqual([]);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
