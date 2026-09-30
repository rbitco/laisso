import { readFileSync } from "node:fs";
import { parse, parseDocument } from "yaml";
import { applyPatch } from "../yaml-edit.ts";
import type { LassoHome } from "./home.ts";
import { count, duration, flag, isPlainObject, mapping, money, positive, text, type Fail } from "../fields.ts";

export interface RepoConfig {
  tracker: "jira" | "github";
  project: string;
  path: string;
  pipeline: string;
}

export interface BudgetDefaults {
  rounds: number;
  attempts: number;
  wallTime: string;
  spend: number;
}

export interface NotificationConfig {
  enabled: boolean;
  flagged: boolean;
  human: boolean;
  gate: boolean;
}

/** A named shell command an action Stage runs (ADR 0010). */
export interface ActionConfig {
  run: string;
  /** Names a Stage must supply under `with:`; each reaches the command as LASSO_<PARAM>. */
  params: string[];
  timeout: string;
}

export interface Config {
  repos: Record<string, RepoConfig>;
  actions: Record<string, ActionConfig>;
  budget: BudgetDefaults;
  tick: number;
  concurrency: number;
  retention: number;
  branch_prefix: string;
  port: number;
  notifications: NotificationConfig;
}

export const DEFAULT_CONFIG: Config = {
  repos: {},
  actions: {},
  budget: { rounds: 5, attempts: 2, wallTime: "30m", spend: 25 },
  tick: 60,
  concurrency: 3,
  retention: 30,
  branch_prefix: "",
  port: 7433,
  notifications: { enabled: true, flagged: true, human: true, gate: true },
};

export const DEFAULT_CONFIG_YAML = `# Lasso configuration. Every key is optional; the values shown are the defaults.
# Repos Lasso may intake into, keyed by a short name.
repos: {}
#  my-app:
#    tracker: jira            # jira | github
#    project: PROJ            # JIRA project key, or owner/repo for github
#    path: ~/code/my-app      # local checkout; worktrees are made from its origin
#    pipeline: default        # the repo's default Pipeline

# Actions: shell commands an action Stage runs by name, in the Ticket's
# worktree, with the Ticket's details as LASSO_* environment variables.
actions: {}
#  notify:
#    params: [channel]        # a Stage supplies these under with:, as LASSO_CHANNEL
#    timeout: 5m              # killed and Flagged after this long
#    run: echo "$LASSO_REFERENCE is at $LASSO_STAGE" >> ~/lasso-$LASSO_CHANNEL.log

# Global Budget defaults; a Pipeline or a Ticket may override each one.
budget:
  rounds: 5        # Rounds per repeating Stage
  attempts: 2      # attempts per Stage
  wallTime: 30m    # wall time per headless Session
  spend: 25        # agent spend per Ticket, USD

tick: 60           # seconds between polls of open PRs and pending work
concurrency: 3     # headless Sessions running at once, across all Tickets
retention: 30      # days a done or abandoned Ticket's directory is kept
branch_prefix: ""  # prefix for Ticket branches, e.g. your username; empty for none
port: 7433         # dashboard and API port

notifications:
  enabled: true
  flagged: true    # a Ticket was Flagged
  human: true      # a human Stage became current
  gate: true       # a Stage finished and the next waits on Start
`;

export class ConfigError extends Error {}

export function loadConfig(home: LassoHome, overrides: { port?: number } = {}): Config {
  let text: string;
  try {
    text = readFileSync(home.configFile, "utf8");
  } catch {
    text = "";
  }
  return parseConfig(text, home.configFile, overrides);
}

/**
 * The Actions config.yaml defines now. Actions are edited by hand only, so
 * each use reads the file rather than the config Lasso started with; a file
 * that no longer parses leaves `running`'s Actions in force.
 */
export function currentActions(home: LassoHome, running: Config): Record<string, ActionConfig> {
  try {
    return loadConfig(home).actions;
  } catch {
    return running.actions;
  }
}

/** Parse config.yaml text into a Config; a value that is present but wrong is a ConfigError naming the key. */
export function parseConfig(text: string, file: string, overrides: { port?: number } = {}): Config {
  const raw = mapping(parse(text), file, fail);
  const at = (key: string) => `${file}: ${key}`;
  const D = DEFAULT_CONFIG;
  const budget = mapping(raw.budget, at("budget"), fail);
  const notifications = mapping(raw.notifications, at("notifications"), fail);
  const config: Config = {
    repos: normaliseRepos(mapping(raw.repos, at("repos"), fail)),
    actions: parseActions(mapping(raw.actions, at("actions"), fail), at("actions")),
    budget: {
      rounds: count(budget.rounds, at("budget.rounds"), fail, D.budget.rounds),
      attempts: count(budget.attempts, at("budget.attempts"), fail, D.budget.attempts),
      wallTime: duration(budget.wallTime, at("budget.wallTime"), fail, D.budget.wallTime),
      spend: money(budget.spend, at("budget.spend"), fail, D.budget.spend),
    },
    tick: positive(raw.tick, at("tick"), fail, D.tick),
    concurrency: positive(raw.concurrency, at("concurrency"), fail, D.concurrency),
    retention: count(raw.retention, at("retention"), fail, D.retention),
    branch_prefix: string(raw.branch_prefix, at("branch_prefix"), fail, D.branch_prefix),
    port: positive(raw.port, at("port"), fail, D.port),
    notifications: {
      enabled: flag(notifications.enabled, at("notifications.enabled"), fail, D.notifications.enabled),
      flagged: flag(notifications.flagged, at("notifications.flagged"), fail, D.notifications.flagged),
      human: flag(notifications.human, at("notifications.human"), fail, D.notifications.human),
      gate: flag(notifications.gate, at("notifications.gate"), fail, D.notifications.gate),
    },
  };
  if (overrides.port !== undefined) config.port = overrides.port;
  return config;
}

