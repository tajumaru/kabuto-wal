import { defineConfig } from "@playwright/test";
const origin=`http://localhost:${process.env.E2E_PORT??5517}`;
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120000,
  // Browser scenarios mutate the same JSON fixture server; isolate those mutations.
  workers: 1,
  use: {
    baseURL: origin,
    headless: true,
    screenshot: "only-on-failure",
    // Browser SDK metadata must not reach external services during fixture tests.
    proxy: { server: "http://127.0.0.1:9", bypass: "localhost,127.0.0.1" },
  },
  webServer: {
    command: "pnpm exec tsx tests/e2e/server.ts",
    url: `${origin}/api/status`,
    reuseExistingServer: false,
    timeout: 180000,
  },
});
