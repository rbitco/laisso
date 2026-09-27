import type { Logger } from "../server/log.ts";
import type { Tick } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import type { Pipeline, Stage } from "../pipeline/load.ts";
import type { Budgets } from "../budget/budgets.ts";
import { adapterFor } from "../runner/adapters.ts";
import { parseDuration, DurationError } from "../duration.ts";
import { TriggerError, type Progress } from "./progress.ts";
import type { Runs } from "./runs.ts";
import type { Terminal } from "./terminal.ts";
import type { Teardown } from "./teardown.ts";

export interface ExitsDeps {
  tickets: Tickets;
  sessions: Sessions;
  log: Logger;
  progress: Progress;
  runs: Runs;
  terminal: Terminal;
  budgets: Budgets;
  tick: Tick;
  teardown: Teardown;
}

/** What Extend may set on the Ticket layer; a null clears that dimension back to the Pipeline and global default. */
export interface ExtendRequest {
  rounds?: number | null;
  attempts?: number | null;
  wallTime?: string | null;
  spend?: number | null;
}

/**
 * The ways out of a Flag that Progress does not already own (spec: Budget
 * and Flagging): Retry, Resume, Extend and Abandon. Mark done and Skip are
 * Progress's, and accept a Flagged Ticket too. Retry and Resume count
 * against attempts and are refused at the limit until extended.
 */
export class Exits {
  private deps: ExitsDeps;

  constructor(deps: ExitsDeps) {
    this.deps = deps;
  }

  /** Retry: a fresh Session of the Stage the Ticket stopped at. */
  async retry(ticket: TicketRow): Promise<TicketRow> {
    const { progress, terminal, tick, runs } = this.deps;
    const { pipeline, stage } = progress.flaggedStage(ticket);
    if (stage.kind === "runner") this.affordable(ticket, pipeline, stage);
    return this.cleared(ticket, "retry", async (cleared) => {
      if (stage.kind === "action") await tick.run("start");
      else if (stage.human) {
        progress.endHumanSessions(cleared);
        await terminal.open(cleared, stage);
      } else await runs.launch(cleared, pipeline, stage, "human");
    });
  }

  /** Resume: re-enter the Session the Stage stopped in, where the Runner allows. */
  async resume(ticket: TicketRow): Promise<TicketRow> {
    const { progress, terminal, sessions, runs } = this.deps;
    const { pipeline, stage } = progress.flaggedStage(ticket);
    if (stage.kind === "action") throw new TriggerError(`${stage.name} is an action Stage; Retry performs it again`);
    if (stage.human) {
      const held = sessions.running(ticket.id).find((s) => s.mode === "terminal" && s.stage === stage.name && s.opened_at !== null);
      if (!held) throw new TriggerError(`no terminal Session of ${stage.name} to resume; Retry opens a fresh one`);
      this.affordable(ticket, pipeline, stage);
      return this.cleared(ticket, "resume", (cleared) => terminal.open(cleared, stage));
    }
    const last = sessions.forTicket(ticket.id).find((s) => s.mode === "headless" && s.stage === stage.name) ?? null;
    if (!last) throw new TriggerError(`no Session of ${stage.name} to resume; Retry starts a fresh one`);
    const adapter = adapterFor(stage.runner);
    if (adapter.sessionIds === "runner" && !last.runner_session_id) throw new TriggerError(`${adapter.name} left no session id to resume on ${stage.name}; Retry starts afresh`);
    this.affordable(ticket, pipeline, stage);
    return this.cleared(ticket, "resume", (cleared) => runs.launch(cleared, pipeline, stage, "human", last));
  }

  /** Extend: set the Ticket layer of the Budget. A Flag for a budget.* reason clears once the next Session is affordable again. */
  async extend(ticket: TicketRow, request: ExtendRequest): Promise<TicketRow> {
    const { tickets, progress, budgets, log, tick } = this.deps;
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is ${ticket.state}`);
    if (typeof request !== "object" || request === null) throw new TriggerError("nothing to extend: pass rounds, attempts, wallTime or spend");
    const patch: Partial<TicketRow> = {};
    if ("rounds" in request) patch.budget_rounds = count(request.rounds, "rounds");
    if ("attempts" in request) patch.budget_attempts = count(request.attempts, "attempts");
    if ("wallTime" in request) patch.budget_wall_time = duration(request.wallTime);
    if ("spend" in request) patch.budget_spend = money(request.spend);
    if (Object.keys(patch).length === 0) throw new TriggerError("nothing to extend: pass rounds, attempts, wallTime or spend");
    let updated = tickets.update(ticket.id, patch);
    log.info("ticket.extended", { ticket: ticket.id, ...patch });
    if (updated.flagged_at && updated.flag_reason?.startsWith("budget.")) {
      const current = progress.current(updated);
      if (!("problem" in current) && !budgets.refusal(updated, current.pipeline, current.stage)) {
        updated = await this.cleared(updated, "extend", () => tick.run("start").then(() => undefined));
      }
    }
    return updated;
  }

  /** Abandon: the state change, then every running Session of the Ticket is killed with that reason, then the worktree is torn down (ADR 0007). */
  async abandon(ticket: TicketRow): Promise<TicketRow> {
    const abandoned = await this.deps.progress.abandon(ticket);
    await this.deps.runs.killFor(ticket.id, "abandon");
    await this.deps.teardown.abandon(abandoned);
    return this.deps.tickets.get(abandoned.id)!;
  }

  private affordable(ticket: TicketRow, pipeline: Pipeline, stage: Stage): void {
    const refusal = this.deps.budgets.refusal(ticket, pipeline, stage);
    if (refusal) throw new TriggerError(`${refusal.detail}; Extend the Budget first`);
  }

  /** Clear the Flag, act while nothing else can see the Ticket idle, then tell the tracker. */
  private async cleared(ticket: TicketRow, exit: string, act: (cleared: TicketRow) => Promise<unknown>): Promise<TicketRow> {
    const { progress, tickets } = this.deps;
    const cleared = progress.unflag(ticket.id, exit);
    try {
      await act(cleared);
    } finally {
      await progress.pushMirror(ticket.id);
    }
    return tickets.get(ticket.id)!;
  }
}

function count(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new TriggerError(`${name} must be a whole number of 0 or more, or null to clear it`);
}

function money(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new TriggerError("spend must be a number of 0 or more USD, or null to clear it");
}

function duration(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string") {
    try {
      parseDuration(value);
    } catch (error) {
      throw new TriggerError(`wallTime ${error instanceof DurationError ? error.message : String(error)}`);
    }
    return value;
  }
  throw new TriggerError("wallTime must be a duration like 30m, or null to clear it");
}
