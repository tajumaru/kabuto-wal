import { beforeAll, afterAll, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Service } from "../apps/api/src/service";
import { createApp } from "../apps/api/src/server";
let root: string;
const owner = Ed25519Keypair.generate();
let app: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "stock-auth-"));
  process.env.OWNER_ADDRESS = owner.toSuiAddress();
  process.env.SESSION_SECRET = "a".repeat(40);
  app = await createApp(new Service(root, "live"));
});
afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
  delete process.env.OWNER_ADDRESS;
  delete process.env.SESSION_SECRET;
});
it("実データAPIとexportを未認証では拒否", async () => {
  expect((await app.inject("/api/assistant")).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/assistant/save-chat",
        payload: { eventId: "test" },
      })
    ).statusCode,
  ).toBe(401);
  expect((await app.inject("/api/watchlist")).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/backup/export",
        payload: { password: "long-password" },
      })
    ).statusCode,
  ).toBe(401);
});
it("誤owner、期限切れ、再利用nonceを拒否し本人セッションを発行", async () => {
  let challenge = (await app.inject("/api/auth/challenge")).json();
  let signed = await Ed25519Keypair.generate().signPersonalMessage(
    Buffer.from(challenge.message),
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { nonce: challenge.nonce, signature: signed.signature },
      })
    ).statusCode,
  ).toBe(403);
  signed = await owner.signPersonalMessage(Buffer.from(challenge.message));
  const result = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    payload: { nonce: challenge.nonce, signature: signed.signature },
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers["set-cookie"]).toContain("HttpOnly");
  expect(
    (
      await app.inject({
        url: "/api/watchlist",
        headers: { cookie: String(result.headers["set-cookie"]).split(";")[0] },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { nonce: challenge.nonce, signature: signed.signature },
      })
    ).statusCode,
  ).toBe(401);
  challenge = (await app.inject("/api/auth/challenge")).json();
  const files = await new Service(root, "live").store.files("nonces");
  const key = files.find((k) => !k.endsWith("missing"))!;
  const store = new Service(root, "live").store;
  for (const file of files) {
    const n = await store.read(file);
    await store.write(file, { ...n, expires: 0 });
  }
  expect(key).toBeTruthy();
  signed = await owner.signPersonalMessage(Buffer.from(challenge.message));
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { nonce: challenge.nonce, signature: signed.signature },
      })
    ).statusCode,
  ).toBe(401);
});
