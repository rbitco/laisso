import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions, EndedReason } from "../store/sessions.ts";
import type { Notifier } from "../notify/notifier.ts";
import { loadPipeline, type ActionStage, type Pipeline, type RunnerStage, type Stage } from "../pipeline/load.ts";
import type { Mirror } from "../tracker/mirror.ts";
import { checkArtifact, type PrProbe } from "../artifact/check.ts";
import type { Teardown } from "./teardown.ts";

/** A Trigger that cannot pull right now, with the reason for the human. */
export class TriggerError extends Error {}

/** Mark done met a missing artifact and the human has not overridden it. */
export class ArtifactWarning extends Error {
  artifact: string;
  detail: string;
  constructor(artifact: string, detail: string) {
    super(`${artifact}: ${detail}`);
    this.artifact = artifact;
    this.detail = detail;
  }
}

export interface Current {
  pipeline: Pipeline;
  stage: Stage;
  index: number;
}

export interface ProgressDeps {
  home: LassoHome;
  tickets: Tickets;
  sessions: Sessions;
  log: Logger;
  notifier: Notifier;
  mirror: Mirror;
  /** The Ticket's PR for the pr-* artifacts; wired once the Review loop exists. */
  prProbe: (ticket: TicketRow) => PrProbe;
  teardown: Teardown;
}

/**
 * How a Ticket moves along its Pipeline (ADR 0001): a Stage finishes and the
 * next becomes current, holds for a Start trigger when the finished Stage
 * said `advance: false`, or the Ticket is done after the last. Flags freeze
 * it until an exit clears them. Every Attention event notifies once, here.
 */
export class Progress {
  private deps: ProgressDeps;

  constructor(deps: ProgressDeps) {
    this.deps = deps;
  }

