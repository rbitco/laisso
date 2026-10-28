import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse, YAMLParseError } from "yaml";
import { hyphenate } from "../intake/slug.ts";
import { count, duration, isPlainObject, mapping, money, text, type Fail } from "../fields.ts";
import { ACTION_NAME, PROFILE_NAME, type ActionConfig, type ProfileConfig } from "../server/config.ts";
import { ARTIFACTS } from "./artifacts.ts";

export { ARTIFACTS };

export const RUNNERS = ["claude", "codex", "pi"] as const;
export type RunnerName = (typeof RUNNERS)[number];

export interface StageBudget {
  rounds?: number;
  attempts?: number;
  wallTime?: string;
}

/**
 * A declared way out of a Stage to some Stage other than the next (CONTEXT.md:
 * Route). Optional fields are left out when not written, so a Pipeline
 * without them keeps the definition its Versions were taken from.
 */
export interface Route {
  /** The target Stage's name: an action Stage by its derived name unless it sets name:. */
  to: string;
  /** When to choose it, for whoever may. */
  when?: string;
  /** Text added after the target Stage's prompt, or (replace) in place of it, for the Visit the Route starts. */
  append?: string;
  replace?: string;
  /** How many times an agent, Action or check may take it; parsed here, enforced by the Route Budget. */
  budget?: number;
  /** false holds the Ticket before taking this Route, on this exit only, until a human presses Start (LASSO-196). */
  advance?: boolean;
}

/** A Stage's Routes by name; absent when it declares none. */
export type Routes = Record<string, Route>;

export interface RunnerStage {
  kind: "runner";
  name: string;
  prompt: string | null;
  skills: string[];
  /** The Agent Profile the Stage names; null inherits the Pipeline's, then config's default_profile (ADR 0011). */
  profile: string | null;
  human: boolean;
  advance: boolean;
  /** A built-in Artifact, `file <path>`, or `action <name>` for a check Action (ADR 0014). */
  artifact: string | null;
  /** The params a check Action Artifact passes, as an action Stage's `with`; set only for one. */
  artifactWith?: Record<string, string>;
  repeat: "feedback" | null;
  budget: StageBudget;
  routes?: Routes;
}

/** A Stage that runs an Action defined in config by name, with the params it supplies (ADR 0010). */
export interface ActionStage {
  kind: "action";
  name: string;
  action: string;
  with: Record<string, string>;
  routes?: Routes;
}

export type Stage = RunnerStage | ActionStage;

export interface Pipeline {
  name: string;
  /** The Agent Profile its Stages inherit; null leaves them to config's default_profile. */
  profile: string | null;
  budget: { spend?: number };
  stages: Stage[];
}

export class PipelineError extends Error {}
const fail: Fail = (message) => new PipelineError(message);

/** What a Pipeline may be called: the file name without its extension. */
export const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** What a Stage, and a Route, may be called. */
export const STAGE_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** The Budget dimensions a Stage sets; spend is the Pipeline's. */
export const STAGE_BUDGET_KEYS = ["rounds", "attempts", "wallTime"] as const;

