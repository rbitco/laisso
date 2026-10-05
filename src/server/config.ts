import { readFileSync } from "node:fs";
import { isMap, isSeq, parse, parseDocument, type Document } from "yaml";
import { applyPatch, writeLike } from "../yaml-edit.ts";
import type { LassoHome } from "./home.ts";
import { count, duration, flag, isPlainObject, mapping, money, positive, text, type Fail } from "../fields.ts";
import { RUNNERS, type Pipeline, type RunnerName, type RunnerStage } from "../pipeline/load.ts";

export interface RepoConfig {
  tracker: "jira" | "github";
  project: string;
  path: string;
  pipeline: string;
  /** Actions this repo defines; one with a global Action's name replaces it for this repo's Tickets (ADR 0010). */
  actions: Record<string, ActionConfig>;
  /** Agent Profiles this repo defines; one with a global profile's name replaces it whole for this repo's Tickets (ADR 0011). */
  profiles: Record<string, ProfileConfig>;
  /** The profile this repo's Stages run under when neither they nor their Pipeline names one; null leaves config's default_profile. */
  default_profile: string | null;
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

/** Reasoning effort a profile may ask for: the set every Runner accepts (ADR 0011). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** How much a Session may do unasked; each adapter maps it to its Runner's own flag, and Pi has none (ADR 0011). */
export const PERMISSIONS = ["auto", "edits", "full"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** What a profile's `headless:` or `human:` block may set for Sessions of that mode. */
export interface ProfileBlock {
  /** Free text, passed to the Runner's model flag as written. */
  model?: string;
  effort?: Effort;
  /** In place of the adapter's baseline permission flag for the mode; Pi ignores it. */
  permission?: Permission;
  /** Appended after every flag Lasso writes, so a repeated flag wins where the Runner lets the last one win; a block's follow the shared ones. */
  args?: string[];
}

/**
 * The settings one Session runs with: a profile with its mode's block merged
 * in. This is all an adapter sees. Fields left out keep the Runner's own
 * default, or the adapter's baseline for that mode.
 */
export interface ProfileSettings extends ProfileBlock {
  runner: RunnerName;
  /** Codex only: where the Stage's skills live; ~/.agents/skills when unset. */
  skills_dir?: string;
}

/**
 * An Agent Profile (ADR 0011): the Runner a Stage runs under, with the model,
 * effort, permission and extra args it is given, and optional blocks that
 * differ for headless and human Sessions.
 */
export interface ProfileConfig extends ProfileSettings {
  headless?: ProfileBlock;
  human?: ProfileBlock;
}

export interface Config {
  repos: Record<string, RepoConfig>;
  actions: Record<string, ActionConfig>;
  profiles: Record<string, ProfileConfig>;
  /** The profile a Stage runs under when neither it nor its Pipeline names one. */
  default_profile: string | null;
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
  profiles: {
    "claude-fable": { runner: "claude", model: "fable", permission: "auto" },
    "claude-opus": { runner: "claude", model: "opus", permission: "auto" },
    "claude-sonnet": { runner: "claude", model: "sonnet", permission: "auto" },
  },
  default_profile: "claude-opus",
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
#    actions: {}              # this repo's own Actions; one named like a global Action replaces it here
#    profiles: {}             # this repo's own Agent Profiles; one named like a global profile replaces it whole here
#    default_profile: claude-sonnet  # this repo's default, in place of the global default_profile below

# Actions: shell commands an action Stage runs by name, in the Ticket's
# worktree, with the Ticket's details as LASSO_* environment variables.
actions: {}
#  notify:
#    params: [channel]        # a Stage supplies these under with:, as LASSO_CHANNEL
#    timeout: 5m              # killed and Flagged after this long
#    run: echo "$LASSO_REFERENCE is at $LASSO_STAGE" >> ~/lasso-$LASSO_CHANNEL.log

# Agent Profiles: the Runner a Stage runs under, and how. A Stage names one
# with profile:, or inherits its Pipeline's, or default_profile below.
profiles:
  claude-fable:
    runner: claude           # claude | codex | pi
    model: fable             # passed to the Runner's model flag; unset keeps its default
    permission: auto         # auto | edits | full; unset keeps Lasso's default per mode; Pi has none
  claude-opus:
    runner: claude
    model: opus
    permission: auto
  claude-sonnet:
    runner: claude
    model: sonnet
    permission: auto
#  codex-high:
#    runner: codex
#    model: gpt-5-codex
#    effort: high             # low | medium | high | xhigh | max; unset keeps the Runner's default
#    permission: auto
#    # args: [-c, foo=bar]    # extra flags, after the ones Lasso writes
#    # skills_dir: ~/skills   # Codex only: where skills live; default ~/.agents/skills
#    human:                   # only for human Stages; headless: is the same for the rest
#      permission: edits      # model, effort and permission here replace the ones above
#      args: [--search]       # args here follow the ones above
#  pi-gpt:
#    runner: pi
#    model: openai/gpt-5
#    effort: medium
#    human:
#      effort: high
default_profile: claude-opus

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
 * config.yaml as it stands now, for the Actions in it. Actions are edited by
 * hand only, so each use reads the file rather than the config Lasso started
 * with; a file that no longer parses leaves `running` in force.
 */
export function currentConfig(home: LassoHome, running: Config): Config {
  try {
    return loadConfig(home);
  } catch {
    return running;
  }
}

/** The Actions a repo's Tickets run: the global ones, with the repo's own replacing any of the same name. */
export function actionsFor(config: Config, repo: string): Record<string, ActionConfig> {
  return { ...config.actions, ...config.repos[repo]?.actions };
}

/** The Agent Profiles a repo's Tickets run under: the global ones, with the repo's own replacing any of the same name whole. */
export function profilesFor(config: ProfileScope, repo: string): Record<string, ProfileConfig> {
  return { ...config.profiles, ...config.repos[repo]?.profiles };
}

/** Every profile name some repo can reach: a Pipeline naming any of them may be saved, since Pipelines are not bound to a repo. */
export function anyRepoProfiles(config: Config): Record<string, ProfileConfig> {
  return Object.assign({}, config.profiles, ...Object.values(config.repos).map((repo) => repo.profiles));
}

/** Every set of Actions some repo sees, the global set first: a Pipeline that fits any of them may be saved. */
export function actionSets(config: Config): Array<Record<string, ActionConfig>> {
  return [config.actions, ...Object.keys(config.repos).map((repo) => actionsFor(config, repo))];
}

/** Parse config.yaml text into a Config; a value that is present but wrong is a ConfigError naming the key. */
export function parseConfig(text: string, file: string, overrides: { port?: number } = {}): Config {
  const raw = mapping(parse(text), file, fail);
  const at = (key: string) => `${file}: ${key}`;
  const D = DEFAULT_CONFIG;
  const budget = mapping(raw.budget, at("budget"), fail);
  const notifications = mapping(raw.notifications, at("notifications"), fail);
  const config: Config = {
    repos: normaliseRepos(mapping(raw.repos, at("repos"), fail), at("repos")),
    actions: parseActions(mapping(raw.actions, at("actions"), fail), at("actions")),
    profiles: raw.profiles === undefined ? structuredClone(D.profiles) : parseProfiles(mapping(raw.profiles, at("profiles"), fail), at("profiles")),
    default_profile: raw.default_profile === undefined ? D.default_profile : raw.default_profile === null ? null : profileName(raw.default_profile, at("default_profile")),
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
  default_profile: null,
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
    if (key === "profiles") throw new ConfigError("profiles are saved one at a time, through /api/profiles/<name>");
    if (key === "default_profile" && typeof value !== "string") throw new ConfigError("default_profile must name a profile");
    if (!(key in EDITABLE)) throw new ConfigError(`unknown field ${key}`);
    const fields = EDITABLE[key];
    if (fields && value !== null) {
      if (!isPlainObject(value)) throw new ConfigError(`${key} must be a mapping`);
      for (const sub of Object.keys(value)) if (!fields.has(sub)) throw new ConfigError(`unknown field ${key}.${sub}`);
    }
  }
  const doc = parseDocument(text);
  applyPatch(doc, patch);
  const out = doc.toString(writeLike(text));
  const config = parseConfig(out, file);
  if ("default_profile" in patch) knownProfile(config, config.default_profile!);
  return { text: out, config };
}

/** A profile name config.yaml defines globally, or a ConfigError saying it does not. */
function knownProfile(config: Config, name: string): void {
  if (!config.profiles[name]) throw new ConfigError(`no profile named ${name} in config.yaml`);
}

/** Where a profile edit lands: config.yaml's global profiles:, or one repo's own (ADR 0011). */
export interface ProfileWhere {
  /** The repo whose profiles: to edit; absent edits the global ones. */
  repo?: string;
}

/** The profiles an edit reads and the path to them in config.yaml, refusing a repo config.yaml lacks. */
function profileScope(config: Config, where: ProfileWhere): { profiles: Record<string, ProfileConfig>; path: string[]; of: string } {
  if (where.repo === undefined) return { profiles: config.profiles, path: ["profiles"], of: "config.yaml" };
  const repo = config.repos[where.repo];
  if (!repo) throw new ConfigError(`no repo named ${where.repo} in config.yaml`);
  return { profiles: repo.profiles, path: ["repos", where.repo, "profiles"], of: `repo ${where.repo}` };
}

/**
 * Create or replace one Agent Profile in config.yaml text, comments kept:
 * a global one, or with `repo` that repo's own, which replaces a global of
 * the same name whole for its Tickets. Fields the new profile leaves out are
 * removed, unchanged ones are not touched, and the result is checked by the
 * same parser as config load. `profile` is the profile as config.yaml would
 * hold it. With `create`, an existing profile of that name in that scope is
 * refused; without, a missing one is.
 */
export function writeProfileText(text: string, file: string, name: string, profile: unknown, opts: { create?: boolean } & ProfileWhere = {}): { text: string; config: Config } {
  profileName(name, `profiles.${name}`);
  if (!isPlainObject(profile)) throw new ConfigError("profile must be a mapping of its fields");
  const before = parseConfig(text, file);
  const scope = profileScope(before, opts);
  if (opts.create && scope.profiles[name]) throw new ConfigError(`profile ${name} already exists${opts.repo === undefined ? "" : ` in repo ${opts.repo}`}`);
  if (!opts.create && !scope.profiles[name]) throw new ConfigError(`no profile named ${name} in ${scope.of}`);
  // An empty mode block says nothing, so it is left out rather than written.
  const now = Object.fromEntries(Object.entries(profile).filter(([key, value]) => !(MODES.includes(key as Mode) && isPlainObject(value) && !Object.keys(value).length)));
  const doc = profilesDocument(text, before, scope.path);
  const at = [...scope.path, name];
  const node = doc.getIn(at, true);
  const was = isMap(node) ? (node.toJSON() as Record<string, unknown>) : null;
  if (was) applyPatch(doc, replacing(was, now), at);
  else doc.setIn(at, doc.createNode(now));
  // New args read best on one line, as the shipped examples write them.
  const argsAt = (p: Record<string, unknown> | null, mode?: Mode) => JSON.stringify((mode ? (p?.[mode] as Record<string, unknown> | undefined) : p)?.args);
  for (const mode of [undefined, ...MODES]) {
    const args = doc.getIn([...at, ...(mode ? [mode] : []), "args"], true);
    if (isSeq(args) && argsAt(was, mode) !== argsAt(now, mode)) args.flow = true;
  }
  const out = doc.toString(writeLike(text));
  return { text: out, config: parseConfig(out, file) };
}

/**
 * Remove one Agent Profile from config.yaml text, comments kept: a global
 * one, or with `repo` that repo's own, which returns the repo to the global
 * profile of that name if there is one. A default_profile cannot be removed
 * from under itself; name another first. Whatever else names it is the
 * caller's to weigh (see profileNamers).
 */
export function deleteProfileText(text: string, file: string, name: string, where: ProfileWhere = {}): { text: string; config: Config } {
  const before = parseConfig(text, file);
  const scope = profileScope(before, where);
  if (!scope.profiles[name]) throw new ConfigError(`no profile named ${name} in ${scope.of}`);
  if (where.repo === undefined && before.default_profile === name) throw new ConfigError(`${name} is the default_profile; make another profile the default first`);
  if (where.repo !== undefined && before.repos[where.repo]!.default_profile === name && !before.profiles[name]) throw new ConfigError(`${name} is repo ${where.repo}'s default_profile; make another profile its default first`);
  const doc = profilesDocument(text, before, scope.path);
  doc.deleteIn([...scope.path, name]);
  // An empty profiles: stays, written {}: the global one since a missing one would bring the shipped profiles back, and a repo's so its line and comments stay put.
  const left = doc.getIn(scope.path, true);
  if (isMap(left) && left.items.length === 0) left.flow = true;
  const out = doc.toString(writeLike(text));
  return { text: out, config: parseConfig(out, file) };
}

/**
 * Set or clear a repo's default_profile in config.yaml text, comments kept.
 * It must name a profile the repo's Tickets can reach: its own or a global
 * one. null clears it, leaving the repo to config's default_profile.
 */
export function repoDefaultText(text: string, file: string, repo: string, name: unknown): { text: string; config: Config } {
  const before = parseConfig(text, file);
  if (!before.repos[repo]) throw new ConfigError(`no repo named ${repo} in config.yaml`);
  if (name !== null && typeof name !== "string") throw new ConfigError("default_profile must name a profile, or be null to clear it");
  if (name !== null && !profilesFor(before, repo)[name]) throw new ConfigError(`no profile named ${name} in config.yaml for repo ${repo}`);
  const doc = parseDocument(text);
  applyPatch(doc, { default_profile: name }, ["repos", repo]);
  const out = doc.toString(writeLike(text));
  return { text: out, config: parseConfig(out, file) };
}

/**
 * Who names a global profile by name in config.yaml: the default_profile and
 * each repo's (a repo with its own profile of that name is unaffected, as it
 * never reads the global one).
 */
export function profileNamers(config: Config, name: string): string[] {
  const namers = config.default_profile === name ? ["default_profile"] : [];
  for (const [repo, r] of Object.entries(config.repos)) if (r.default_profile === name && !r.profiles[name]) namers.push(`repo ${repo}'s default_profile`);
  return namers;
}

/**
 * config.yaml's document with the profiles: an edit touches written out as
 * a block: the global ones in full, so an edit to one never drops the shipped
 * ones a file without profiles: runs on, and a repo's made if it has none.
 */
function profilesDocument(text: string, config: Config, path: string[]): Document {
  const doc = parseDocument(text);
  if (!doc.hasIn(path)) doc.setIn(path, doc.createNode(path.length === 1 ? config.profiles : {}));
  const profiles = doc.getIn(path, true);
  if (isMap(profiles)) profiles.flow = false;
  return doc;
}

/** The patch that turns `was` into `now`: a field left out is cleared, an unchanged one left alone, and a mode block patched the same way. */
function replacing(was: Record<string, unknown>, now: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(was)) if (!(key in now)) patch[key] = null;
  for (const [key, value] of Object.entries(now)) {
    if (JSON.stringify(value) === JSON.stringify(was[key])) continue;
    // A block that was there and still is keeps its comments; anything else is set whole (cleared first, as the patch merges mappings).
    if (MODES.includes(key as Mode) && isPlainObject(value) && isPlainObject(was[key]) && Object.keys(value).length) patch[key] = replacing(was[key] as Record<string, unknown>, value);
    else patch[key] = value;
  }
  return patch;
}

/** Carry a freshly parsed config into the object the running server shares, in place, so every holder sees it. */
export function applyLive(live: Config, fresh: Config): void {
  Object.assign(live.budget, fresh.budget);
  Object.assign(live.notifications, fresh.notifications);
  for (const key of Object.keys(live.repos)) delete live.repos[key];
  Object.assign(live.repos, fresh.repos);
  for (const key of Object.keys(live.actions)) delete live.actions[key];
  Object.assign(live.actions, fresh.actions);
  for (const key of Object.keys(live.profiles)) delete live.profiles[key];
  Object.assign(live.profiles, fresh.profiles);
  live.default_profile = fresh.default_profile;
  live.concurrency = fresh.concurrency;
  live.retention = fresh.retention;
  live.branch_prefix = fresh.branch_prefix;
}

function normaliseRepos(value: Record<string, unknown>, where: string): Record<string, RepoConfig> {
  const repos: Record<string, RepoConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    const repo = isPlainObject(entry) ? entry : {};
    repos[name] = {
      tracker: repo.tracker === "github" ? "github" : "jira",
      project: String(repo.project ?? ""),
      path: String(repo.path ?? ""),
      pipeline: typeof repo.pipeline === "string" ? repo.pipeline : "default",
      actions: parseActions(mapping(repo.actions, `${where}.${name}.actions`, fail), `${where}.${name}.actions`),
      profiles: parseProfiles(mapping(repo.profiles, `${where}.${name}.profiles`, fail), `${where}.${name}.profiles`),
      default_profile: repo.default_profile === undefined || repo.default_profile === null ? null : profileName(repo.default_profile, `${where}.${name}.default_profile`),
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

/** What an Agent Profile may be called. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const PROFILE_FIELDS = new Set(["runner", "model", "effort", "permission", "args", "skills_dir", "headless", "human"]);
const BLOCK_FIELDS = new Set(["model", "effort", "permission", "args"]);
const MODES = ["headless", "human"] as const;
type Mode = (typeof MODES)[number];

function profileName(value: unknown, at: string): string {
  if (typeof value !== "string" || !PROFILE_NAME.test(value)) throw new ConfigError(`${at}: a profile name is lowercase letters, digits, dots, hyphens, and underscores, not ${String(value)}`);
  return value;
}

function parseProfiles(value: Record<string, unknown>, where: string): Record<string, ProfileConfig> {
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    const at = `${where}.${name}`;
    profileName(name, at);
    const profile = mapping(entry, at, fail);
    for (const key of Object.keys(profile)) if (!PROFILE_FIELDS.has(key)) throw new ConfigError(`${at}: unknown field ${key}`);
    if (!(RUNNERS as readonly unknown[]).includes(profile.runner)) throw new ConfigError(`${at}: runner must be one of ${RUNNERS.join(", ")}, not ${String(profile.runner ?? "unset")}`);
    const parsed: ProfileConfig = { runner: profile.runner as RunnerName, ...parseBlock(profile, at) };
    if (profile.skills_dir !== undefined) {
      if (typeof profile.skills_dir !== "string" || !profile.skills_dir.trim()) throw new ConfigError(`${at}.skills_dir must be a directory`);
      parsed.skills_dir = profile.skills_dir;
    }
    for (const mode of MODES) {
      if (profile[mode] === undefined) continue;
      const block = mapping(profile[mode], `${at}.${mode}`, fail);
      for (const key of Object.keys(block)) if (!BLOCK_FIELDS.has(key)) throw new ConfigError(`${at}.${mode}: unknown field ${key}`);
      parsed[mode] = parseBlock(block, `${at}.${mode}`);
    }
    profiles[name] = parsed;
  }
  return profiles;
}

/** The fields a profile and its mode blocks share, checked alike in both. */
function parseBlock(value: Record<string, unknown>, at: string): ProfileBlock {
  const parsed: ProfileBlock = {};
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !value.model.trim()) throw new ConfigError(`${at}.model must be a model name`);
    parsed.model = value.model;
  }
  if (value.effort !== undefined) parsed.effort = oneOf(EFFORTS, value.effort, `${at}.effort`);
  if (value.permission !== undefined) parsed.permission = oneOf(PERMISSIONS, value.permission, `${at}.permission`);
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || !value.args.every((a) => typeof a === "string" || typeof a === "number")) throw new ConfigError(`${at}.args must be a list of arguments`);
    parsed.args = value.args.map(String);
  }
  return parsed;
}

