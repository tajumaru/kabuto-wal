import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  root: "apps/web",
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3001" } },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
