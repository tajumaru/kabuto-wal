import "dotenv/config";
import { createServer } from "vite";
import { createApp } from "./server";
import { createServer as createTcpServer } from "node:net";
import { z } from "zod";

async function availablePort(start: number, host: string) {
  for (let port = start; port <= Math.min(start + 10, 65535); port++) {
    const free = await new Promise<boolean>((resolve, reject) => {
      const probe = createTcpServer();
      probe.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "EADDRINUSE" ? resolve(false) : reject(error),
      );
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw Error(
    `${start}番からのポートが使用中です。PORT / WEB_PORTで空きポートを指定してください。`,
  );
}

const app = await createApp();
const host = process.env.HOST || "127.0.0.1";
const preferred = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT || 3001);
const port = await availablePort(preferred, host);
const webPort = await availablePort(
  z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.WEB_PORT || 5173),
  "127.0.0.1",
);
if (port !== preferred)
  console.log(`${preferred}番は使用中のため、APIを${port}番で起動します。`);
await app.listen({ host, port });
console.log(`KABUTO WAL API: http://${host}:${port}`);

try {
  const web = await createServer({
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
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
