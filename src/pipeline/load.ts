import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { hyphenate } from "../intake/slug.ts";
import { count, duration, isPlainObject, mapping, money, text, type Fail } from "../fields.ts";
import { ACTION_NAME, PROFILE_NAME, type ActionConfig, type ProfileConfig } from "../server/config.ts";

export const RUNNERS = ["claude", "codex", "pi"] as const;
export type RunnerName = (typeof RUNNERS)[number];

export const ARTIFACTS = ["tracker-spec", "tracker-comment", "commits-on-branch", "pr-exists", "pr-review", "pr-merged"] as const;

export interface StageBudget {
  rounds?: number;
  attempts?: number;
  wallTime?: string;
}

export interface RunnerStage {
  kind: "runner";
  name: string;
  prompt: string | null;
  skills: string[];
  /** The Agent Profile the Stage names; null inherits the Pipeline's, then config's default_profile (ADR 0011). */
  profile: string | null;
  human: boolean;
  advance: boolean;
  artifact: string | null;
  repeat: "feedback" | null;
  budget: StageBudget;
}

/** A Stage that runs an Action defined in config by name, with the params it supplies (ADR 0010). */
export interface ActionStage {
  kind: "action";
  name: string;
  action: string;
  with: Record<string, string>;
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
const RUNNER_STAGE_FIELDS = new Set(["name", "prompt", "skills", "profile", "human", "advance", "artifact", "repeat", "budget"]);
const ACTION_STAGE_FIELDS = new Set(["action", "name", "with"]);

export function parsePipeline(name: string, text: string): Pipeline {
  const raw = parse(text);
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
  if (typeof s.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(s.name)) throw new PipelineError(`${where} needs a name of lowercase letters, digits, and hyphens`);
  if (s.prompt !== undefined) text(s.prompt, `${where}: prompt`, fail);
  if (s.skills !== undefined && (!Array.isArray(s.skills) || !s.skills.every((x) => typeof x === "string"))) throw new PipelineError(`${where}: skills must be a list of skill names`);
  const artifact = s.artifact === undefined ? null : String(s.artifact);
  if (artifact !== null && !isKnownArtifact(artifact)) throw new PipelineError(`${where}: unknown artifact ${artifact}`);
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
    repeat: s.repeat === "feedback" ? "feedback" : null,
    budget: {
      rounds: budget.rounds === undefined ? undefined : count(budget.rounds, `${where}: budget.rounds`, fail),
      attempts: budget.attempts === undefined ? undefined : count(budget.attempts, `${where}: budget.attempts`, fail),
      wallTime: budget.wallTime === undefined ? undefined : duration(budget.wallTime, `${where}: budget.wallTime`, fail),
    },
  };
}

function parseActionStage(s: Record<string, unknown>, where: string): ActionStage {
  // The form before ADR 0010; startup migration rewrites it, so only a hand edit meets this.
  if (s.status !== undefined) throw new PipelineError(`${where}: status is now a param; write with: { status: ${String(s.status)} }`);
  for (const key of Object.keys(s)) if (!ACTION_STAGE_FIELDS.has(key)) throw new PipelineError(`${where}: ${key} is not a field of an action Stage`);
  const action = String(s.action);
  if (!ACTION_NAME.test(action)) throw new PipelineError(`${where}: ${action} is not an Action name`);
  if (s.name !== undefined && (typeof s.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(s.name))) throw new PipelineError(`${where} needs a name of lowercase letters, digits, and hyphens`);
  if (s.with !== undefined && !isPlainObject(s.with)) throw new PipelineError(`${where}: with must be a mapping of param to value`);
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries((s.with as Record<string, unknown> | undefined) ?? {})) {
    if (value === null || typeof value === "object") throw new PipelineError(`${where}: with.${key} must be a single value`);
    params[key] = String(value);
  }
  return { kind: "action", name: typeof s.name === "string" ? s.name : defaultActionName(action, params), action, with: params };
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
    if (stage.kind !== "action") continue;
    const where = `Pipeline ${pipeline.name} Stage ${stage.name}`;
    const action = actions[stage.action];
    if (!action) throw new PipelineError(`${where}: no Action named ${stage.action} in config.yaml`);
    const missing = action.params.filter((p) => !(p in stage.with));
    if (missing.length) throw new PipelineError(`${where}: ${stage.action} needs ${missing.map((p) => `with.${p}`).join(", ")}`);
    const unknown = Object.keys(stage.with).filter((p) => !action.params.includes(p));
    if (unknown.length) throw new PipelineError(`${where}: ${stage.action} takes no param ${unknown.join(", ")}`);
  }
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
  return (ARTIFACTS as readonly string[]).includes(artifact) || fileArtifact(artifact) !== null;
}

/** The worktree-relative path of a `file <path>` artifact, or null when the artifact is not one (or escapes the worktree). */
export function fileArtifact(artifact: string): string | null {
  const m = /^file\s+(\S+)$/.exec(artifact);
  if (!m) return null;
  const file = m[1]!;
  if (file.startsWith("/") || file.split("/").includes("..")) return null;
  return file;
}