function oneOf<T extends string>(choices: readonly T[], value: unknown, at: string): T {
  if (!(choices as readonly unknown[]).includes(value)) throw new ConfigError(`${at} must be one of ${choices.join(", ")}, not ${String(value)}`);
  return value as T;
}

/** Where a Session's profile was named: the Stage, its Pipeline, the repo's default_profile, or config's. */
export type ProfileSource = "stage" | "pipeline" | "repo" | "default";

/** The Agent Profile a Stage runs under, as config has it when the Session starts, with the Stage's mode merged in. */
export interface ResolvedProfile {
  name: string;
  from: ProfileSource;
  profile: ProfileSettings;
}

/** What resolving a profile reads from config: the global profiles and default, and each repo's own. */
export type ProfileScope = Pick<Config, "profiles" | "default_profile"> & { repos: Record<string, Pick<RepoConfig, "profiles" | "default_profile">> };

/**
 * A Stage's profile: its own, else its Pipeline's, else the repo's
 * default_profile, else config's (ADR 0011). The name is looked up among the
 * repo's profiles first, then the global ones. Profiles are live config, so
 * this is asked at each Session start; a name config no longer has is a
 * problem, never a fallback. The Stage's `human` flag picks the block merged
 * in, so a Session gets one flat set of settings.
 */