  current(ticket: TicketRow): Current | { problem: string } {
    let pipeline: Pipeline;
    try {
      pipeline = loadPipeline(this.deps.home.pipelinesDir, ticket.pipeline);
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) };
    }
    const index = pipeline.stages.findIndex((s) => s.name === ticket.stage);
    if (index < 0) return { problem: `Pipeline ${ticket.pipeline} no longer has a Stage named ${ticket.stage}` };
    return { pipeline, stage: pipeline.stages[index]!, index };
  }

  /**
   * The headless Stage the tick should start for this Ticket, null when there is nothing to start, or the problem.
   * A repeating Stage runs only as a Round: one due from the poller, or the latest one again after a retryable end.
   */
  runnable(ticket: TicketRow): { pipeline: Pipeline; stage: RunnerStage } | { problem: string } | null {
    if (!this.idle(ticket)) return null;
    const current = this.current(ticket);
    if ("problem" in current) return current;
    if (current.stage.kind !== "runner" || current.stage.human) return null;
    if (current.stage.repeat && !ticket.feedback_due && !this.roundToRerun(ticket, current.stage)) return null;
    return { pipeline: current.pipeline, stage: current.stage };
  }

  /** The latest Round's Session ended interrupted (shutdown included) or exhausted on its own: the Round is run again (spec: Budget). */
  private roundToRerun(ticket: TicketRow, stage: RunnerStage): boolean {
    const last = this.deps.sessions.latestRound(ticket.id, stage.name);
    return last !== null && last.ended_by === "outcome" && (last.outcome === "interrupted" || last.outcome === "exhausted");
  }

  /** The action Stage the tick should perform for this Ticket now, or null. */
  dueAction(ticket: TicketRow): ActionStage | null {
    if (!this.idle(ticket)) return null;
    const current = this.current(ticket);
    if ("problem" in current || current.stage.kind !== "action") return null;
    return current.stage;
  }

  /** Nothing stops the tick from acting on this Ticket: active, not Flagged, not holding, no Session running. */
  private idle(ticket: TicketRow): boolean {
    return ticket.state === "active" && !ticket.flagged_at && !ticket.holding_since && this.deps.sessions.running(ticket.id).length === 0;
  }

  /** A Ticket just admitted: its first Stage is current, and the tracker learns of it before intake answers. */
  async admitted(ticket: TicketRow): Promise<void> {
    const current = this.current(ticket);
    if (!("problem" in current)) this.entered(ticket, current.stage);
    await this.deps.mirror.push(ticket.id);
  }

  /** The current Stage of an active, unflagged Ticket, or the TriggerError that says why a Trigger cannot pull. */
  currentForTrigger(ticket: TicketRow): Current {
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is ${ticket.state}`);
    if (ticket.flagged_at) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is Flagged; clear the Flag first`);
    const current = this.current(ticket);
    if ("problem" in current) throw new TriggerError(current.problem);
    return current;
  }

  /** The human Stage a human-only Trigger (Open terminal, Mark done, Skip) acts on. */
  humanStage(ticket: TicketRow): { pipeline: Pipeline; stage: RunnerStage } {
    const current = this.currentForTrigger(ticket);
    if (ticket.holding_since) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is holding; Start ${current.stage.name} first`);
    if (current.stage.kind !== "runner" || !current.stage.human) throw new TriggerError(`${current.stage.name} is not a human Stage`);
    return { pipeline: current.pipeline, stage: current.stage };
  }

  /** The Stage a Flag exit acts on: where an active, Flagged Ticket stopped. */
  flaggedStage(ticket: TicketRow): Current {
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is ${ticket.state}`);
    if (!ticket.flagged_at) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is not Flagged`);
    const current = this.current(ticket);
    if ("problem" in current) throw new TriggerError(current.problem);
    return current;
  }

  /** Mark done and Skip act on the human Stage under way, or on whatever Stage a Flagged Ticket stopped at. */
  private exitStage(ticket: TicketRow): { pipeline: Pipeline; stage: Stage } {
    return ticket.flagged_at ? this.flaggedStage(ticket) : this.humanStage(ticket);
  }

  /**
   * An exit clears the Flag; the Ticket may move again. Synchronous, so the
   * exit can start what comes next before anything else sees the Ticket
   * unflagged and idle; the tracker is told afterwards with `pushMirror`.
   */
  unflag(ticketId: string, exit: string): TicketRow {
    const ticket = this.deps.tickets.get(ticketId)!;
    if (!ticket.flagged_at) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is no longer Flagged`);
    const cleared = this.deps.tickets.update(ticketId, unflagPatch(ticket, new Date().toISOString()));
    this.deps.log.info("ticket.unflagged", { ticket: ticketId, exit, reason: ticket.flag_reason });
    return cleared;
  }

  async pushMirror(ticketId: string): Promise<void> {
    await this.deps.mirror.push(ticketId);
  }

  /** A Stage just became current (at intake, or by advancing): a human Stage is an Attention event. */
  entered(ticket: TicketRow, stage: Stage): void {
    if (stage.kind === "runner" && stage.human) this.deps.notifier.post("human", ticket, `${stage.name} needs you`);
  }

  /**
   * The current Stage finished: move on, hold for Start, or finish the Ticket. The mirror push is
   * awaited so a Trigger answers, and a tick reports, only once the tracker has been told; that
   * puts one or two tracker CLI calls on the path of Mark done, Skip, Stop and shutdown.
   */
  async finished(ticket: TicketRow): Promise<void> {
    const current = this.current(ticket);
    if ("problem" in current) return this.flag(ticket.id, "pipeline.missing", current.problem);
    const next = current.pipeline.stages[current.index + 1];
    const now = new Date().toISOString();
    if (!next) {
      // The row goes done before the worktree goes, so no tick can start a Session in a directory
      // being removed; a crash in between leaves a done Ticket the retention sweep tidies (ADR 0007).
      const done = this.deps.tickets.update(ticket.id, { state: "done", ended_at: now, holding_since: null, runnable_since: null, ...unflagPatch(ticket, now) });
      this.deps.log.info("ticket.done", { ticket: ticket.id });
      await this.deps.teardown.done(done);
      await this.deps.mirror.push(done.id);
      return;
    }
    const holds = current.stage.kind === "runner" && !current.stage.advance;
    const updated = this.deps.tickets.update(ticket.id, { stage: next.name, holding_since: holds ? now : null, ...unflagPatch(ticket, now) });
    this.deps.log.info("ticket.advanced", { ticket: ticket.id, stage: next.name, holding: holds });
    if (holds) this.deps.notifier.post("gate", updated, `${current.stage.name} finished; Start ${next.name} when ready`);
    else this.entered(updated, next);
    await this.deps.mirror.push(updated.id);
  }

  /** The Start trigger: release a holding Ticket into its current Stage. */
  start(ticket: TicketRow): TicketRow {
    const current = this.currentForTrigger(ticket);
    if (!ticket.holding_since) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is not holding; ${current.stage.name} is already under way`);
    const released = this.deps.tickets.update(ticket.id, { holding_since: null });
    this.deps.log.info("ticket.started", { ticket: ticket.id, stage: current.stage.name });
    this.entered(released, current.stage);
    return released;
  }

  /** Mark <Stage> done: the artifact is checked with warn-and-override, then the Stage finishes (a human Stage, or a Flagged one: accept and advance). */
  async markDone(ticket: TicketRow, override: boolean): Promise<TicketRow> {
    const { stage } = this.exitStage(ticket);
    if (!override && stage.kind === "runner" && stage.artifact) {
      const verdict = await checkArtifact(stage.artifact, ticket.worktree, this.deps.prProbe(ticket));
      if (!verdict.present) throw new ArtifactWarning(stage.artifact, verdict.detail ?? "missing");
    }
    // The check awaited; the Ticket is re-read so a Trigger that landed meanwhile is not applied twice.
    const fresh = this.deps.tickets.get(ticket.id)!;
    if (fresh.stage !== stage.name) throw new TriggerError(`${stage.name} already finished`);
    this.endHumanSessions(fresh);
    this.deps.log.info("ticket.marked_done", { ticket: ticket.id, stage: stage.name, override, flagged: fresh.flagged_at !== null });
    await this.finished(fresh);
    return this.deps.tickets.get(ticket.id)!;
  }

  /** Skip: the Stage finishes without its artifact (a human Stage, or a Flagged one: drop and advance). */
  async skip(ticket: TicketRow): Promise<TicketRow> {
    const { stage } = this.exitStage(ticket);
    this.endHumanSessions(ticket);
    this.deps.log.info("ticket.skipped", { ticket: ticket.id, stage: stage.name, flagged: ticket.flagged_at !== null });
    await this.finished(ticket);
    return this.deps.tickets.get(ticket.id)!;
  }

  /** Abandon: the Ticket leaves Lasso's attention for good (CONTEXT.md: Abandoned). Exits kills its Sessions and tears the worktree down after this. */
  async abandon(ticket: TicketRow): Promise<TicketRow> {
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is already ${ticket.state}`);
    const now = new Date().toISOString();
    const abandoned = this.deps.tickets.update(ticket.id, { state: "abandoned", ended_at: now, holding_since: null, runnable_since: null, ...unflagPatch(ticket, now) });
    this.endHumanSessions(abandoned, "abandon");
    this.deps.log.info("ticket.abandoned", { ticket: ticket.id, stage: ticket.stage, flagged: ticket.flagged_at !== null });
    await this.deps.mirror.push(abandoned.id);
    return abandoned;
  }

  async flag(ticketId: string, reason: string, detail: string | null): Promise<void> {
    const flagged = this.deps.tickets.update(ticketId, { flagged_at: new Date().toISOString(), flag_reason: reason, flag_detail: detail, runnable_since: null });
    this.deps.log.info("ticket.flagged", { ticket: ticketId, reason, detail });
    this.deps.notifier.post("flagged", flagged, detail ? `${reason}: ${detail}` : reason);
    await this.deps.mirror.push(flagged.id);
  }

  /** Terminal Session rows end only by a human's act (spec: human Stages): no Outcome, and a reason only for Abandon. */
  endHumanSessions(ticket: TicketRow, reason: EndedReason | null = null): void {
    for (const row of this.deps.sessions.running(ticket.id)) {
      if (row.mode !== "terminal") continue;
      this.deps.sessions.end(row.id, { ended_by: "human", ended_reason: reason, outcome: null, final_message: null, usage: null, cost_usd: null, transcript_path: row.transcript_path });
    }
  }
}

/** The fields that clear a Flag, when there is one to clear; the reason goes with it. */
function unflagPatch(ticket: TicketRow, now: string): Partial<TicketRow> {
  return ticket.flagged_at ? { flagged_at: null, flag_reason: null, flag_detail: null, unflagged_at: now } : {};
}
