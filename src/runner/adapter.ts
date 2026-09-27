import type { RunnerName } from "../pipeline/load.ts";

export type OutcomeStatus = "succeeded" | "failed" | "exhausted" | "interrupted";

/** What a Session gets told about its Ticket: rendered into the prompt preamble and LASSO_* variables. */
export interface TicketContext {
  id: string;
  reference: string | null;
  repo: string;
  branch: string;
  title: string;
  body: string | null;
}

/** Best-effort limits handed to a Runner that can stop cleanly at them; Lasso enforces wall time itself. */
export interface RunLimits {
  wallTimeMs?: number;
  remainingSpendUsd?: number;
}

export interface RunRequest {
  stage: string;
  prompt: string | null;
  skills: string[];
  context: TicketContext;
  cwd: string;
  mode: "headless" | "terminal";
  /** Lasso-chosen where the Runner allows, or a held id to resume. */
  sessionId: string;
  /** A human-readable label for terminal Sessions; never an identity. */
  name?: string;
  limits: RunLimits;
  runnerOptions: Record<string, unknown>;
}

export interface Command {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
}

export interface Outcome {
  status: OutcomeStatus;
  sessionId: string | null;
  finalMessage: string | null;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  /** The Runner's own transcript: a pointer for humans, never read by Lasso (ADR 0003). */
  transcriptPath: string | null;
}

export type Limit = keyof RunLimits;

/** A pure translator between Lasso and one Runner CLI (ADR 0003): no filesystem, no processes. */
export interface RunnerAdapter {
  name: RunnerName;
  /** The limits this Runner stops at by itself when asked; the rest Lasso enforces. */
  honours: Limit[];
  command(request: RunRequest): Command;
  parse(stdout: string, request: Pick<RunRequest, "cwd" | "sessionId">): Outcome;
  /** The session id a Runner assigned itself, found after launch; null for Runners that take Lasso's id. */
  findSession(query: { cwd: string; launchedAfter: Date }): string | null;
}

/** The Ticket context and Stage prompt every Runner sees, with skills in the Runner's own invocation form. */
export function renderPrompt(request: RunRequest, skill: (name: string) => string): string {
  const { context } = request;
  const who = context.reference ? `${context.id} (${context.reference})` : context.id;
  const preamble = [
    `You are working Lasso Ticket ${who} in repo ${context.repo} on branch ${context.branch}, Stage ${request.stage}.`,
    `Title: ${context.title}`,
    ...(context.body ? ["", context.body.trim()] : []),
  ];
  // Skill invocations lead so the Runner sees them where it expects a command (spec: adapters prepend them).
  const skills = request.skills.map(skill);
  const body = [skills.join("\n"), preamble.join("\n"), request.prompt?.trim() ?? ""].filter(Boolean);
  return body.join("\n\n");
}

export function ticketEnv(request: RunRequest): Record<string, string> {
  const { context } = request;
  return {
    LASSO_TICKET: context.id,
    LASSO_REFERENCE: context.reference ?? "",
    LASSO_REPO: context.repo,
    LASSO_BRANCH: context.branch,
    LASSO_STAGE: request.stage,
    LASSO_SESSION: request.sessionId,
  };
}

/** Extra argv a Pipeline may pass through `runnerOptions: { args: [...] }`; the one knob Lasso does not model. */
export function extraArgs(options: Record<string, unknown>): string[] {
  return Array.isArray(options.args) ? options.args.map(String) : [];
}