export function resolveProfile(config: ProfileScope, repo: string, pipeline: Pick<Pipeline, "name" | "profile">, stage: Pick<RunnerStage, "name" | "profile" | "human">): ResolvedProfile | { problem: string } {
  const repoDefault = config.repos[repo]?.default_profile ?? null;
  const [name, from] = stage.profile ? [stage.profile, "stage" as const] : pipeline.profile ? [pipeline.profile, "pipeline" as const] : repoDefault ? [repoDefault, "repo" as const] : [config.default_profile, "default" as const];
  if (name === null) return { problem: `Stage ${stage.name} names no profile, nor does Pipeline ${pipeline.name}, and config.yaml has no default_profile` };
  const profile = profilesFor(config, repo)[name];
  if (profile) return { name, from, profile: settingsFor(profile, stage.human ? "human" : "headless") };
  const by = { stage: `Stage ${stage.name}`, pipeline: `Pipeline ${pipeline.name}`, repo: `repo ${repo}'s default_profile`, default: "default_profile" }[from];
  return { problem: `no profile named ${name} in config.yaml, which ${by} names` };
}

/** A profile with one mode's block merged in: the block's model, effort and permission replace the shared ones, and its args follow. */
export function settingsFor(profile: ProfileConfig, mode: (typeof MODES)[number]): ProfileSettings {
  const { headless: _headless, human: _human, ...shared } = profile;
  const block = profile[mode];
  if (!block) return shared;
  const { args, ...fields } = block;
  const merged: ProfileSettings = { ...shared, ...fields };
  if (args) merged.args = [...(shared.args ?? []), ...args];
  return merged;
}