export function listPipelines(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export function pipelineFile(dir: string, name: string): string | null {
  for (const ext of [".yaml", ".yml"]) {
    const file = path.join(dir, name + ext);
    try {
      readFileSync(file);
      return file;
    } catch {
      // try next
    }
  }
  return null;
}

export function loadPipeline(dir: string, name: string): Pipeline {
  const file = pipelineFile(dir, name);
  if (!file) throw new PipelineError(`Pipeline ${name} does not exist under ${dir}`);
  return parsePipeline(name, readFileSync(file, "utf8"));
}

const PIPELINE_FIELDS = new Set(["profile", "budget", "stages"]);
const RUNNER_STAGE_FIELDS = new Set(["name", "prompt", "skills", "profile", "human", "advance", "artifact", "repeat", "budget", "routes"]);
const ACTION_STAGE_FIELDS = new Set(["action", "name", "with", "routes"]);
const ROUTE_FIELDS = new Set(["to", "when", "append", "replace", "budget", "advance"]);

export function parsePipeline(name: string, text: string): Pipeline {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    // A key written twice, such as two Routes of one name, is refused by YAML itself.
    if (error instanceof YAMLParseError) throw new PipelineError(`Pipeline ${name}: ${error.message.split("\n")[0]}`);
    throw error;
  }
  if (!raw || typeof raw !== "object") throw new PipelineError(`Pipeline ${name} is empty`);
  const doc = raw as Record<string, unknown>;
  const where = `Pipeline ${name}`;
  // The form before ADR 0011; startup migration rewrites it, so only a hand edit meets this.
  if (doc.runner !== undefined) throw new PipelineError(`${where}: runner is now an Agent Profile in config.yaml; write profile: ${String(doc.runner)}`);
  for (const key of Object.keys(doc)) if (!PIPELINE_FIELDS.has(key)) throw new PipelineError(`${where}: unknown field ${key}`);
  const profile = asProfile(doc.profile, where);
  const stagesRaw = Array.isArray(doc.stages) ? doc.stages : null;
  if (!stagesRaw || stagesRaw.length === 0) throw new PipelineError(`${where} has no stages`);
  const stages = stagesRaw.map((entry, i) => parseStage(name, entry, i));
  const names = new Set<string>();
  for (const stage of stages) {
    if (names.has(stage.name)) throw new PipelineError(`${where} has two Stages named ${stage.name}`);
    names.add(stage.name);
  }
  for (const stage of stages) {
    for (const [route, { to }] of Object.entries(stage.routes ?? {})) {
      if (!names.has(to)) throw new PipelineError(`${where} Stage ${stage.name}: Route ${route} goes to ${to}, which is not a Stage of this Pipeline`);
    }
  }
  const budget = mapping(doc.budget, `${where}: budget`, fail);
  for (const key of Object.keys(budget)) {
    if (key === "spend") continue;
    if ((STAGE_BUDGET_KEYS as readonly string[]).includes(key)) throw new PipelineError(`${where}: budget.${key} belongs to a Stage, not the Pipeline`);
    throw new PipelineError(`${where}: unknown field budget.${key}`);
  }
  return { name, profile, budget: { spend: budget.spend === undefined ? undefined : money(budget.spend, `${where}: budget.spend`, fail) }, stages };
}

function parseStage(pipeline: string, entry: unknown, index: number): Stage {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new PipelineError(`Pipeline ${pipeline} stage ${index + 1} is not a mapping`);
  const s = entry as Record<string, unknown>;
  const where = `Pipeline ${pipeline} stage ${index + 1}`;
  const isAction = typeof s.action === "string";
  const isRunner = s.prompt !== undefined || s.skills !== undefined;
  if (isAction && isRunner) throw new PipelineError(`${where} has both action and prompt/skills`);
  if (isAction) return parseActionStage(s, where);
  if (!isRunner) throw new PipelineError(`${where} needs a prompt, skills, or an action`);
  if (s.runnerOptions !== undefined) {
    const named = typeof s.name === "string" ? `${pipeline}-${s.name}` : `${pipeline}-<stage>`;
    throw new PipelineError(`${where}: runnerOptions are now an Agent Profile in config.yaml; define one there with the runner and args, and write profile: ${named}`);
  }
  if (s.runner !== undefined) throw new PipelineError(`${where}: runner is now an Agent Profile in config.yaml; write profile: ${String(s.runner)}`);
  for (const key of Object.keys(s)) if (!RUNNER_STAGE_FIELDS.has(key)) throw new PipelineError(`${where}: unknown field ${key}`);
  if (typeof s.name !== "string" || !STAGE_NAME.test(s.name)) throw new PipelineError(`${where} needs a name of lowercase letters, digits, and hyphens`);
  if (s.prompt !== undefined) text(s.prompt, `${where}: prompt`, fail);
  if (s.skills !== undefined && (!Array.isArray(s.skills) || !s.skills.every((x) => typeof x === "string"))) throw new PipelineError(`${where}: skills must be a list of skill names`);
  const { artifact, artifactWith } = parseArtifact(s.artifact, where);
  if (s.repeat !== undefined && s.repeat !== "feedback") throw new PipelineError(`${where}: repeat must be feedback`);
  if (s.repeat === "feedback" && artifact === null) throw new PipelineError(`${where}: a repeating Stage needs an artifact as its end condition`);
  if (s.human !== undefined && typeof s.human !== "boolean") throw new PipelineError(`${where}: human must be true or false`);
  if (s.advance !== undefined && typeof s.advance !== "boolean") throw new PipelineError(`${where}: advance must be true or false`);
  const budget = mapping(s.budget, `${where}: budget`, fail);
  for (const key of Object.keys(budget)) {
    if ((STAGE_BUDGET_KEYS as readonly string[]).includes(key)) continue;
    if (key === "spend") throw new PipelineError(`${where}: budget.spend belongs to the Pipeline, not a Stage`);
    throw new PipelineError(`${where}: unknown field budget.${key}`);
  }
  return {
    kind: "runner",
    name: s.name,
    prompt: typeof s.prompt === "string" ? s.prompt : null,
    skills: Array.isArray(s.skills) ? s.skills.map(String) : [],
    profile: asProfile(s.profile, where),
    human: s.human === true,
    advance: s.advance !== false,
    artifact,
    ...(artifactWith ? { artifactWith } : {}),
    repeat: s.repeat === "feedback" ? "feedback" : null,
    budget: {
      rounds: budget.rounds === undefined ? undefined : count(budget.rounds, `${where}: budget.rounds`, fail),
      attempts: budget.attempts === undefined ? undefined : count(budget.attempts, `${where}: budget.attempts`, fail),
      wallTime: budget.wallTime === undefined ? undefined : duration(budget.wallTime, `${where}: budget.wallTime`, fail),
    },
    ...parseRoutes(s.routes, where),
  };
}