const fail: Fail = (message) => new ConfigError(message);
const string = text;

/** What the dashboard may set (spec: Lasso home and configuration); repos stay a hand edit in v1. */
const EDITABLE: Record<string, Set<string> | null> = {
  budget: new Set(["rounds", "attempts", "wallTime", "spend"]),
  tick: null,
  concurrency: null,
  retention: null,
  branch_prefix: null,
  port: null,
  notifications: new Set(["enabled", "flagged", "human", "gate"]),
};

/** Keys whose new value only takes effect once Lasso restarts. */
export const RESTART_KEYS = ["port", "tick"] as const;

/**
 * Apply a patch to config.yaml text in place, comments kept; null clears a
 * key back to its default. Returns the new text and what it parses to, or
 * throws a ConfigError with nothing written.
 */
export function patchConfigText(text: string, file: string, patch: unknown): { text: string; config: Config } {
  if (!isPlainObject(patch)) throw new ConfigError("patch must be a mapping");
  if (Object.keys(patch).length === 0) throw new ConfigError("nothing to change");
  for (const [key, value] of Object.entries(patch)) {
    if (key === "repos" || key === "actions") throw new ConfigError(`${key} are edited in config.yaml by hand`);
    if (!(key in EDITABLE)) throw new ConfigError(`unknown field ${key}`);
    const fields = EDITABLE[key];
    if (fields && value !== null) {
      if (!isPlainObject(value)) throw new ConfigError(`${key} must be a mapping`);
      for (const sub of Object.keys(value)) if (!fields.has(sub)) throw new ConfigError(`unknown field ${key}.${sub}`);
    }
  }
  const doc = parseDocument(text);
  applyPatch(doc, patch);
  const out = doc.toString();
  return { text: out, config: parseConfig(out, file) };
}

/** Carry a freshly parsed config into the object the running server shares, in place, so every holder sees it. */
export function applyLive(live: Config, fresh: Config): void {
  Object.assign(live.budget, fresh.budget);
  Object.assign(live.notifications, fresh.notifications);
  for (const key of Object.keys(live.repos)) delete live.repos[key];
  Object.assign(live.repos, fresh.repos);
  for (const key of Object.keys(live.actions)) delete live.actions[key];
  Object.assign(live.actions, fresh.actions);
  live.concurrency = fresh.concurrency;
  live.retention = fresh.retention;
  live.branch_prefix = fresh.branch_prefix;
}

function normaliseRepos(value: Record<string, unknown>): Record<string, RepoConfig> {
  const repos: Record<string, RepoConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    const repo = isPlainObject(entry) ? entry : {};
    repos[name] = {
      tracker: repo.tracker === "github" ? "github" : "jira",
      project: String(repo.project ?? ""),
      path: String(repo.path ?? ""),
      pipeline: typeof repo.pipeline === "string" ? repo.pipeline : "default",
    };
  }
  return repos;
}

/** What an Action may be called, and what a param may be called so that LASSO_<PARAM> is a plain variable name. */
export const ACTION_NAME = /^[a-z0-9][a-z0-9._-]*$/;
export const PARAM_NAME = /^[a-z][a-z0-9_]*$/;
export const DEFAULT_ACTION_TIMEOUT = "5m";
const ACTION_FIELDS = new Set(["run", "params", "timeout"]);

function parseActions(value: Record<string, unknown>, where: string): Record<string, ActionConfig> {
  const actions: Record<string, ActionConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    const at = `${where}.${name}`;
    if (!ACTION_NAME.test(name)) throw new ConfigError(`${at}: an Action name is lowercase letters, digits, dots, hyphens, and underscores`);
    const action = mapping(entry, at, fail);
    for (const key of Object.keys(action)) if (!ACTION_FIELDS.has(key)) throw new ConfigError(`${at}: unknown field ${key}`);
    if (typeof action.run !== "string" || !action.run.trim()) throw new ConfigError(`${at}: run must be a command`);
    const params = action.params ?? [];
    if (!Array.isArray(params) || !params.every((p) => typeof p === "string" && PARAM_NAME.test(p))) throw new ConfigError(`${at}: params must be a list of names in lowercase letters, digits, and underscores`);
    if (new Set(params).size !== params.length) throw new ConfigError(`${at}: params names one param twice`);
    actions[name] = { run: action.run, params: params as string[], timeout: duration(action.timeout, `${at}.timeout`, fail, DEFAULT_ACTION_TIMEOUT) };
  }
  return actions;
}
