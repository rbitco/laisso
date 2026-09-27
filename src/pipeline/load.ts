import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { hyphenate } from "../intake/slug.ts";

export const RUNNERS = ["claude", "codex", "pi"] as const;
export type RunnerName = (typeof RUNNERS)[number];

export const ARTIFACTS = ["tracker-spec", "tracker-comment", "commits-on-branch", "pr-exists", "pr-review", "pr-merged"] as const;
export const ACTIONS = ["tracker.transition"] as const;

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
  runner: RunnerName;
  human: boolean;
  advance: boolean;
  artifact: string | null;
  repeat: "feedback" | null;
  budget: StageBudget;
  runnerOptions: Record<string, unknown>;
}

export interface ActionStage {
  kind: "action";
  name: string;
  action: "tracker.transition";
  status: string;
}

export type Stage = RunnerStage | ActionStage;

export interface Pipeline {
  name: string;
  runner: RunnerName;
  budget: { spend?: number };
  stages: Stage[];
}

export class PipelineError extends Error {}

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

export function parsePipeline(name: string, text: string): Pipeline {
  const raw = parse(text);
  if (!raw || typeof raw !== "object") throw new PipelineError(`Pipeline ${name} is empty`);
  const doc = raw as Record<string, unknown>;
  const runner = asRunner(doc.runner, "claude", `Pipeline ${name}`);
  const stagesRaw = Array.isArray(doc.stages) ? doc.stages : null;
  if (!stagesRaw || stagesRaw.length === 0) throw new PipelineError(`Pipeline ${name} has no stages`);
  const stages = stagesRaw.map((entry, i) => parseStage(name, entry, i, runner));
  const names = new Set<string>();
  for (const stage of stages) {
    if (names.has(stage.name)) throw new PipelineError(`Pipeline ${name} has two Stages named ${stage.name}`);
    names.add(stage.name);
  }
  const budget = doc.budget && typeof doc.budget === "object" ? (doc.budget as Record<string, unknown>) : {};
  return { name, runner, budget: { spend: typeof budget.spend === "number" ? budget.spend : undefined }, stages };
}

function parseStage(pipeline: string, entry: unknown, index: number, defaultRunner: RunnerName): Stage {
  if (!entry || typeof entry !== "object") throw new PipelineError(`Pipeline ${pipeline} stage ${index + 1} is not a mapping`);
  const s = entry as Record<string, unknown>;
  const where = `Pipeline ${pipeline} stage ${index + 1}`;
  const isAction = typeof s.action === "string";
  const isRunner = typeof s.prompt === "string" || Array.isArray(s.skills);
  if (isAction && isRunner) throw new PipelineError(`${where} has both action and prompt/skills`);
  if (isAction) {
    if (s.action !== "tracker.transition") throw new PipelineError(`${where}: unknown action ${String(s.action)}`);
    if (typeof s.status !== "string" || !s.status.trim()) throw new PipelineError(`${where}: tracker.transition needs a status`);
    return { kind: "action", name: `transition-${hyphenate(s.status)}`, action: "tracker.transition", status: s.status.trim() };
  }
  if (!isRunner) throw new PipelineError(`${where} needs a prompt, skills, or an action`);
  if (typeof s.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(s.name)) throw new PipelineError(`${where} needs a name of lowercase letters, digits, and hyphens`);
  const artifact = s.artifact === undefined ? null : String(s.artifact);
  if (artifact !== null && !isKnownArtifact(artifact)) throw new PipelineError(`${where}: unknown artifact ${artifact}`);
  if (s.repeat !== undefined && s.repeat !== "feedback") throw new PipelineError(`${where}: repeat must be feedback`);
  const budget = s.budget && typeof s.budget === "object" ? (s.budget as Record<string, unknown>) : {};
  return {
    kind: "runner",
    name: s.name,
    prompt: typeof s.prompt === "string" ? s.prompt : null,
    skills: Array.isArray(s.skills) ? s.skills.map(String) : [],
    runner: asRunner(s.runner, defaultRunner, where),
    human: s.human === true,
    advance: s.advance !== false,
    artifact,
    repeat: s.repeat === "feedback" ? "feedback" : null,
    budget: {
      rounds: typeof budget.rounds === "number" ? budget.rounds : undefined,
      attempts: typeof budget.attempts === "number" ? budget.attempts : undefined,
      wallTime: typeof budget.wallTime === "string" ? budget.wallTime : undefined,
    },
    runnerOptions: s.runnerOptions && typeof s.runnerOptions === "object" ? (s.runnerOptions as Record<string, unknown>) : {},
  };
}

function asRunner(value: unknown, fallback: RunnerName, where: string): RunnerName {
  if (value === undefined) return fallback;
  if ((RUNNERS as readonly string[]).includes(String(value))) return value as RunnerName;
  throw new PipelineError(`${where}: unknown runner ${String(value)}`);
}

export function isKnownArtifact(artifact: string): boolean {
  return (ARTIFACTS as readonly string[]).includes(artifact) || /^file \S+/.test(artifact);
}

