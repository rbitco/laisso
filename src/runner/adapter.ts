import type { RunnerName } from "../pipeline/load.ts";
import type { Effort, ProfileSettings } from "../server/config.ts";
import { renderFeedback, type FeedbackItem } from "../review/feedback.ts";
import type { PrLinkRow } from "../store/links.ts";

export type OutcomeStatus = "succeeded" | "failed" | "exhausted" | "interrupted";

/** What a Session gets told about its Ticket: rendered into the prompt preamble and LASSO_* variables. */
export interface TicketContext {
  id: string;
  reference: string | null;
  repo: string;
  branch: string;
  title: string;
  body: string | null;
  /** The Ticket's linked PRs as Lasso last saw them, in link order; prompt only, never an env variable. */
  prs: TicketPr[];
}

/** One linked PR as a Session is told of it; what no read of the PR has seen yet is null. */
export type TicketPr = Pick<PrLinkRow, "url" | "role" | "title" | "head" | "base">;

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
  /** Lasso's id for the Session: chosen up front, and what LASSO_SESSION always names. */
  sessionId: string;
  /** The session id is held from an earlier launch: re-enter it rather than start it. */
  resume?: boolean;
  /** On resume, the session to re-enter when it is not `sessionId`: an earlier Session's id, or the id the Runner gave it (Codex). */
  runnerSessionId?: string;
  /** A human-readable label for terminal Sessions; never an identity. */
  name?: string;
  limits: RunLimits;
  /** The Agent Profile the Session runs under, resolved from config as it starts (ADR 0011). */
  profile: ProfileSettings;
  /** A Round of a repeating Stage: the Feedback snapshot it addresses and the marker its comments carry. */
  feedback?: RoundContext;
}

export interface RoundContext {
  round: number;
  pr: { number: number; url: string };
  items: FeedbackItem[];
  marker: string;
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
  /** The Runner's own transcript, or the directory it will land in: a pointer for humans, never read by Lasso (ADR 0003). */
  transcriptPath: string | null;
}

export type Limit = keyof RunLimits;

/** A pure translator between Lasso and one Runner CLI (ADR 0003): no filesystem, no processes. */
export interface RunnerAdapter {
  name: RunnerName;
  /** The limits this Runner stops at by itself when asked; the rest Lasso enforces. */
  honours: Limit[];
  /** Whether the Runner takes the session id Lasso chose, or assigns its own for `findSession` to recover. */
  sessionIds: "lasso" | "runner";
  command(request: RunRequest): Command;
  parse(stdout: string, request: Pick<RunRequest, "cwd" | "sessionId">): Outcome;
  /** The agent's own words in one complete line of headless stdout, or null when the line holds none: the Latest Message as it streams. */
  message(line: string): string | null;
  /** Where the Runner will keep its own transcript for this request; null when the Runner has none. */
  transcriptPath(request: Pick<RunRequest, "cwd" | "sessionId">): string | null;
  /**
   * The session id a Runner assigned itself, found after launch; null for Runners that take
   * Lasso's id. The one operation that reads the Runner's own store (ADR 0003), and only its index.
   */
  findSession(query: { cwd: string; launchedAfter: Date }): string | null;
}

/** The part of a RunRequest that comes from the Ticket and the Stage; the caller adds mode, session id, and limits. */
export function requestFor(ticket: TicketLike, stage: StageLike, profile: ProfileSettings, links: TicketPr[]): Pick<RunRequest, "stage" | "prompt" | "skills" | "context" | "cwd" | "profile"> {
  const prs = links.map(({ url, role, title, head, base }) => ({ url, role, title, head, base }));
  return {
    stage: stage.name,
    prompt: stage.prompt,
    skills: stage.skills,
    context: { id: ticket.id, reference: ticket.reference, repo: ticket.repo, branch: ticket.branch, title: ticket.title, body: ticket.origin === "prompt" ? ticket.prompt : ticket.body, prs },
    cwd: ticket.worktree,
    profile,
  };
}

interface TicketLike {
  id: string;
  reference: string | null;
  repo: string;
  branch: string;
  title: string;
  origin: string;
  prompt: string | null;
  body: string | null;
  worktree: string;
}

interface StageLike {
  name: string;
  prompt: string | null;
  skills: string[];
}

/** The Ticket context and Stage prompt every Runner sees, with skills in the Runner's own invocation form. */
export function renderPrompt(request: RunRequest, skill: (name: string) => string): string {
  const { context } = request;
  const who = context.reference ? `${context.id} (${context.reference})` : context.id;
  const preamble = [
    `You are working Lasso Ticket ${who} in repo ${context.repo} on branch ${context.branch}, Stage ${request.stage}.`,
    `Title: ${context.title}`,
    ...(context.body ? ["", context.body.trim()] : []),
    "",
    ...renderPrs(context),
  ];
  // Skill invocations lead so the Runner sees them where it expects a command (spec: adapters prepend them).
  const skills = request.skills.map(skill);
  const feedback = request.feedback ? renderFeedback(request.feedback.items, request.feedback.pr, request.feedback.round, request.feedback.marker) : "";
  const body = [skills.join("\n"), preamble.join("\n"), request.prompt?.trim() ?? "", feedback].filter(Boolean);
  return body.join("\n\n");
}

/** The Ticket's linked PRs, when it has any, then the line that has the Runner link each PR it opens off the Ticket's branch. */
function renderPrs(context: TicketContext): string[] {
  const list = context.prs.map((pr) => {
    const branches = [pr.head ? `head ${pr.head}` : null, pr.base ? `base ${pr.base}` : null].filter(Boolean);
    return `- ${pr.role}: ${pr.url}${pr.title ? ` "${pr.title}"` : ""}${branches.length ? ` (${branches.join(", ")})` : ""}`;
  });
  return [
    ...(list.length ? ["Linked PRs:", ...list, ""] : []),
    `If you open a PR on a branch other than ${context.branch}, run \`lasso pr link <url>\` so Lasso tracks it as this Ticket's; for a PR you only read, add --referenced. \`lasso pr list --json\` shows the Ticket's PRs as they are now.`,
  ];
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
    ...(request.feedback ? { LASSO_ROUND: String(request.feedback.round), LASSO_MARKER: request.feedback.marker } : {}),
  };
}

/**
 * The flags a profile adds to the baseline, in this order: its model under the
 * Runner's own flag, its effort as the Runner spells it, then its extra args.
 * Permission is not here: it replaces a baseline flag, so each adapter places it.
 */
export function profileArgs(profile: ProfileSettings, modelFlag: string, effort: (level: Effort) => string[]): string[] {
  return [...(profile.model ? [modelFlag, profile.model] : []), ...(profile.effort ? effort(profile.effort) : []), ...(profile.args ?? [])];
}

/** Every well-formed JSON object on its own line of captured stdout; anything else is skipped. */
export function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r));
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
