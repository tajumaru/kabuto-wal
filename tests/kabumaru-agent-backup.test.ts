import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import {
  createAgentSession,
  agentBase,
  agentEvents,
} from "../apps/api/src/kabumaru-agent-audit";
it("暗号化復元は研究の監査イベントを上書きせず、空ストアでは再読込できる", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-backup-")),
    other = await mkdtemp(path.join(os.tmpdir(), "agent-backup-copy-")),
    s = new Service(root, "demo", false),
    copy = new Service(other, "demo", false);
  try {
    const session = await createAgentSession(s, {
        objective: "不変の研究履歴",
      }),
      events = await agentEvents(s, session.sessionId),
      event = events[0],
      key = `${agentBase(session.sessionId)}/events/000000-${event.eventId}.json`,
      backup = await s.store.export("fixture-password");
    await copy.store.import(backup, "fixture-password");
    expect(await agentEvents(copy, session.sessionId)).toEqual(events);
    await s.store.write(key, { ...event, reason: "changed" });
    await expect(s.store.import(backup, "fixture-password")).rejects.toThrow(
      "競合",
    );
    expect((await s.store.read<{ reason: string }>(key)).reason).toBe(
      "changed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
