import { resolveHome } from "../server/home.ts";
import { ConfigError, loadConfig } from "../server/config.ts";
import { doctor as checkTools, findOnPath, homePipelines, neededTools, runCommand, storeTickets, type DoctorRow } from "../tools/tools.ts";

export interface DoctorOptions {
  json: boolean;
}

/**
 * `lasso doctor`: which external tools this Lasso home's config needs, whether
 * each is on PATH and logged in, and what needs it. Reads the Lasso home
 * directly, so it works with or without Lasso running, and writes nothing.
 * Exits 1 when a needed tool is missing or logged out.
 */
export async function doctor(opts: DoctorOptions): Promise<number> {
  const home = resolveHome();
  let config;
  try {
    config = loadConfig(home);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const tools = neededTools({ config, pipelines: homePipelines(home), tickets: storeTickets(home) });
  const rows = await checkTools(tools, { lookup: findOnPath(), run: runCommand });
  const problems = rows.filter((r) => !r.optional && (r.path === null || r.loggedIn === false));
  if (opts.json) console.log(JSON.stringify({ home: home.root, tools: rows }, null, 2));
  else console.log(renderDoctor(home.root, rows, problems));
  return problems.length ? 1 : 0;
}

/** One row per tool: found on PATH, logged in, and what needs it; then a line saying what to fix. */
export function renderDoctor(home: string, rows: DoctorRow[], problems: DoctorRow[]): string {
  const table = [
    ["tool", "found", "logged in", "needed by"],
    ...rows.map((r) => [r.name, r.path === null ? "no" : "yes", r.loggedIn === null ? "-" : r.loggedIn ? "yes" : "no", (r.optional ? "optional: " : "") + r.reasons.join("; ")]),
  ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  const lines = table.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
  const verdict = problems.length
    ? problems.map((r) => (r.path === null ? `${r.name} not found on PATH` : `${r.name} is not logged in`)).join("; ")
    : "every needed tool is found and logged in";
  return [`lasso home: ${home}`, "", ...lines, "", verdict].join("\n");
}
