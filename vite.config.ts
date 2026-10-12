import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard (ADR 0012). `pnpm build` writes it to dist/dashboard, which Lasso serves; `pnpm dev` serves it
// from source and forwards /api to a running Lasso on LASSO_PORT (default 7433).
export default defineConfig({
  root: "src/dashboard",
  plugins: [react()],
  build: { outDir: "../../dist/dashboard", emptyOutDir: true },
  server: { proxy: { "/api": `http://localhost:${process.env.LASSO_PORT ?? "7433"}` } },
});
