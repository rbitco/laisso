import { homedir } from "node:os";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devEnv } from "./scripts/dev-env.ts";

// The dashboard (ADR 0012). `pnpm build` writes it to dist/dashboard, which Laisso serves; `pnpm dev` serves it
// from source and forwards /api to the dev clone's running Laisso: `pnpm start`'s port, LAISSO_PORT or 7434.
export default defineConfig({
  root: "src/dashboard",
  plugins: [react()],
  build: { outDir: "../../dist/dashboard", emptyOutDir: true },
  server: { proxy: { "/api": `http://localhost:${devEnv(process.env, homedir()).LAISSO_PORT}` } },
});
