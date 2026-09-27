import { readFileSync } from "node:fs";
import path from "node:path";

let cached: string | null = null;

/** The dashboard is one HTML page that talks to /api; it is read once per process. */
export function dashboardHtml(): string {
  if (cached === null) cached = readFileSync(path.join(import.meta.dirname, "index.html"), "utf8");
  return cached;
}
