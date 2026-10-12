import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where `pnpm build` writes the dashboard (ADR 0012); not committed. */
export const DASHBOARD_DIR = path.resolve(import.meta.dirname, "../../dist/dashboard");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

export interface DashboardFile {
  body: Buffer;
  type: string;
}

/** The built dashboard is missing: Lasso refuses to start rather than serve a blank page. */
export class DashboardMissing extends Error {
  constructor(dir: string) {
    super(`the dashboard is not built (no ${path.join(dir, "index.html")}); run pnpm build, or pnpm start, which builds first`);
  }
}

/** The built dashboard, read once at startup: its page at "/" and every other file by its path under the bundle. */
export class Dashboard {
  private files = new Map<string, DashboardFile>();

  constructor(dir: string = DASHBOARD_DIR) {
    if (!existsSync(path.join(dir, "index.html"))) throw new DashboardMissing(dir);
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      const route = "/" + path.relative(dir, file).split(path.sep).join("/");
      this.files.set(route, { body: readFileSync(file), type: TYPES[path.extname(file)] ?? "application/octet-stream" });
    }
  }

  /** The file served at a route; "/" is the page. */
  file(route: string): DashboardFile | null {
    return this.files.get(route === "/" ? "/index.html" : route) ?? null;
  }
}
