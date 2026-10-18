import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { scoutFixture } from "../fixtures/bottom-scout";
import { scoutChat } from "../apps/api/src/bottom-scout-chat";
import { saveScoutMemory, scoutLocalReferences, syncScoutMemory } from "../apps/api/src/bottom-scout-memory";

it("記憶保存を重複させず、削除後は再作成・外部送信・参照を行わない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scout-memory-"));
  const s = new Service(root, "demo", false);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("forbidden"));
  try {
    const f = await scoutFixture(s, 2);
    const event = await scoutChat(s, "底打ち候補を5つ教えて", "10000", f.now);
    expect(event.scout.intent).toBe("ranking");
    expect(event.scout.rows).toHaveLength(2);
    const id = event.scout.reportId!;
    const first = await saveScoutMemory(s, id, f.now);
    const before = await s.store.read(`memories/${first.recordId}.json`);
    expect(before.externalConsent).toBe(false);
    expect((await saveScoutMemory(s, id, f.now)).status).toBe("existing");
    expect(await s.store.read(`memories/${first.recordId}.json`)).toEqual(before);
    expect(await scoutLocalReferences(s, id)).toHaveLength(1);
    await s.store.write(`sync/${first.recordId}.json`, { status: "deleted" });
    expect((await saveScoutMemory(s, id, f.now)).status).toBe("suppressed");
    expect(await scoutLocalReferences(s, id)).toHaveLength(0);
    await expect(syncScoutMemory(s, id, false)).rejects.toThrow();
    expect((await scoutChat(s, "底打ち候補を探して", undefined, f.now)).scout.rows).toHaveLength(2);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
