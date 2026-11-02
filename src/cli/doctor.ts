import { homedir } from "node:os";
import { resolveHome } from "../server/home.ts";
import { ConfigError, loadConfig } from "../server/config.ts";
import { doctor as checkTools, findOnPath, homePipelines, neededTools, runCommand, storeTickets, type DoctorRow } from "../tools/tools.ts";
import { findPackageRoot } from "../package-root.ts";
import { skillStatus, type SkillStatus } from "../skill/skill.ts";
import { chooseTerminal, type TerminalChoice } from "../session/openers.ts";

export interface DoctorOptions {
  json: boolean;
  /** LAISSO_HOME, PATH and HOME are read from here: the process's own unless a test says otherwise. */
  env?: NodeJS.ProcessEnv;
}

/**
 * `laisso doctor`: which external tools this Laisso home's config needs, whether
 * each is on PATH and logged in, and what needs it. Reads the Laisso home
 * directly, so it works with or without Laisso running, and writes nothing.
 * Exits 1 when a needed tool is missing or logged out. It also says whether
 * each agent has the Laisso skill and from which version, as information only:
 * the skill never changes the exit code. Last, where human Stages open, as
 * Laisso started from this shell would choose.
 */
export async function doctor(opts: DoctorOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const home = resolveHome(env);
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
  const rows = await checkTools(tools, { lookup: findOnPath(env), run: runCommand });
  const problems = rows.filter((r) => !r.optional && (r.path === null || r.loggedIn === false));
  const version = findPackageRoot().version;
  const skill = skillStatus(env.HOME || homedir(), version);
  const terminal = chooseTerminal(config.terminal, env);
  if (opts.json) console.log(JSON.stringify({ home: home.root, tools: rows, skill, terminal }, null, 2));
  else console.log(renderDoctor(home.root, rows, problems, skill, version, terminal));
  return problems.length ? 1 : 0;
}

/** One row per tool: found on PATH, logged in, and what needs it; then a line saying what to fix; then the skill, per agent; then the terminal. */
export function renderDoctor(home: string, rows: DoctorRow[], problems: DoctorRow[], skill: SkillStatus[] = [], version = "", terminal: TerminalChoice | null = null): string {
  const table = [
    ["tool", "found", "logged in", "needed by"],
    ...rows.map((r) => [r.name, r.path === null ? "no" : "yes", r.loggedIn === null ? "-" : r.loggedIn ? "yes" : "no", (r.optional ? "optional: " : "") + r.reasons.join("; ")]),
  ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  const lines = table.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
  const verdict = problems.length
    ? problems.map((r) => (r.path === null ? `${r.name} not found on PATH` : `${r.name} is not logged in`)).join("; ")
    : "every needed tool is found and logged in";
  const skills = skill.length ? ["", ...skill.map((s) => skillLine(s, version))] : [];
  const opens = terminal ? ["", `human Stages open in: ${TERMINAL_NAME[terminal.kind]}, as ${terminal.why}`] : [];
  return [`laisso home: ${home}`, "", ...lines, "", verdict, ...skills, ...opens].join("\n");
}

const TERMINAL_NAME: Record<TerminalChoice["kind"], string> = { herdr: "a herdr tab", tmux: "a tmux window", "terminal-app": "a Terminal.app window" };

/** One agent's copy of the skill, with the fix when it is not this Laisso's. */
function skillLine(s: SkillStatus, version: string): string {
  const head = `laisso skill for ${s.agent} (${s.dir}): `;
  if (s.state === "current") return `${head}current, Laisso ${version}`;
  if (s.state === "missing") return `${head}missing; run laisso skill install`;
  return `${head}from ${s.installed === null ? "an unknown version" : `Laisso ${s.installed}`}, this is Laisso ${version}; run laisso skill install`;
}
