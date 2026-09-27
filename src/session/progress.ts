import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import type { Notifier } from "../notify/notifier.ts";
import { loadPipeline, type ActionStage, type Pipeline, type RunnerStage, type Stage } from "../pipeline/load.ts";
import type { Mirror } from "../tracker/mirror.ts";
import { checkArtifact } from "../artifact/check.ts";

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
}

/**
 * How a Ticket moves along its Pipeline (ADR 0001): a Stage finishes and the
 * next becomes current, holds for a Start trigger when the finished Stage
 * said `advance: false`, or the Ticket is done after the last. Flags freeze
 * it. Every Attention event notifies once, here.
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

  /** The headless Stage the tick should start for this Ticket, null when there is nothing to start, or the problem. */
  runnable(ticket: TicketRow): { pipeline: Pipeline; stage: RunnerStage } | { problem: string } | null {
    if (!this.idle(ticket)) return null;
    const current = this.current(ticket);
    if ("problem" in current) return current;
    if (current.stage.kind !== "runner" || current.stage.human) return null;
    return { pipeline: current.pipeline, stage: current.stage };
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
    if (!next) {
      const done = this.deps.tickets.update(ticket.id, { state: "done", holding_since: null });
      this.deps.log.info("ticket.done", { ticket: ticket.id });
      await this.deps.mirror.push(done.id);
      return;
    }
    const holds = current.stage.kind === "runner" && !current.stage.advance;
    const updated = this.deps.tickets.update(ticket.id, { stage: next.name, holding_since: holds ? new Date().toISOString() : null });
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

  /** Mark <Stage> done: the artifact is checked with warn-and-override, then the human Stage finishes. */
  async markDone(ticket: TicketRow, override: boolean): Promise<TicketRow> {
    const { stage } = this.humanStage(ticket);
    if (!override && stage.artifact) {
      const verdict = await checkArtifact(stage.artifact, ticket.worktree);
      if (!verdict.present) throw new ArtifactWarning(stage.artifact, verdict.detail ?? "missing");
    }
    // The check awaited; the Ticket is re-read so a Trigger that landed meanwhile is not applied twice.
    const fresh = this.deps.tickets.get(ticket.id)!;
    if (fresh.stage !== stage.name) throw new TriggerError(`${stage.name} already finished`);
    this.endHumanSessions(fresh);
    this.deps.log.info("ticket.marked_done", { ticket: ticket.id, stage: stage.name, override });
    await this.finished(fresh);
    return this.deps.tickets.get(ticket.id)!;
  }

  /** Skip: the human Stage finishes without its artifact. */
  async skip(ticket: TicketRow): Promise<TicketRow> {
    const { stage } = this.humanStage(ticket);
    this.endHumanSessions(ticket);
    this.deps.log.info("ticket.skipped", { ticket: ticket.id, stage: stage.name });
    await this.finished(ticket);
    return this.deps.tickets.get(ticket.id)!;
  }

  async flag(ticketId: string, reason: string, detail: string | null): Promise<void> {
    const flagged = this.deps.tickets.update(ticketId, { flagged_at: new Date().toISOString(), flag_reason: reason, flag_detail: detail });
    this.deps.log.info("ticket.flagged", { ticket: ticketId, reason, detail });
    this.deps.notifier.post("flagged", flagged, detail ? `${reason}: ${detail}` : reason);
    await this.deps.mirror.push(flagged.id);
  }

  /** Terminal Session rows end only by a human's act (spec: human Stages): no Outcome, no reason. */
  private endHumanSessions(ticket: TicketRow): void {
    for (const row of this.deps.sessions.running(ticket.id)) {
      if (row.mode !== "terminal") continue;
      this.deps.sessions.end(row.id, { ended_by: "human", ended_reason: null, outcome: null, final_message: null, usage: null, cost_usd: null, transcript_path: row.transcript_path });
    }
  }
}
