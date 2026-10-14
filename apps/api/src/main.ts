import "dotenv/config";
import { createApp } from "./server";
const app = await createApp();
await app.listen({
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3001),
});
console.log("KABUTO WAL API: http://localhost:" + (process.env.PORT || 3001));
