import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { profilesFor, type Config, type ProfileConfig } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import { listPipelines, loadPipeline, parsePipeline, type Pipeline, type RunnerName } from "../pipeline/load.ts";
import { DEFAULT_PIPELINE_YAML } from "../pipeline/default.ts";
import { runTool, type ToolResult } from "../tracker/exec.ts";
import { overridesOf, shortId, type TicketRow } from "../store/tickets.ts";

/** A Ticket as the tool check reads it: what to call it, its repo, and the profile a human chose per Stage. */
export interface TicketUse {
  name: string;
  repo: string;
  overrides: Record<string, string>;
}

/** What the tool check derives the needed tools from: config, the Pipelines in the Lasso home, and the active Tickets' profile overrides. */
export interface ToolUse {
  config: Config;
  pipelines: Pipeline[];
  tickets: TicketUse[];
}

/** One external tool Lasso runs, with why. An optional tool only improves something and is reported as info. */
export interface NeededTool {
  name: string;
  optional: boolean;
  reasons: string[];
}

/** A tool and where PATH has it, or null when it is not there. */
export interface ToolPresence extends NeededTool {
  path: string | null;
}

/** A doctor row: a tool, where it is, and whether its own status command says it is logged in; null when it has none or is missing. */
export interface DoctorRow extends ToolPresence {
  loggedIn: boolean | null;
}

/** Where a command is on PATH, or null. */
export type Lookup = (command: string) => string | null;

/** Runs a status command and reports its exit code and output; never throws. */
export type RunCommand = (command: string, args: string[]) => Promise<ToolResult>;

/** The executable each Runner is started as. */
const RUNNER_COMMANDS: Record<RunnerName, string> = { claude: "claude", codex: "codex", pi: "pi" };

/** The tracker CLI each kind of repo talks through. */
const TRACKER_COMMANDS: Record<Config["repos"][string]["tracker"], string> = { github: "gh", jira: "acli" };

/** Each tool's own status command, for the ones that have one. Codex and Pi are left out: neither offers one that needs no arguments. */
const LOGIN_CHECKS: Record<string, { args: string[]; loggedIn: (r: ToolResult) => boolean }> = {
  gh: { args: ["auth", "status"], loggedIn: (r) => r.code === 0 },
  acli: { args: ["jira", "auth", "status"], loggedIn: (r) => r.code === 0 && !/unauthenticated|not (logged in|authenticated)/i.test(r.stdout + r.stderr) },
  claude: { args: ["auth", "status"], loggedIn: claudeLoggedIn },
};

/** Artifacts Lasso checks by reading the PR through gh. */
const PR_ARTIFACTS = new Set(["pr-exists", "pr-review", "pr-merged"]);

/**
 * The external tools this config needs, each with every reason. git always;
 * the Runner of every Agent Profile something names (default_profile, a
 * repo's default, a Pipeline, a Stage, a Ticket's override); gh or acli when
 * a repo's tracker talks through it, an Action's run text names it, or (gh)
 * a Stage reads the PR. A Runner nothing names is not listed.
 * terminal-notifier is optional while notifications are on.
 */
export function neededTools(use: ToolUse): NeededTool[] {
  const { config } = use;
  const needed = new Map<string, NeededTool>();
  const need = (name: string, reason: string, optional = false) => {
    const tool = needed.get(name) ?? { name, optional, reasons: [] };
    if (!tool.reasons.includes(reason)) tool.reasons.push(reason);
    needed.set(name, tool);
  };

  need("git", "worktrees and branches");

  // A name read outside any one repo resolves to the global profile, or to a repo's own of that name for that repo's Tickets.
  const anywhere = (name: string): ProfileConfig[] => [config.profiles[name], ...Object.values(config.repos).map((r) => r.profiles[name])].filter((p): p is ProfileConfig => p !== undefined);
  const inRepo = (name: string, repo: string): ProfileConfig[] => {
    const profile = profilesFor(config, repo)[name];
    return profile ? [profile] : [];
  };
  const runnersOf = (name: string, profiles: ProfileConfig[], where: string) => {
    for (const runner of new Set(profiles.map((p) => p.runner))) need(RUNNER_COMMANDS[runner], `profile ${name} (${where})`);
  };

  if (config.default_profile) runnersOf(config.default_profile, anywhere(config.default_profile), "default_profile");
  for (const [repo, r] of Object.entries(config.repos)) {
    if (r.default_profile) runnersOf(r.default_profile, inRepo(r.default_profile, repo), `repo ${repo}'s default_profile`);
  }
  for (const pipeline of use.pipelines) {
    if (pipeline.profile) runnersOf(pipeline.profile, anywhere(pipeline.profile), `Pipeline ${pipeline.name}`);
    for (const stage of pipeline.stages) {
      if (stage.kind !== "runner") continue;
      if (stage.profile) runnersOf(stage.profile, anywhere(stage.profile), `Pipeline ${pipeline.name}`);
      if (stage.repeat === "feedback" || (stage.artifact && PR_ARTIFACTS.has(stage.artifact))) need("gh", `Pipeline ${pipeline.name} reads the PR`);
    }
  }
  for (const ticket of use.tickets) {
    for (const name of Object.values(ticket.overrides)) runnersOf(name, inRepo(name, ticket.repo), `Ticket ${ticket.name}'s override`);
  }

  for (const [repo, r] of Object.entries(config.repos)) need(TRACKER_COMMANDS[r.tracker], `repo ${repo}'s tracker (${r.tracker})`);
  const actionNeeds = (actions: Config["actions"], where: string) => {
    for (const [name, action] of Object.entries(actions)) {
      for (const tool of ["gh", "acli"]) if (names(action.run, tool)) need(tool, `${where}Action ${name}`);
    }
  };
  actionNeeds(config.actions, "");
  for (const [repo, r] of Object.entries(config.repos)) actionNeeds(r.actions, `repo ${repo}'s `);

  if (config.notifications.enabled) need("terminal-notifier", "notifications that open the Ticket on click (osascript otherwise)", true);

  return [...needed.values()];
}

