import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // Laisso refuses to start without the built dashboard, so every run builds it first.
    globalSetup: ["test/build-dashboard.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
