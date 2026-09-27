import { readFileSync } from "node:fs";
import path from "node:path";

const cached = new Map<string, string>();

function file(name: string): string {
  let text = cached.get(name);
  if (text === undefined) { text = readFileSync(path.join(import.meta.dirname, name), "utf8"); cached.set(name, text); }
  return text;
}

/** The dashboard is one HTML page that talks to /api; it is read once per process. */
export function dashboardHtml(): string {
  return file("index.html");
}

/** The Metro module the page imports; the same file the tests run in Node. */
export function metroScript(): string {
  return file("metro.js");
}