/**
 * A Stage's `routes:` map, keyed by Route name, as `{ routes }`, or nothing
 * when it declares none. Whether each `to` names a Stage is checked once
 * every Stage is parsed.
 */
function parseRoutes(value: unknown, where: string): { routes?: Routes } {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw new PipelineError(`${where}: routes must be a mapping of Route name to its fields`);
  const routes: Routes = {};
  for (const [name, raw] of Object.entries(value)) {
    const at = `${where} Route ${name}`;
    if (!STAGE_NAME.test(name)) throw new PipelineError(`${where}: Route ${name} needs a name of lowercase letters, digits, and hyphens`);
    if (!isPlainObject(raw)) throw new PipelineError(`${at} must be a mapping with to: <Stage>`);
    for (const key of Object.keys(raw)) if (!ROUTE_FIELDS.has(key)) throw new PipelineError(`${at}: ${key} is not a field of a Route`);
    if (typeof raw.to !== "string" || !raw.to) throw new PipelineError(`${at} needs to: <Stage>`);
    if (raw.append !== undefined && raw.replace !== undefined) throw new PipelineError(`${at} has both append and replace; give one`);
    const route: Route = { to: raw.to };
    if (raw.when !== undefined) route.when = text(raw.when, `${at}: when`, fail);
    if (raw.append !== undefined) route.append = text(raw.append, `${at}: append`, fail);
    if (raw.replace !== undefined) route.replace = text(raw.replace, `${at}: replace`, fail);
    if (raw.budget !== undefined) route.budget = count(raw.budget, `${at}: budget`, fail);
    if (raw.advance !== undefined) {
      if (typeof raw.advance !== "boolean") throw new PipelineError(`${at}: advance must be true or false`);
      route.advance = raw.advance;
    }
    routes[name] = route;
  }
  return Object.keys(routes).length ? { routes } : {};
}

const ARTIFACT_ACTION_FIELDS = new Set(["action", "with"]);

/** A Stage's artifact: a name as written, or `{ action, with }`, which reads as `action <name>` with its params. */
function parseArtifact(value: unknown, where: string): { artifact: string | null; artifactWith?: Record<string, string> } {
  if (value === undefined || value === null) return { artifact: null };
  if (isPlainObject(value)) {
    const o = value as Record<string, unknown>;
    for (const key of Object.keys(o)) if (!ARTIFACT_ACTION_FIELDS.has(key)) throw new PipelineError(`${where}: ${key} is not a field of a check Action artifact`);
    if (typeof o.action !== "string") throw new PipelineError(`${where}: a check Action artifact needs action: <name>`);
    return { artifact: `action ${o.action}`, artifactWith: parseWith(o.with, where, "artifact.with") };
  }
  const artifact = String(value);
  if (!isKnownArtifact(artifact)) throw new PipelineError(`${where}: unknown artifact ${artifact}`);
  return actionArtifact(artifact) === null ? { artifact } : { artifact, artifactWith: {} };
}

/** A `with:` mapping of param to single value. */
function parseWith(value: unknown, where: string, field: string): Record<string, string> {
  if (value !== undefined && !isPlainObject(value)) throw new PipelineError(`${where}: ${field} must be a mapping of param to value`);
  const params: Record<string, string> = {};
  for (const [key, v] of Object.entries((value as Record<string, unknown> | undefined) ?? {})) {
    if (v === null || typeof v === "object") throw new PipelineError(`${where}: ${field}.${key} must be a single value`);
    params[key] = String(v);
  }
  return params;
}

