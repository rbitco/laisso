import { build } from "vite";

/** Builds the dashboard once per test run: every spawned Lasso serves it, and refuses to start without it. */
export default async function setup(): Promise<void> {
  // Vitest sets NODE_ENV=test, which would bundle React's development build; Lasso serves the production one.
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({ configFile: new URL("../vite.config.ts", import.meta.url).pathname, logLevel: "warn" });
  } finally {
    process.env.NODE_ENV = env;
  }
}
