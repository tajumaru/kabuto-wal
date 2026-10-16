import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Service } from "../apps/api/src/service";
import { createApp } from "../apps/api/src/server";
import { memwalBinding } from "../packages/integrations/memwal-config";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("再試行は本人認証・外部送信許可・確定失敗の再照合を要求する", async () => {
  const signer = Ed25519Keypair.generate();
  vi.stubEnv("OWNER_ADDRESS", signer.toSuiAddress());
  vi.stubEnv("SESSION_SECRET", "test-session-secret".repeat(3));
  vi.stubEnv("ALLOW_MARKET_DATA_TO_MEMWAL", "false");
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-retry-")), service = new Service(root, "live");
  const app = await createApp(service);
  try {
    const memory = await service.addMemory("retry me");
    const key = `sync/${memory.recordId}.json`, url = `/api/memories/${memory.recordId}/sync-retry`;
    const state = { status: "failed", terminal: true, jobId: "failed-job", idempotencyKey: "old-key", environmentBinding: memwalBinding() };
    await service.store.write(key, state);
    const provider = { environmentBinding: memwalBinding(), getRememberStatus: vi.fn().mockResolvedValue({ job_id: "failed-job", status: "failed" }), remember: vi.fn(), waitForRememberJob: vi.fn(), recall: vi.fn() };
    vi.spyOn(service, "memoryProvider").mockResolvedValue(provider);
    expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);
    const challenge = (await app.inject({ method: "GET", url: "/api/auth/challenge" })).json();
    const signed = await signer.signPersonalMessage(new TextEncoder().encode(challenge.message));
    const verified = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { nonce: challenge.nonce, signature: signed.signature } });
    const cookie = verified.cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const retry = () => app.inject({ method: "POST", url, headers: { cookie }, payload: {} });
    provider.getRememberStatus.mockResolvedValueOnce({ job_id: "failed-job", status: "running" });
    expect((await retry()).statusCode).toBe(400);
    expect(await service.store.read(key)).toEqual(state);
    await service.store.write(`memories/${memory.recordId}.json`, { ...memory, kind: "market_analysis" });
    expect((await retry()).statusCode).toBe(400);
    await service.store.write(`memories/${memory.recordId}.json`, memory);
    await service.store.write(key, { ...state, blobId: "uploaded-before-failure" });
    expect((await retry()).statusCode).toBe(400);
    await service.store.write(key, state);
    expect((await retry()).json().status).toBe("pending");
    expect(await service.store.read(key)).toMatchObject({ status: "pending", previousJobId: "failed-job" });
    expect((await service.store.read(key)).jobId).toBeUndefined();
    expect((await service.store.read(key)).idempotencyKey).toBeUndefined();
    expect(provider.remember).not.toHaveBeenCalled();
    expect((await retry()).statusCode).toBe(400);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
