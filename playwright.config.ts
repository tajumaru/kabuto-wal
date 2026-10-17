import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120000,
  // Browser scenarios mutate the same JSON fixture server; isolate those mutations.
  workers: 1,
  use: {
    baseURL: "http://localhost:5517",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec tsx tests/e2e/server.ts",
    url: "http://localhost:5517/api/status",
    reuseExistingServer: false,
    timeout: 180000,
  },
});
