import { randomUUID } from "node:crypto";
import type { Config } from "../server/config.ts";
import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import type { ActionStage } from "../pipeline/load.ts";
import { trackerFor } from "../tracker/tracker.ts";
import type { Progress } from "./progress.ts";

export interface ActionsDeps {
  config: Config;
  tickets: Tickets;
  sessions: Sessions;
  log: Logger;
  progress: Progress;
}

/**
 * Action Stages (ADR 0005): Lasso performs a named built-in itself, records
 * a Session row with a Lasso-minted id and mode action, and auto-advances.
 * `tracker.transition` is the whole catalogue in v1. A failed action is a
 * failed Session, so the Ticket is Flagged like any other Outcome.
 */
export class Actions {
  private deps: ActionsDeps;

  constructor(deps: ActionsDeps) {
    this.deps = deps;
  }

  /** The tick's share: run the action Stage of every Ticket at one, and the next while action Stages follow on. */
  async runDue(): Promise<TickChange[]> {
    const changes: TickChange[] = [];
    for (let ticket of this.deps.tickets.list()) {
      for (let stage = this.deps.progress.dueAction(ticket); stage; stage = this.deps.progress.dueAction(ticket)) {
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

  private async run(ticket: TicketRow, stage: ActionStage): Promise<string> {
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

  private async perform(ticket: TicketRow, stage: ActionStage): Promise<void> {
    if (!ticket.reference) throw new Error(`${stage.name}: Ticket has no tracker issue yet`);
    const repo = this.deps.config.repos[ticket.repo];
    if (!repo) throw new Error(`${stage.name}: repo ${ticket.repo} is no longer configured`);
    await trackerFor(repo.tracker, repo.project).transition(ticket.reference, stage.status);
  }
}
