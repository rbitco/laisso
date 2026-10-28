import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { PipelineVersions } from "../store/versions.ts";
import type { Sessions, EndedReason } from "../store/sessions.ts";
import { checkOf, type Visits } from "../store/visits.ts";
import { roundDue, type PrLinks } from "../store/links.ts";
import type { Notifier } from "../notify/notifier.ts";
import { type ActionStage, type Pipeline, type RunnerStage, type Stage } from "../pipeline/load.ts";
import type { Mirror } from "../tracker/mirror.ts";
import { checkArtifact, type ActionProbe, type PrProbe } from "../artifact/check.ts";
import type { Teardown } from "./teardown.ts";
import { decide, type Exit, type RoutePick } from "../route/route.ts";
import type { CheckRun } from "../artifact/action-check.ts";
import type { Budgets } from "../budget/budgets.ts";

/** What Send to Stage asks for: the target Stage, the human's instructions, and a declared Route to reuse, if any. */
export interface SendRequest {
  stage: string;
  note: string | null;
  route: string | null;
}

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
  versions: PipelineVersions;
  sessions: Sessions;
  /** Each arrival at a Stage, where a Skip is kept. */
  visits: Visits;
  /** The Ticket's PR links, where a Round due to start is kept. */
  links: PrLinks;
  /** Each Route's count and limit, for the Route Budget. */
  budgets: Budgets;
  log: Logger;
  notifier: Notifier;
  mirror: Mirror;
  /** The Ticket's PR for the pr-* artifacts; wired once the Review loop exists. */
  prProbe: (ticket: TicketRow) => PrProbe;
  /** Runs a check Action artifact for the Ticket at a Stage (ADR 0014). */
  actionProbe: (ticket: TicketRow, stage: string) => ActionProbe;
  /** The check run under way with this id (its LASSO_SESSION), or null: where a check's `lasso route` pick goes. */
  checkRun: (id: string) => CheckRun | null;
  teardown: Teardown;
}

