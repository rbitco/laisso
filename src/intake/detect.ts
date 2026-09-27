import type { Config } from "../server/config.ts";

export type IntakeKind = "prompt" | "jira" | "github";

export interface Detection {
  kind: IntakeKind;
  /** Normalised tracker reference: the JIRA key, or owner/repo#n. Null for a prompt. */
  reference: string | null;
  repo: { suggestion: string | null; choices: string[] };
  /** The Pipeline suggestion follows the chosen repo; `byRepo` lets a client re-pick when the repo changes. */
  pipeline: { suggestion: string; choices: string[]; byRepo: Record<string, string> };
}

const JIRA_KEY = /^([A-Z][A-Z0-9]+-\d+)$/;
const GITHUB_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/;
const GITHUB_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** Deterministic detection: a JIRA key, a GitHub issue reference, or else a prompt. */
export function detectKind(input: string): { kind: IntakeKind; reference: string | null } {
  const text = input.trim();
  const jira = JIRA_KEY.exec(text);
  if (jira) return { kind: "jira", reference: jira[1]! };
  const url = GITHUB_URL.exec(text);
  if (url) return { kind: "github", reference: `${url[1]}/${url[2]}#${url[3]}` };
  const short = GITHUB_SHORT.exec(text);
  if (short) return { kind: "github", reference: `${short[1]}/${short[2]}#${short[3]}` };
  return { kind: "prompt", reference: null };
}

/**
 * Repo suggestion. A reference suggests the repo whose tracker project it
 * belongs to. A prompt suggests the only repo when there is exactly one;
 * otherwise the picker has no preselection.
 */
export function suggestRepo(config: Config, kind: IntakeKind, reference: string | null): Detection["repo"] {
  const choices = Object.keys(config.repos);
  if (kind === "prompt") return { suggestion: choices.length === 1 ? choices[0]! : null, choices };
  const matches = choices.filter((name) => {
    const repo = config.repos[name]!;
    if (kind === "jira") return repo.tracker === "jira" && reference!.startsWith(repo.project + "-");
    return repo.tracker === "github" && reference!.startsWith(repo.project + "#");
  });
  return { suggestion: matches.length === 1 ? matches[0]! : null, choices: matches.length ? matches : choices };
}

export function detect(config: Config, input: string, pipelines: string[], repo?: string): Detection {
  const { kind, reference } = detectKind(input);
  const repoChoice = suggestRepo(config, kind, reference);
  const fallback = pipelines.includes("default") ? "default" : (pipelines[0] ?? "default");
  const byRepo: Record<string, string> = {};
  for (const name of repoChoice.choices) {
    const wanted = config.repos[name]!.pipeline;
    byRepo[name] = pipelines.includes(wanted) ? wanted : fallback;
  }
  const chosenRepo = repo ?? repoChoice.suggestion;
  return {
    kind,
    reference,
    repo: repoChoice,
    pipeline: { suggestion: (chosenRepo && byRepo[chosenRepo]) || fallback, choices: pipelines, byRepo },
  };
}
