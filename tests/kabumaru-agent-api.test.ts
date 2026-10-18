import Fastify from "fastify";
import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { registerKabumaruAgent } from "../apps/api/src/kabumaru-agent-api";
it("agent POSTはOrigin・JSON・明示承認を要求し、同じ提案キーを再利用する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-api-")),
    s = new Service(root, "demo", false),
    app = Fastify(),
    origin = "http://localhost:5173",
    headers = { origin, "content-type": "application/json" };
  registerKabumaruAgent(app, s, [origin]);
  try {
    const payload = { objective: "API整合性", requestId: crypto.randomUUID() };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/research/agent/sessions",
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/research/agent/sessions",
          headers: { ...headers, origin: "https://invalid.example" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const r = await app.inject({
      method: "POST",
      url: "/api/research/agent/sessions",
      headers,
      payload,
    });
    expect(r.statusCode).toBe(200);
    const id = r.json().sessionId,
      proposal = {
        requestId: crypto.randomUUID(),
        proposal: {
          budget: {
            maxExperiments: 0,
            maxCohorts: 0,
            maxRuntimeSeconds: 30,
            maxJQuantsRequests: 0,
            maxExternalWrites: 0,
            maxSuiTransactions: 0,
          },
        },
      };
    const first = await app.inject({
        method: "POST",
        url: `/api/research/agent/sessions/${id}/propose`,
        headers,
        payload: proposal,
      }),
      second = await app.inject({
        method: "POST",
        url: `/api/research/agent/sessions/${id}/propose`,
        headers,
        payload: proposal,
      });
    expect(first.statusCode, first.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    const started = await app.inject({
      method: "POST",
      url: `/api/research/agent/sessions/${id}/start`,
      headers,
      payload: { planId: first.json().planId, approvalId: "a".repeat(64) },
    });
    expect(started.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      (await app.inject({ url: `/api/research/agent/sessions/${id}` })).json()
        .checkpoint,
    ).toBeNull();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
