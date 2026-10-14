import "dotenv/config";
import { createServer } from "vite";
import { createApp } from "./server";

const app = await createApp();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3001);
await app.listen({ host, port });
console.log(`KABUTO WAL API: http://${host}:${port}`);

try {
  const web = await createServer({
    server: {
      host: "127.0.0.1",
      proxy: { "/api": `http://127.0.0.1:${port}` },
    },
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await web.close();
    await app.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await web.listen();
  web.printUrls();
} catch (error) {
  await app.close();
  throw error;
}