/** Whether shell text runs `tool` as a word of its own: `gh pr view` does, `ghost` and `gh-pages` do not. */
function names(run: string, tool: string): boolean {
  return new RegExp(`(?<![\\w./-])${tool}(?![\\w.-])`).test(run);
}

/** Where each tool is on PATH. No network, no tool is run: what startup can afford. */
export function checkPath(tools: NeededTool[], lookup: Lookup): ToolPresence[] {
  return tools.map((tool) => ({ ...tool, path: lookup(tool.name) }));
}

/** The needed tools PATH lacks; an optional tool never counts. */
export function missingTools(tools: NeededTool[], lookup: Lookup): ToolPresence[] {
  return checkPath(tools, lookup).filter((t) => !t.optional && t.path === null);
}

/** PATH, then each found tool's own status command where it has one. */
export async function doctor(tools: NeededTool[], deps: { lookup: Lookup; run: RunCommand }): Promise<DoctorRow[]> {
  return Promise.all(
    checkPath(tools, deps.lookup).map(async (tool): Promise<DoctorRow> => {
      const check = LOGIN_CHECKS[tool.name];
      if (!check || tool.path === null) return { ...tool, loggedIn: null };
      return { ...tool, loggedIn: check.loggedIn(await deps.run(tool.name, check.args)) };
    }),
  );
}

/** `claude auth status` answers JSON with loggedIn; anything else falls back to its exit code. */
function claudeLoggedIn(r: ToolResult): boolean {
  try {
    const status = JSON.parse(r.stdout) as { loggedIn?: unknown };
    if (typeof status.loggedIn === "boolean") return status.loggedIn;
  } catch {
    // not JSON: an older claude
  }
  return r.code === 0;
}

/** The real PATH: the first executable file of that name in its directories. */
export function findOnPath(env: NodeJS.ProcessEnv = process.env): Lookup {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return (command) => {
    for (const dir of dirs) {
      const file = path.join(dir, command);
      try {
        accessSync(file, constants.X_OK);
        if (statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
    return null;
  };
}

/** Status commands for real, through the same runner the trackers use. */
export const runCommand: RunCommand = (command, args) => runTool(command, args);

/**
 * The Pipelines in the Lasso home that load; a home with none yet gets the
 * default Pipeline, as Lasso writes it on first start.
 */
export function homePipelines(home: LassoHome): Pipeline[] {
  const names = listPipelines(home.pipelinesDir);
  if (names.length === 0) return [parsePipeline("default", DEFAULT_PIPELINE_YAML)];
  const pipelines: Pipeline[] = [];
  for (const name of names) {
    try {
      pipelines.push(loadPipeline(home.pipelinesDir, name));
    } catch {
      // a broken Pipeline names nothing Lasso can run
    }
  }
  return pipelines;
}

/** An active Ticket's overrides, from its row. */
export function ticketUse(row: Pick<TicketRow, "id" | "reference" | "repo" | "profile_overrides">): TicketUse {
  return { name: row.reference ?? shortId(row.id), repo: row.repo, overrides: overridesOf(row) };
}

/**
 * Active Tickets' overrides read straight from the store, for doctor, which
 * runs without the Lasso process (ADR 0008: it never writes the store). A
 * store that is missing or not readable yet means no Tickets.
 */
export function storeTickets(home: LassoHome): TicketUse[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(home.dbFile, { readOnly: true });
    const rows = db.prepare(`SELECT id, reference, repo, profile_overrides FROM tickets WHERE state = 'active' AND profile_overrides IS NOT NULL`).all() as unknown as Parameters<typeof ticketUse>[0][];
    return rows.map(ticketUse);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
