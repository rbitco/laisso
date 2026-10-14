import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { actionsFor, currentConfig, type ActionConfig, type Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import { actionEnv, lastLine, missingParams, runCommand } from "./command.ts";
import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import type { ActionStage } from "../pipeline/load.ts";
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

/**
 * Action Stages: Lasso performs them itself, records a Session row with a
 * Lasso-minted id and mode action, and auto-advances. The Action config
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

  /** The tick's share: start the action Stage of every Ticket at one. A command runs in the background and is judged when it closes; its end kicks the tick for any Stage after. */
  async runDue(): Promise<TickChange[]> {
    const changes: TickChange[] = [];
    for (const ticket of this.deps.tickets.list()) {
      const stage = this.deps.progress.dueAction(ticket);
      if (stage) changes.push({ ticket: ticket.id, summary: this.start(ticket, stage) });
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

  /**
   * Start a command Action: its Session row is written and its process
   * spawned now, and it is judged when the process closes. The running
   * Session keeps the tick off the Ticket meanwhile.
   */
  private start(ticket: TicketRow, stage: ActionStage): string {
    const { sessions, home, log } = this.deps;
    const id = randomUUID();
    const dir = path.join(home.ticketsDir, ticket.id, "sessions");
    mkdirSync(dir, { recursive: true });
    const stdoutPath = path.join(dir, `${id}.stdout`);
    const row = sessions.insert({ id, ticket: ticket.id, stage: stage.name, stage_snapshot: JSON.stringify(stage), mode: "action", started_by: "auto", stdout_path: stdoutPath, limits_honoured: "[]" });
    const fd = openSync(stdoutPath, "a");
    const action = actionsFor(currentConfig(home, this.deps.config), ticket.repo)[stage.action];
    const unrunnable = this.unrunnable(ticket, stage, action);
    log.info("session.started", { session: row.id, ticket: ticket.id, stage: stage.name, mode: "action", action: stage.action });
    if (unrunnable || !action) {
      closeSync(fd);
      const done = this.settle(ticket, stage, row.id, { failure: unrunnable ?? `no Action named ${stage.action} in config.yaml`, tail: "" });
      this.live.set(row.id, { kill: () => undefined, done });
      return `started ${stage.name}`;
    }
    const command = runCommand(action, ticket.worktree, actionEnv(this.deps.config, ticket, stage.name, row.id, stage.with), (chunk) => {
      writeSync(fd, chunk);
      this.deps.stdoutWritten?.(ticket.id, id);
    });
    const done = command.done.then(({ code, killed, spawnError, tail }) => {
      closeSync(fd);
      const failure =
        killed === "shutdown" ? null
        : killed === "timeout" ? `${stage.action} timed out after ${action.timeout}`
        : spawnError ? `${stage.action} could not start: ${spawnError}`
        : code !== 0 ? `${stage.action} exited ${code ?? "on a signal"}${lastLine(tail) ? `: ${lastLine(tail)}` : ""}`
        : null;
      return this.settle(ticket, stage, row.id, { failure, tail, shutdown: killed === "shutdown" });
    });
    this.live.set(row.id, { kill: command.kill, done });
    return `started ${stage.name}`;
  }

  /** Why the command cannot run for this Ticket at all, or null. */
  private unrunnable(ticket: TicketRow, stage: ActionStage, action: ActionConfig | undefined): string | null {
    if (!action) return `no Action named ${stage.action} in config.yaml`;
    const missing = missingParams(action, stage.with);
    if (missing.length) return `${stage.action} needs ${missing.map((p) => `with.${p}`).join(", ")}`;
    if (!existsSync(ticket.worktree)) return `the worktree ${ticket.worktree} is missing`;
    return null;
  }

  /** Record how a command Action ended, then Flag or advance its Ticket; a shutdown leaves the Ticket for the next start. */
  private async settle(ticket: TicketRow, stage: ActionStage, sessionId: string, how: { failure: string | null; tail: string; shutdown?: boolean }): Promise<void> {
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
}