function parseActionStage(s: Record<string, unknown>, where: string): ActionStage {
  // The form before ADR 0010; startup migration rewrites it, so only a hand edit meets this.
  if (s.status !== undefined) throw new PipelineError(`${where}: status is now a param; write with: { status: ${String(s.status)} }`);
  for (const key of Object.keys(s)) if (!ACTION_STAGE_FIELDS.has(key)) throw new PipelineError(`${where}: ${key} is not a field of an action Stage`);
  const action = String(s.action);
  if (!ACTION_NAME.test(action)) throw new PipelineError(`${where}: ${action} is not an Action name`);
  if (s.name !== undefined && (typeof s.name !== "string" || !STAGE_NAME.test(s.name))) throw new PipelineError(`${where} needs a name of lowercase letters, digits, and hyphens`);
  const params = parseWith(s.with, where, "with");
  return { kind: "action", name: typeof s.name === "string" ? s.name : defaultActionName(action, params), action, with: params, ...parseRoutes(s.routes, where) };
}

/** An unnamed action Stage is called by its Action's last part and its param values: tracker.transition with status In Progress is transition-in-progress. */
export function defaultActionName(action: string, params: Record<string, string>): string {
  return hyphenate([action.split(".").at(-1)!, ...Object.values(params)].join(" "));
}

/**
 * Every action Stage names an Action config defines and supplies exactly
 * its params. Parsing cannot check this, since the Actions live in config;
 * saving a Pipeline and Intake do.
 */
export function checkActions(pipeline: Pipeline, actions: Record<string, ActionConfig>): void {
  for (const stage of pipeline.stages) {
    const where = `Pipeline ${pipeline.name} Stage ${stage.name}`;
    if (stage.kind === "action") checkParams(where, stage.action, stage.with, "with", actions);
    else if (stage.artifact && stage.artifactWith) checkParams(`${where} artifact`, actionArtifact(stage.artifact)!, stage.artifactWith, "with", actions);
  }
}

function checkParams(where: string, name: string, given: Record<string, string>, field: string, actions: Record<string, ActionConfig>): void {
  const action = actions[name];
  if (!action) throw new PipelineError(`${where}: no Action named ${name} in config.yaml`);
  const missing = action.params.filter((p) => !(p in given));
  if (missing.length) throw new PipelineError(`${where}: ${name} needs ${missing.map((p) => `${field}.${p}`).join(", ")}`);
  const unknown = Object.keys(given).filter((p) => !action.params.includes(p));
  if (unknown.length) throw new PipelineError(`${where}: ${name} takes no param ${unknown.join(", ")}`);
}

/**
 * checkActions against each set in turn: the Pipeline passes if any set fits
 * it. Otherwise the complaint of a set that has the Action (a param wrong)
 * says more than one that lacks it, so it stands ahead of the first.
 */
export function checkActionsAny(pipeline: Pipeline, sets: Array<Record<string, ActionConfig>>): void {
  const errors: PipelineError[] = [];
  for (const actions of sets) {
    try {
      return checkActions(pipeline, actions);
    } catch (error) {
      if (!(error instanceof PipelineError)) throw error;
      errors.push(error);
    }
  }
  const telling = errors.find((e) => !e.message.includes(": no Action named ")) ?? errors[0];
  if (telling) throw telling;
}

function asProfile(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && PROFILE_NAME.test(value)) return value;
  throw new PipelineError(`${where}: profile must name an Agent Profile, not ${String(value)}`);
}

/**
 * Every profile the Pipeline or a Stage names is one config defines.
 * Parsing cannot check this, since profiles live in config; saving a
 * Pipeline does, and Intake asks for each Stage's resolved profile instead.
 */
export function checkProfiles(pipeline: Pipeline, profiles: Record<string, ProfileConfig>): void {
  const named: Array<[string, string]> = pipeline.profile ? [[`Pipeline ${pipeline.name}`, pipeline.profile]] : [];
  for (const stage of pipeline.stages) if (stage.kind === "runner" && stage.profile) named.push([`Pipeline ${pipeline.name} Stage ${stage.name}`, stage.profile]);
  for (const [where, profile] of named) if (!profiles[profile]) throw new PipelineError(`${where}: no profile named ${profile} in config.yaml`);
}

export function isKnownArtifact(artifact: string): boolean {
  return (ARTIFACTS as readonly string[]).includes(artifact) || fileArtifact(artifact) !== null || actionArtifact(artifact) !== null;
}

/** The Action an `action <name>` artifact names, or null when the artifact is not a check Action. */
export function actionArtifact(artifact: string): string | null {
  const m = /^action\s+(\S+)$/.exec(artifact);
  return m && ACTION_NAME.test(m[1]!) ? m[1]! : null;
}

/** The worktree-relative path of a `file <path>` artifact, or null when the artifact is not one (or escapes the worktree). */
export function fileArtifact(artifact: string): string | null {
  const m = /^file\s+(\S+)$/.exec(artifact);
  if (!m) return null;
  const file = m[1]!;
  if (file.startsWith("/") || file.split("/").includes("..")) return null;
  return file;
}