/**
 * How a Ticket moves along its Pipeline (ADR 0001): a Stage finishes and the
 * next becomes current, or a Route's target does, holds for a Start trigger
 * when the finished Stage said `advance: false`, or the Ticket is done after
 * the last. Flags freeze
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
      pipeline = this.deps.versions.forTicket(ticket, this.deps.home.pipelinesDir);
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
    if (current.stage.repeat && !roundDue(this.deps.links.links(ticket.id)) &&!this.roundToRerun(ticket, current.stage)) return null;
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

  /** A Ticket just admitted: its first Stage is current, and the tracker learns of it in the background. */
  async admitted(ticket: TicketRow): Promise<void> {
    const current = this.current(ticket);
    if (!("problem" in current)) this.entered(ticket, current.stage);
    this.deps.mirror.pushSoon(ticket.id);
  }

  /** The current Stage of an active, unflagged Ticket, or the TriggerError that says why a Trigger cannot pull. */
  currentForTrigger(ticket: TicketRow): Current {
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is ${ticket.state}`);
    if (ticket.flagged_at) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is Flagged; clear the Flag first`);
    const current = this.current(ticket);
    if ("problem" in current) throw new TriggerError(current.problem);
    return current;
  }

  /**
   * The Stage a human-only Trigger (Open terminal, Mark done) acts on: a human Stage, or a headless one a
   * human has taken over in a terminal, which is worked as a human Stage until it finishes.
   */
  humanStage(ticket: TicketRow): { pipeline: Pipeline; stage: RunnerStage } {
    const current = this.currentForTrigger(ticket);
    if (ticket.holding_since) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is holding; Start ${current.stage.name} first`);
    if (current.stage.kind !== "runner" || !(current.stage.human || this.takenOver(ticket, current.stage.name))) throw new TriggerError(`${current.stage.name} is not a human Stage`);
    return { pipeline: current.pipeline, stage: current.stage };
  }

  /** A terminal Session holds the Stage: a human took a headless Stage over (Take over in terminal). */
  takenOver(ticket: TicketRow, stage: string): boolean {
    return this.deps.sessions.running(ticket.id).some((s) => s.mode === "terminal" && s.stage === stage);
  }

  /** The Stage a Flag exit acts on: where an active, Flagged Ticket stopped. */
  flaggedStage(ticket: TicketRow): Current {
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is ${ticket.state}`);
    if (!ticket.flagged_at) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is not Flagged`);
    const current = this.current(ticket);
    if ("problem" in current) throw new TriggerError(current.problem);
    return current;
  }

  /** Mark done acts on the human Stage under way, or on whatever Stage a Flagged Ticket stopped at. */
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
    this.deps.mirror.pushSoon(ticketId);
  }

  /** A Stage just became current (at intake, or by advancing): a human Stage is an Attention event. */
  entered(ticket: TicketRow, stage: Stage): void {
    if (stage.kind === "runner" && stage.human) this.deps.notifier.post("human", ticket, `${stage.name} needs you`);
  }

  /**
   * The current Stage finished: move on, hold for Start, or finish the Ticket. The mirror push is
   * not awaited: tracker CLI calls take a second or more, and a Trigger should answer as soon as
   * the row has moved. A failed push shows as mirror-pending and the tick retries it.
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
      this.deps.mirror.pushSoon(done.id);
      return;
    }
    const holds = current.stage.kind === "runner" && !current.stage.advance;
    const updated = this.deps.tickets.arrive(ticket.id, { stage: next.name, arrived_by: "walk" }, { holding_since: holds ? now : null, ...unflagPatch(ticket, now) }, now);
    this.deps.log.info("ticket.advanced", { ticket: ticket.id, stage: next.name, holding: holds });
    if (holds) this.deps.notifier.post("gate", updated, `${current.stage.name} finished; Start ${next.name} when ready`);
    else this.entered(updated, next);
    this.deps.mirror.pushSoon(updated.id);
  }

  /**
   * The current Stage finished along the exit the Route decision chose: walk forward as `finished` does, or take
   * the Route. Taking one leaves the Visit for a new one at the target, carrying the Route's text and note; Stages a
   * forward Route passes over get no Visit and keep their last one's state. The Ticket walks on from the target.
   * A spent Route Flags `budget.routes` instead, keeping the pick pending on the Visit for Extend.
   */
  async leave(ticket: TicketRow, exit: Exclude<Exit, { kind: "failed" }>): Promise<void> {
    if (exit.kind === "walk") return this.finished(ticket);
    if (exit.kind === "conflict") return this.flag(ticket.id, "route.conflict", `${pickLine(exit.pick)}; ${pickLine(exit.check)}`);
    const current = this.current(ticket);
    if ("problem" in current) return this.flag(ticket.id, "pipeline.missing", current.problem);
    if (exit.kind === "flag") {
      // The spent Route stays the Visit's pick, with the note it would carry, for Extend to take.
      const { pending } = exit;
      this.deps.visits.pick(ticket.id, pending.route, pending.note, pending.chosenBy);
      return this.flag(ticket.id, exit.reason, exit.detail);
    }
    const target = current.pipeline.stages.find((s) => s.name === exit.to);
    if (!target) return this.flag(ticket.id, "pipeline.missing", `Pipeline ${ticket.pipeline} has no Stage named ${exit.to} for Route ${exit.route}`);
    const now = new Date().toISOString();
    const arrival = { stage: target.name, arrived_by: "route" as const, route: exit.route, chosen_by: exit.chosenBy, text: exit.text, note: exit.note, replaces: exit.replaces };
    const updated = this.deps.tickets.arrive(ticket.id, arrival, { holding_since: null, ...unflagPatch(ticket, now) }, now);
    this.deps.log.info("ticket.routed", { ticket: ticket.id, from: current.stage.name, route: exit.route, stage: target.name, chosen_by: exit.chosenBy });
    this.entered(updated, target);
    this.deps.mirror.pushSoon(updated.id);
  }

  /**
   * A Stage finished as one that advances (a headless Session met its Artifact, or a repeating Stage's check was
   * met): leave by the Route decision over the Visit's picks, the agent's and the latest check's when it was met.
   */
  async advance(ticket: TicketRow): Promise<void> {
    const current = this.current(ticket);
    if ("problem" in current) return this.flag(ticket.id, "pipeline.missing", current.problem);
    const visit = this.deps.visits.current(ticket.id);
    const by = current.stage.kind === "action" ? "action" : "agent";
    // A check's pick lives on its check result; one kept as the Visit's pick is a spent Route left pending, not the run's.
    const own = visit?.picked_route && visit.picked_by !== "check" ? visit : null;
    const pick: RoutePick | null = own ? { route: own.picked_route!, note: own.picked_note, by } : null;
    const result = checkOf(visit);
    const check: RoutePick | null = result?.result === "met" && result.route ? { route: result.route, note: result.note?.trim() || result.line, by: "check", run: visit!.check_run } : null;
    const exit = decide({ stage: current.stage, pick, check, end: { succeeded: true, lastLine: null }, counts: this.deps.budgets.routes(ticket, current.stage) });
    if (exit.kind === "failed") return this.finished(ticket);
    return this.leave(ticket, exit);
  }

  /**
   * `lasso route`: a running Session or check run picks the Route its Stage is to leave by, over any it picked
   * before, or with null drops its pick. The Route decision takes it when the run ends. Only an action Stage's
   * Action and a check Action may pick for now, and only a Route its Stage declares. A check run's pick is held
   * with the run and kept on the Visit's check result only when the run is met (LASSO-192).
   */
  pick(sessionId: string, route: string | null, note: string | null): { ticket: string; stage: Stage; route: string | null; note: string | null } {
    const run = this.deps.checkRun(sessionId);
    if (run) return this.checkPick(run, route, note);
    const session = this.deps.sessions.get(sessionId);
    if (!session) throw new TriggerError(`no running Session or check run ${sessionId}; a Route is picked while it runs`);
    if (session.ended_at) throw new TriggerError(`Session ${sessionId} has ended; a Route is picked while it runs`);
    const ticket = this.deps.tickets.get(session.ticket)!;
    const current = this.currentForTrigger(ticket);
    const visit = this.deps.visits.current(ticket.id);
    if (!visit || session.visit !== visit.id) throw new TriggerError(`Session ${sessionId} is not working ${ticket.stage} on this Visit`);
    const { stage } = current;
    if (stage.kind !== "action") throw new TriggerError(`Stage ${stage.name} does not let its agent choose a Route`);
    declares(stage, route);
    const picked = this.deps.visits.pick(ticket.id, route, note?.trim() || null, "action")!;
    this.deps.log.info(route === null ? "route.cleared" : "route.picked", { ticket: ticket.id, stage: stage.name, session: sessionId, route });
    return { ticket: ticket.id, stage, route: picked.picked_route, note: picked.picked_note };
  }

  /** A check run's `lasso route`: the run must be checking the Ticket's current Stage on its current Visit. */
  private checkPick(run: CheckRun, route: string | null, note: string | null): { ticket: string; stage: Stage; route: string | null; note: string | null } {
    const ticket = this.deps.tickets.get(run.ticket)!;
    const current = this.current(ticket);
    if ("problem" in current) throw new TriggerError(current.problem);
    if (current.stage.name !== run.stage || this.deps.visits.current(ticket.id)?.id !== run.visit) throw new TriggerError(`check run ${run.id} is not checking ${ticket.stage} on this Visit`);
    declares(current.stage, route);
    run.pick = route === null ? null : { route, note: note?.trim() || null };
    this.deps.log.info(route === null ? "route.cleared" : "route.picked", { ticket: ticket.id, stage: run.stage, check_run: run.id, route });
    return { ticket: ticket.id, stage: current.stage, route, note: run.pick?.note ?? null };
  }

  /**
   * Send to Stage (LASSO-197): a human moves the Ticket to any Stage of its Pipeline, the current one included, on
   * a new Visit that arrived by send and was chosen by a human. The instructions are that Visit's note; a declared
   * Route of the current Stage that goes to the target may be reused for its append or replace text. A human's
   * choice never counts against a Route Budget and is never refused for one. It works from a Flag, a hold, a human
   * or taken-over Stage (whose terminal Sessions end, as Mark done ends them), and any Stage not running a Session;
   * a pick left on the Visit being left stays there, overridden by this send.
   */
  send(ticket: TicketRow, request: SendRequest): TicketRow {
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is ${ticket.state}`);
    const current = this.current(ticket);
    if ("problem" in current) throw new TriggerError(current.problem);
    const running = this.deps.sessions.running(ticket.id).find((s) => s.mode !== "terminal");
    if (running) throw new TriggerError(`${running.stage} has a Session running; stop it or let it end before sending the Ticket elsewhere`);
    const target = current.pipeline.stages.find((s) => s.name === request.stage);
    if (!target) throw new TriggerError(`Pipeline ${ticket.pipeline} has no Stage named ${request.stage}`);
    const route = request.route === null ? null : current.stage.routes?.[request.route];
    if (request.route !== null && !route) throw new TriggerError(`Stage ${current.stage.name} declares no Route named ${request.route}`);
    if (route && route.to !== target.name) throw new TriggerError(`Route ${request.route} goes to ${route.to}, not ${target.name}`);
    const overridden = this.deps.visits.current(ticket.id)?.picked_route ?? null;
    this.endHumanSessions(ticket);
    const now = new Date().toISOString();
    const arrival = { stage: target.name, arrived_by: "send" as const, route: request.route, chosen_by: "human" as const, text: route ? (route.replace ?? route.append ?? null) : null, note: request.note, replaces: route?.replace !== undefined };
    const updated = this.deps.tickets.arrive(ticket.id, arrival, { holding_since: null, runnable_since: null, ...unflagPatch(ticket, now) }, now);
    this.deps.log.info("ticket.sent", { ticket: ticket.id, from: current.stage.name, stage: target.name, route: request.route, overridden, flagged: ticket.flagged_at !== null, holding: ticket.holding_since !== null });
    this.entered(updated, target);
    this.deps.mirror.pushSoon(updated.id);
    return updated;
  }

  /** The Route the current Visit picked for leaving and has not taken yet, as when a spent Route Flagged it, or null. */
  pendingPick(ticket: TicketRow): RoutePick | null {
    const visit = this.deps.visits.current(ticket.id);
    return visit?.picked_route ? { route: visit.picked_route, note: visit.picked_note, by: visit.picked_by ?? "action" } : null;
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
      const verdict = await checkArtifact(stage.artifact, ticket.worktree, this.deps.prProbe(ticket), this.deps.actionProbe(ticket, stage.name), stage.artifactWith);
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

  /**
   * The Stage Skip acts on: where a Flagged Ticket stopped, the human Stage under way, or one that has not started
   * (LASSO-159): the Stage a holding Ticket waits at, or one with no Session yet this Visit and none running.
   */
  private skipStage(ticket: TicketRow): Stage {
    if (ticket.flagged_at) return this.flaggedStage(ticket).stage;
    const { stage } = this.currentForTrigger(ticket);
    if (ticket.holding_since) return stage;
    if (stage.kind === "runner" && (stage.human || this.takenOver(ticket, stage.name))) return stage;
    const visit = this.deps.visits.current(ticket.id);
    const started = this.deps.sessions.running(ticket.id).length > 0 || this.deps.sessions.forTicket(ticket.id).some((s) => s.visit === visit?.id);
    if (started) throw new TriggerError(`${stage.name} has started; Skip only a Stage that has not, or one that is Flagged`);
    return stage;
  }

  /** Skip: the Stage finishes without its artifact, and its Visit records when (a human Stage, a Flagged one, or one not yet started). */
  async skip(ticket: TicketRow): Promise<TicketRow> {
    const stage = this.skipStage(ticket);
    this.endHumanSessions(ticket);
    const now = new Date().toISOString();
    this.deps.visits.setSkipped(ticket.id, now);
    const skipped = this.deps.tickets.update(ticket.id, {}, now);
    this.deps.log.info("ticket.skipped", { ticket: ticket.id, stage: stage.name, flagged: ticket.flagged_at !== null, holding: ticket.holding_since !== null });
    await this.finished(skipped);
    return this.deps.tickets.get(ticket.id)!;
  }

  /** Abandon: the Ticket leaves Lasso's attention for good (CONTEXT.md: Abandoned). Exits kills its Sessions and tears the worktree down after this. */
  async abandon(ticket: TicketRow): Promise<TicketRow> {
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is already ${ticket.state}`);
    const now = new Date().toISOString();
    const abandoned = this.deps.tickets.update(ticket.id, { state: "abandoned", ended_at: now, holding_since: null, runnable_since: null, ...unflagPatch(ticket, now) });
    this.endHumanSessions(abandoned, "abandon");
    this.deps.log.info("ticket.abandoned", { ticket: ticket.id, stage: ticket.stage, flagged: ticket.flagged_at !== null });
    this.deps.mirror.pushSoon(abandoned.id);
    return abandoned;
  }

  async flag(ticketId: string, reason: string, detail: string | null): Promise<void> {
    const flagged = this.deps.tickets.update(ticketId, { flagged_at: new Date().toISOString(), flag_reason: reason, flag_detail: detail, runnable_since: null });
    this.deps.log.info("ticket.flagged", { ticket: ticketId, reason, detail });
    this.deps.notifier.post("flagged", flagged, detail ? `${reason}: ${detail}` : reason);
    this.deps.mirror.pushSoon(flagged.id);
  }

  /** Terminal Session rows end only by a human's act (spec: human Stages): no Outcome, and a reason only for Abandon. */
  endHumanSessions(ticket: TicketRow, reason: EndedReason | null = null): void {
    for (const row of this.deps.sessions.running(ticket.id)) {
      if (row.mode !== "terminal") continue;
      this.deps.sessions.end(row.id, { ended_by: "human", ended_reason: reason, outcome: null, final_message: null, usage: null, cost_usd: null, transcript_path: row.transcript_path });
    }
  }
}

/** Refuse a Route the Stage does not declare; null (dropping the pick) always passes. */
function declares(stage: Stage, route: string | null): void {
  if (route === null || stage.routes?.[route]) return;
  const names = Object.keys(stage.routes ?? {});
  throw new TriggerError(`no Route named ${route} on Stage ${stage.name}; ${names.length ? `it has ${names.join(", ")}` : "it declares none"}`);
}

/** One side of a route.conflict Flag: who picked which Route, with its note. */
function pickLine(pick: RoutePick): string {
  return `the ${pick.by} picked Route ${pick.route}${pick.note?.trim() ? ` (${pick.note.trim()})` : ""}`;
}

/** The fields that clear a Flag, when there is one to clear; the reason goes with it. */
function unflagPatch(ticket: TicketRow, now: string): Partial<TicketRow> {
  return ticket.flagged_at ? { flagged_at: null, flag_reason: null, flag_detail: null, unflagged_at: now } : {};
}
