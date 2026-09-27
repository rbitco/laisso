import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { LassoHome } from "./home.ts";
import { parseDuration } from "../duration.ts";

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

export interface Config {
  repos: Record<string, RepoConfig>;
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
  const raw = readRaw(home.configFile);
  const config: Config = {
    repos: normaliseRepos(raw.repos),
    budget: { ...DEFAULT_CONFIG.budget, ...asObject(raw.budget) },
    tick: asNumber(raw.tick, DEFAULT_CONFIG.tick),
    concurrency: asNumber(raw.concurrency, DEFAULT_CONFIG.concurrency),
    retention: asNumber(raw.retention, DEFAULT_CONFIG.retention),
    branch_prefix: typeof raw.branch_prefix === "string" ? raw.branch_prefix : DEFAULT_CONFIG.branch_prefix,
    port: asNumber(raw.port, DEFAULT_CONFIG.port),
    notifications: { ...DEFAULT_CONFIG.notifications, ...asObject(raw.notifications) },
  };
  if (overrides.port !== undefined) config.port = overrides.port;
  try {
    parseDuration(config.budget.wallTime);
  } catch (error) {
    throw new ConfigError(`${home.configFile}: budget.wallTime ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new ConfigError(`${home.configFile}: concurrency must be a whole number of 1 or more, not ${String(raw.concurrency)}`);
  }
  return config;
}

function readRaw(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const parsed = parse(text);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normaliseRepos(value: unknown): Record<string, RepoConfig> {
  const repos: Record<string, RepoConfig> = {};
  for (const [name, entry] of Object.entries(asObject(value))) {
    const repo = asObject(entry);
    repos[name] = {
      tracker: repo.tracker === "github" ? "github" : "jira",
      project: String(repo.project ?? ""),
      path: String(repo.path ?? ""),
      pipeline: typeof repo.pipeline === "string" ? repo.pipeline : "default",
    };
  }
  return repos;
}
