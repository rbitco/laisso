import { spawn } from "node:child_process";
import { parseDuration } from "../duration.ts";
import type { ActionConfig, Config } from "../server/config.ts";
import type { TicketRow } from "../store/tickets.ts";

const KILL_GRACE_MS = 5000;
/** How much of a command's latest output is kept in memory to find its last line. */
const TAIL_BYTES = 4096;

/** How a command ended: its exit code, or why it has none, and the tail of what it wrote. */
export interface CommandEnd {
  code: number | null;
  /** Lasso killed it: past its timeout, or Lasso shutting down. */
  killed: "timeout" | "shutdown" | null;
  /** It never started (no shell, no worktree). */
  spawnError: string | null;
  /** The last few KB of stdout and stderr together. */
  tail: string;
}

export interface RunningCommand {
  kill: (reason: "timeout" | "shutdown") => void;
  done: Promise<CommandEnd>;
}

/**
 * Run an Action's command (ADR 0010) in a shell, in `cwd`, with `env` added
 * to Lasso's own. It is killed, process group and all, past the Action's
 * timeout. Every chunk of output goes to `onOutput` as it arrives.
 */
export function runCommand(action: ActionConfig, cwd: string, env: Record<string, string>, onOutput?: (chunk: Buffer) => void): RunningCommand {
  const child = spawn(process.env.SHELL || "/bin/sh", ["-c", action.run], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let killed: "timeout" | "shutdown" | null = null;
  let tail = "";
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  };
  const kill = (reason: "timeout" | "shutdown") => {
    if (killed) return;
    killed = reason;
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
  };
  const timer = setTimeout(() => kill("timeout"), parseDuration(action.timeout));
  const write = (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
    onOutput?.(chunk);
  };
  child.stdout!.on("data", write);
  child.stderr!.on("data", write);
  let spawnError: string | null = null;
  child.on("error", (error) => (spawnError = error.message));
  const done = new Promise<CommandEnd>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, killed, spawnError, tail });
    });
  });
  return { kill, done };
}

/** What an Action's command is told (ADR 0010): the Ticket's details, as a Runner Session gets them and more, and one LASSO_<PARAM> per param. */
export function actionEnv(config: Config, ticket: TicketRow, stage: string, sessionId: string, params: Record<string, string>): Record<string, string> {
  const repo = config.repos[ticket.repo];
  return {
    LASSO_TICKET: ticket.id,
    LASSO_REFERENCE: ticket.reference ?? "",
    LASSO_REPO: ticket.repo,
    LASSO_BRANCH: ticket.branch,
    LASSO_STAGE: stage,
    LASSO_SESSION: sessionId,
    LASSO_TITLE: ticket.title,
    LASSO_TRACKER: repo?.tracker ?? "",
    LASSO_PROJECT: repo?.project ?? "",
    LASSO_PR: ticket.pr ?? "",
    LASSO_WORKTREE: ticket.worktree,
    LASSO_PIPELINE: ticket.pipeline,
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [`LASSO_${key.toUpperCase()}`, value])),
  };
}

/** The params an Action needs that `given` lacks. */
export function missingParams(action: ActionConfig, given: Record<string, string>): string[] {
  return action.params.filter((p) => !(p in given));
}

/** The last non-blank line of a command's output, trimmed. */
export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
