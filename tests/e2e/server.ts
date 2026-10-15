import { createServer } from "vite";
import { createApp } from "../../apps/api/src/server";
import { Service } from "../../apps/api/src/service";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { demoBars, master } from "../../fixtures/demo";
process.env.APP_ORIGIN = "http://localhost:5517";
// A fresh seeded store prevents prior empty/personal settings changing test results.
const dir = await mkdtemp(path.join(os.tmpdir(), "kabutowal-e2e-"));
const service = new Service(dir, "demo", false);
const app = await createApp(service);
// Browser tests exercise real APIs with deterministic fixture files; they do not
// need thousands of separately fsynced acquisition revisions at every startup.
for (const stock of master)
  await service.store.write(
    `prices/${stock.providerCode}/fixture.json`,
    demoBars(stock.providerCode),
  );
await service.store.write("settings/watchlist.json", {
  codes: master.slice(0, 3).map((s) => s.providerCode),
});
await app.listen({ host: "127.0.0.1", port: 3002 });
const web = await createServer({
  server: {
    host: "127.0.0.1",
    port: 5517,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3002" },
  },
});
await web.listen();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await web.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
