import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export interface DashboardFile {
  body: Buffer;
  type: string;
}

/** The built dashboard is missing: Laisso refuses to start rather than serve a blank page. A checkout has yet to
 * build it; an installed package ships it, so there it means the install is broken. */
export class DashboardMissing extends Error {
  constructor(dir: string, checkout: boolean) {
    const page = path.join(dir, "index.html");
    super(
      checkout
        ? `the dashboard is not built (no ${page}); run pnpm build, or pnpm start, which builds first`
        : `the dashboard is missing (no ${page}); the install is broken; reinstall with npm i -g laisso`,
    );
  }
}

/** The built dashboard, read once at startup: its page at "/" and every other file by its path under the bundle. */
export class Dashboard {
  private files = new Map<string, DashboardFile>();

  /** `dir` is the package root's dashboardDir; `checkout` picks the advice when it is missing. */
  constructor(dir: string, checkout = true) {
    if (!existsSync(path.join(dir, "index.html"))) throw new DashboardMissing(dir, checkout);
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
