import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { currentActions, type ActionConfig, type Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import { parseDuration } from "../duration.ts";
import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import { isTransition, type ActionStage, type CommandStage, type TransitionStage } from "../pipeline/load.ts";
import { trackerFor } from "../tracker/tracker.ts";
import type { Progress } from "./progress.ts";

export interface ActionsDeps {
  config: Config;
  home: LassoHome;
  tickets: Tickets;
  sessions: Sessions;
  log: Logger;
  progress: Progress;
  /** Hears each chunk of a command's output once it is on disk, as Runs' stdoutWritten does. */
  stdoutWritten?: (ticket: string, session: string) => void;
  /** Hears a command Action end, so the tick can carry the Ticket on without waiting for the timer. */
  ended?: () => void;
}

/** A command Action running now: its process, and how it is to be recorded when it closes. */
interface Live {
  kill: (reason: "timeout" | "shutdown") => void;
  done: Promise<void>;
}

const KILL_GRACE_MS = 5000;
/** How much of a command's latest output is kept in memory to find its last line. */
const TAIL_BYTES = 4096;

/**
 * Action Stages: Lasso performs them itself, records a Session row with a
 * Lasso-minted id and mode action, and auto-advances. The built-in
 * `tracker.transition` (ADR 0005) runs inside the tick; an Action config
 * defines (ADR 0010) runs as a shell command in the background, judged by
 * its exit code. A failed action is a failed Session, so the Ticket is
 * Flagged like any other Outcome.
 */
export class Actions {
  private deps: ActionsDeps;
  private live = new Map<string, Live>();

  constructor(deps: ActionsDeps) {
    this.deps = deps;
  }

  /** The tick's share: run the action Stage of every Ticket at one, and the next while action Stages follow on. */
  async runDue(): Promise<TickChange[]> {
    const changes: TickChange[] = [];
    for (let ticket of this.deps.tickets.list()) {
      for (let stage = this.deps.progress.dueAction(ticket); stage; stage = this.deps.progress.dueAction(ticket)) {
        if (!isTransition(stage)) {
          // A command runs in the background and is judged when it closes; its Ticket waits until then.
          changes.push({ ticket: ticket.id, summary: this.start(ticket, stage) });
          break;
        }
        changes.push({ ticket: ticket.id, summary: await this.run(ticket, stage) });
        ticket = this.deps.tickets.get(ticket.id)!;
      }
    }
    return changes;
  }

  /** At startup an action Session left running by a crash is closed as interrupted; the next tick performs the Stage again. */
  reconcile(): void {
    for (const row of this.deps.sessions.running()) {
      if (row.mode !== "action") continue;
      this.deps.sessions.end(row.id, { ended_by: "outcome", ended_reason: "shutdown", outcome: "interrupted", final_message: null, usage: null, cost_usd: null, transcript_path: null });
      this.deps.log.info("session.reconciled", { session: row.id, ticket: row.ticket });
    }
  }

  /** Ctrl-C: every running command is killed and its Session ends interrupted, reason shutdown; the next start performs the Stage again. */
  async shutdown(): Promise<void> {
    const live = [...this.live.values()];
    for (const run of live) run.kill("shutdown");
    await Promise.all(live.map((run) => run.done));
  }

  private async run(ticket: TicketRow, stage: TransitionStage): Promise<string> {
    const { sessions, tickets, log, progress } = this.deps;
    const row = sessions.insert({
      id: randomUUID(),
      ticket: ticket.id,
      stage: stage.name,
      stage_snapshot: JSON.stringify(stage),
      mode: "action",
      started_by: "auto",
      stdout_path: null,
      limits_honoured: "[]",
    });
    log.info("session.started", { session: row.id, ticket: ticket.id, stage: stage.name, mode: "action", action: stage.action, status: stage.status });
    let failure: string | null = null;
    try {
      await this.perform(ticket, stage);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const ended = sessions.end(row.id, {
      ended_by: "outcome",
      ended_reason: null,
      outcome: failure ? "failed" : "succeeded",
      final_message: failure ?? `${stage.action} ${stage.status}`,
      usage: null,
      cost_usd: null,
      transcript_path: null,
    });
    log.info("session.ended", { session: ended.id, ticket: ticket.id, stage: stage.name, mode: "action", outcome: ended.outcome, message: ended.final_message });
    const fresh = tickets.get(ticket.id)!;
    if (failure) {
      await progress.flag(fresh.id, "outcome.failed", failure);
      return `Flagged: ${failure}`;
    }
    await progress.finished(fresh);
    return `${stage.name}: ${stage.action} ${stage.status}`;
  }

  /**
   * Start a command Action: its Session row is written and its process
   * spawned now, and it is judged when the process closes. The running
   * Session keeps the tick off the Ticket meanwhile.
   */
  private start(ticket: TicketRow, stage: CommandStage): string {
    const { sessions, home, log } = this.deps;
    const id = randomUUID();
    const dir = path.join(home.ticketsDir, ticket.id, "sessions");
    mkdirSync(dir, { recursive: true });
    const stdoutPath = path.join(dir, `${id}.stdout`);
    const row = sessions.insert({ id, ticket: ticket.id, stage: stage.name, stage_snapshot: JSON.stringify(stage), mode: "action", started_by: "auto", stdout_path: stdoutPath, limits_honoured: "[]" });
    const fd = openSync(stdoutPath, "a");
    let tail = "";
    const write = (chunk: Buffer) => {
      writeSync(fd, chunk);
      tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
      this.deps.stdoutWritten?.(ticket.id, id);
    };
    const action = currentActions(home, this.deps.config)[stage.action];
    const unrunnable = this.unrunnable(ticket, stage, action);
    log.info("session.started", { session: row.id, ticket: ticket.id, stage: stage.name, mode: "action", action: stage.action });
    if (unrunnable || !action) {
      closeSync(fd);
      const done = this.settle(ticket, stage, row.id, { failure: unrunnable ?? `no Action named ${stage.action} in config.yaml`, tail: "" });
      this.live.set(row.id, { kill: () => undefined, done });
      return `started ${stage.name}`;
    }
    const timeoutMs = parseDuration(action.timeout);
    const child = spawn(process.env.SHELL || "/bin/sh", ["-c", action.run], { cwd: ticket.worktree, env: { ...process.env, ...this.env(ticket, stage, row.id) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let killed: "timeout" | "shutdown" | null = null;
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
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    child.stdout!.on("data", write);
    child.stderr!.on("data", write);
    let spawnError: string | null = null;
    child.on("error", (error) => (spawnError = error.message));
    const done = new Promise<void>((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timer);
        closeSync(fd);
        const failure =
          killed === "shutdown" ? null
          : killed === "timeout" ? `${stage.action} timed out after ${action.timeout}`
          : spawnError ? `${stage.action} could not start: ${spawnError}`
          : code !== 0 ? `${stage.action} exited ${code ?? "on a signal"}${lastLine(tail) ? `: ${lastLine(tail)}` : ""}`
          : null;
        resolve(this.settle(ticket, stage, row.id, { failure, tail, shutdown: killed === "shutdown" }));
      });
    });
    this.live.set(row.id, { kill, done });
    return `started ${stage.name}`;
  }

  /** Why the command cannot run for this Ticket at all, or null. */
  private unrunnable(ticket: TicketRow, stage: CommandStage, action: ActionConfig | undefined): string | null {
    if (!action) return `no Action named ${stage.action} in config.yaml`;
    const missing = action.params.filter((p) => !(p in stage.with));
    if (missing.length) return `${stage.action} needs ${missing.map((p) => `with.${p}`).join(", ")}`;
    if (!existsSync(ticket.worktree)) return `the worktree ${ticket.worktree} is missing`;
    return null;
  }

  /** Record how a command Action ended, then Flag or advance its Ticket; a shutdown leaves the Ticket for the next start. */
  private async settle(ticket: TicketRow, stage: CommandStage, sessionId: string, how: { failure: string | null; tail: string; shutdown?: boolean }): Promise<void> {
    const { sessions, tickets, log, progress } = this.deps;
    try {
      const ended = sessions.end(sessionId, {
        ended_by: "outcome",
        ended_reason: how.shutdown ? "shutdown" : null,
        outcome: how.shutdown ? "interrupted" : how.failure ? "failed" : "succeeded",
        final_message: how.shutdown ? null : (how.failure ?? (lastLine(how.tail) || `${stage.action} succeeded`)),
        usage: null,
        cost_usd: null,
        transcript_path: null,
      });
      log.info("session.ended", { session: ended.id, ticket: ticket.id, stage: stage.name, mode: "action", outcome: ended.outcome, message: ended.final_message });
      if (how.shutdown) return;
      const fresh = tickets.get(ticket.id)!;
      if (how.failure) await progress.flag(fresh.id, "outcome.failed", how.failure);
      else await progress.finished(fresh);
    } finally {
      this.live.delete(sessionId);
      if (!how.shutdown) this.deps.ended?.();
    }
  }

  /** What the command is told (ADR 0010): the Ticket's details, as a Runner Session gets them and more, and one LASSO_<PARAM> per param. */
  private env(ticket: TicketRow, stage: CommandStage, sessionId: string): Record<string, string> {
    const repo = this.deps.config.repos[ticket.repo];
    return {
      LASSO_TICKET: ticket.id,
      LASSO_REFERENCE: ticket.reference ?? "",
      LASSO_REPO: ticket.repo,
      LASSO_BRANCH: ticket.branch,
      LASSO_STAGE: stage.name,
      LASSO_SESSION: sessionId,
      LASSO_TITLE: ticket.title,
      LASSO_TRACKER: repo?.tracker ?? "",
      LASSO_PROJECT: repo?.project ?? "",
      LASSO_PR: ticket.pr ?? "",
      LASSO_WORKTREE: ticket.worktree,
      LASSO_PIPELINE: ticket.pipeline,
      ...Object.fromEntries(Object.entries(stage.with).map(([key, value]) => [`LASSO_${key.toUpperCase()}`, value])),
    };
  }

  private async perform(ticket: TicketRow, stage: TransitionStage): Promise<void> {
    if (!ticket.reference) throw new Error(`${stage.name}: Ticket has no tracker issue yet`);
    const repo = this.deps.config.repos[ticket.repo];
    if (!repo) throw new Error(`${stage.name}: repo ${ticket.repo} is no longer configured`);
    await trackerFor(repo.tracker, repo.project).transition(ticket.reference, stage.status);
  }
}

/** The last non-blank line of a command's output, trimmed. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
