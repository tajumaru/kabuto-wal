import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../apps/api/src/server";
import { Service } from "../apps/api/src/service";

it("開発画面の実ポートを許可し、別ポートや外部Originは拒否する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auth-origin-"));
  const app = await createApp(new Service(root, "demo", false), [
    "http://127.0.0.1:5174", "http://localhost:5174",
  ]);
  try {
    for (const origin of ["http://127.0.0.1:5174", "http://localhost:5174"]) {
      expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin } })).statusCode).toBe(200);
    }
    for (const origin of ["http://127.0.0.1:5173", "https://bad.invalid", "null"]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("Origin不一致");
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
