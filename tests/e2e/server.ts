import { createServer } from "vite";
import { createApp } from "../../apps/api/src/server";
import { Service } from "../../apps/api/src/service";
process.env.APP_ORIGIN = "http://localhost:5517";
const app = await createApp(new Service("./data/e2e", "demo", true));
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
