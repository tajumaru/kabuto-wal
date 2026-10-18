import { defineConfig } from "vitest/config";
export default defineConfig({
  envDir: false,
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
