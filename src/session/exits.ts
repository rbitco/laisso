import type { Logger } from "../server/log.ts";
import type { Tick } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import { runnerOf, type Sessions, type SessionRow } from "../store/sessions.ts";
import type { Pipeline, RunnerStage, Stage } from "../pipeline/load.ts";
import type { Budgets } from "../budget/budgets.ts";
import { adapterFor } from "../runner/adapters.ts";
import { parseDuration, DurationError } from "../duration.ts";
import { TriggerError, type Progress } from "./progress.ts";
import type { Runs } from "./runs.ts";
import type { Terminal } from "./terminal.ts";
import type { Teardown } from "./teardown.ts";
import { resumeRefusal, type Overrides } from "./overrides.ts";

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
  overrides: Overrides;
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

  /**
   * Retry: a fresh Session of the Stage the Ticket stopped at. With a profile
   * ("retry with…") it first sets the Stage's override to it, so this Session
   * and every later one of the Stage run under it until cleared.
   */
  async retry(ticket: TicketRow, profile?: unknown): Promise<TicketRow> {
    const { progress, terminal, tick, runs, overrides } = this.deps;
    const { pipeline, stage } = progress.flaggedStage(ticket);
    if (stage.kind === "runner") this.affordable(ticket, pipeline, stage);
    if (profile !== undefined && profile !== null) ticket = overrides.set(ticket, stage.name, profile);
    return this.cleared(ticket, "retry", async (cleared) => {
      if (stage.kind === "action") await tick.run("start");
      else if (stage.human) {
        progress.endHumanSessions(cleared);
        await terminal.open(cleared, pipeline, stage);
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
      this.resumable(ticket, pipeline, stage, held);
      this.affordable(ticket, pipeline, stage);
      return this.cleared(ticket, "resume", (cleared) => terminal.open(cleared, pipeline, stage));
    }
    const last = sessions.forTicket(ticket.id).find((s) => s.mode === "headless" && s.stage === stage.name) ?? null;
    if (!last) throw new TriggerError(`no Session of ${stage.name} to resume; Retry starts a fresh one`);
    // The Runner the last Session ran on is the one that would re-enter it.
    const runner = runnerOf(last);
    const adapter = runner ? adapterFor(runner) : null;
    if (adapter?.sessionIds === "runner" && !last.runner_session_id) throw new TriggerError(`${adapter.name} left no session id to resume on ${stage.name}; Retry starts afresh`);
    this.resumable(ticket, pipeline, stage, last);
    this.affordable(ticket, pipeline, stage);
    return this.cleared(ticket, "resume", (cleared) => runs.launch(cleared, pipeline, stage, "human", last));
  }

  /**
   * Take over in terminal: a human steps into the current headless Stage's last Session, running or not, Flagged
   * or not. A running one stops first; the terminal re-enters its session, and the Stage is then worked as a human
   * Stage, finished by Mark done or Skip. Taken over already, the window opens again on the same Session.
   */
  async takeOver(ticket: TicketRow): Promise<TicketRow> {
    const { progress, sessions, terminal, runs, tickets } = this.deps;
    if (ticket.holding_since && !ticket.flagged_at) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is holding; Start ${ticket.stage} or open the draft`);
    const { pipeline, stage } = ticket.flagged_at ? progress.flaggedStage(ticket) : progress.currentForTrigger(ticket);
    if (stage.kind !== "runner") throw new TriggerError(`${stage.name} is an action Stage; there is no Session to take over`);
    if (stage.human) throw new TriggerError(`${stage.name} is a human Stage; Open terminal works it`);
    let takeOver = null;
    if (!progress.takenOver(ticket, stage.name)) {
      const from = sessions.forTicket(ticket.id).find((s) => s.mode === "headless" && s.stage === stage.name) ?? null;
      if (!from) throw new TriggerError(`no Session of ${stage.name} to take over yet`);
      this.resumable(ticket, pipeline, stage, from);
      // A running Runner that names its own session reports it as it ends; one that ended without it cannot be re-entered.
      const runner = runnerOf(from);
      if (from.ended_at !== null && runner && adapterFor(runner).sessionIds === "runner" && !from.runner_session_id) throw new TriggerError(`${runner} left no session id to take over on ${stage.name}; Retry starts afresh`);
      takeOver = { from, stop: () => runs.takeOver(from) };
      // A Ticket waiting for a slot gives its place up: the human is working the Stage now.
      tickets.setRunnableSince(ticket.id, null);
    }
    const open = (current: TicketRow) => terminal.open(current, pipeline, stage, takeOver);
    if (ticket.flagged_at) return this.cleared(ticket, "takeover", open);
    await open(ticket);
    return tickets.get(ticket.id)!;
  }

  /**
   * Hand back: the human's terminal on a taken-over Stage ends, and Lasso runs the Stage headless again. A repeating
   * Stage goes back to Rounds: a tick polls the PR and starts one for any Feedback due, else the Stage waits for the
   * PR. Any other Stage starts a Session at once that re-enters the terminal's session where the Runner allows, so
   * the Runner picks up from what the human did; past the Budget, that start Flags instead. The terminal Session
   * spends no attempt.
   */
  async handBack(ticket: TicketRow): Promise<TicketRow> {
    const { progress, sessions, runs, tick, tickets, log } = this.deps;
    const { pipeline, stage } = progress.currentForTrigger(ticket);
    if (stage.kind !== "runner" || stage.human || !progress.takenOver(ticket, stage.name)) throw new TriggerError(`${stage.name} is not taken over in a terminal; there is nothing to hand back`);
    const held = sessions.running(ticket.id).find((s) => s.mode === "terminal" && s.stage === stage.name)!;
    sessions.end(held.id, { ended_by: "human", ended_reason: "stop", outcome: null, final_message: "handed back to Lasso", usage: null, cost_usd: null, transcript_path: held.transcript_path });
    log.info("session.handed_back", { session: held.id, ticket: ticket.id, stage: stage.name });
    if (stage.repeat) await tick.run("start");
    else await runs.launch(ticket, pipeline, stage, "human", this.reenterable(ticket, pipeline, stage, held));
    await progress.pushMirror(ticket.id);
    return tickets.get(ticket.id)!;
  }

  /** The terminal Session a headless one can re-enter: one the Runner was launched on, under the same Runner, with an id it knows. */
  private reenterable(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage, held: SessionRow): SessionRow | null {
    const runner = runnerOf(held);
    if (!runner || (held.opened_at === null && held.runner_session_id === null)) return null;
    if (adapterFor(runner).sessionIds === "runner" && !held.runner_session_id) return null;
    return resumeRefusal(stage.name, held, this.deps.overrides.resolve(ticket, pipeline, stage)) ? null : held;
  }

  /**
   * Open the draft: while a Ticket holds for Start, a terminal on the Stage that just finished, to read or steer
   * what it made before approving it. Start, not this, releases the next Stage.
   */
  async openDraft(ticket: TicketRow): Promise<TicketRow> {
    const { progress, sessions, terminal, tickets } = this.deps;
    const { pipeline, index } = progress.currentForTrigger(ticket);
    if (!ticket.holding_since) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is not holding for Start`);
    const finished = pipeline.stages[index - 1];
    if (!finished || finished.kind !== "runner") throw new TriggerError(`nothing before ${ticket.stage} has a Session to open`);
    const from = sessions.forTicket(ticket.id).find((s) => s.mode === "headless" && s.stage === finished.name) ?? null;
    if (!from) throw new TriggerError(`${finished.name} has no headless Session to open`);
    this.resumable(ticket, pipeline, finished, from);
    await terminal.openDraft(ticket, pipeline, finished, from);
    return tickets.get(ticket.id)!;
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

  /**
   * Abandon: the state change, then every running Session of the Ticket is killed with that reason, then the worktree is
   * torn down (ADR 0007). `close` is the list of PR URLs to close, as the human ticked them; absent, every open Owned PR is.
   */
  async abandon(ticket: TicketRow, close?: unknown): Promise<TicketRow> {
    if (close !== undefined && close !== null && !(Array.isArray(close) && close.every((u) => typeof u === "string"))) {
      throw new TriggerError("close must be a list of PR URLs");
    }
    const abandoned = await this.deps.progress.abandon(ticket);
    await this.deps.runs.killFor(ticket.id, "abandon");
    await this.deps.teardown.abandon(abandoned, (close as string[] | null | undefined) ?? undefined);
    return this.deps.tickets.get(abandoned.id)!;
  }

  /** Resume re-enters a Session on its own Runner; a profile now on another one (override or config edit) needs a Retry. */
  private resumable(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage, last: SessionRow): void {
    const refusal = resumeRefusal(stage.name, last, this.deps.overrides.resolve(ticket, pipeline, stage));
    if (refusal) throw new TriggerError(refusal);
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
