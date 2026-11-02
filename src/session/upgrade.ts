import type { LaissoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { PipelineVersions } from "../store/versions.ts";
import type { Sessions } from "../store/sessions.ts";
import type { ChosenBy, Visits } from "../store/visits.ts";
import type { Mirror } from "../tracker/mirror.ts";
import { loadPipeline, pipelineFile, type Pipeline } from "../pipeline/load.ts";
import { TriggerError, type Progress } from "./progress.ts";

/** A pending or held Route pick an upgrade affects: it follows its Route's new `to:`, or is dropped when the Route or its target is gone. */
export interface PickAcross {
  route: string;
  /** Who picked it, and the note it would carry. */
  by: ChosenBy | null;
  note: string | null;
  /** Where the Route went in the Ticket's Version. */
  from: string | null;
  /** Where it goes in the new Version; null when it is dropped. */
  to: string | null;
  /** Why it is dropped, for the dialog's warning; null when it follows. */
  dropped: string | null;
  /** The Ticket holds before it (LASSO-196), rather than its pick waiting on a Flag or a run. */
  held: boolean;
}

/** What upgrading a Ticket to its Pipeline as the file stands would do, for the dialog before it is confirmed. */
export interface UpgradePlan {
  from: number | null;
  /** The Version it would run: the latest one when the file matches it, else the next, numbered on confirm. */
  to: number;
  fresh: boolean;
  /** The new Version's Stages, in order: where it may land. */
  stages: string[];
  /** The Ticket's Stage, and whether the new Version still has one by that name, so the same Visit continues there. */
  stage: string;
  keeps: boolean;
  /** The current Visit's pick, when it has one, and what the upgrade does to it if the Ticket stays on its Stage. */
  pick: PickAcross | null;
  /** Why the upgrade cannot go now (a Session is running), else null. */
  unavailable: string | null;
}

/** What a human asks of an upgrade: where the Ticket lands (left out: its own Stage), and that a pick may be dropped. */
export interface UpgradeRequest {
  stage?: unknown;
  drop?: unknown;
}

export interface UpgradeDeps {
  home: LaissoHome;
  tickets: Tickets;
  versions: PipelineVersions;
  sessions: Sessions;
  visits: Visits;
  progress: Progress;
  log: Logger;
  mirror: Mirror;
}

/**
 * Upgrade a Ticket to its Pipeline as the file stands (ADR 0009, LASSO-201). Never refused over Routes; it waits
 * for a running Session to end. On its own Stage the same Visit continues, its attempts, Rounds, Route text and note
 * included, and a pending or held pick follows its Route's new `to:`; one whose Route or target is gone is dropped
 * once the human confirms, and recorded on the upgrade. On a landing the human picks, an upgrade Visit opens there.
 */
export class VersionUpgrade {
  private deps: UpgradeDeps;

  constructor(deps: UpgradeDeps) {
    this.deps = deps;
  }

  /** What the upgrade would do, or the TriggerError saying why the Ticket has nothing to upgrade to. */
  plan(ticket: TicketRow): UpgradePlan & { pipeline: Pipeline } {
    const { versions, home } = this.deps;
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is ${ticket.state}`);
    if (ticket.pipeline_version === null) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} runs Pipeline ${ticket.pipeline} from its file; there is no Version to upgrade`);
    if (!pipelineFile(home.pipelinesDir, ticket.pipeline)) throw new TriggerError(`Pipeline ${ticket.pipeline} has been deleted; there is nothing to upgrade to`);
    // A file that does not load, or breaks a Route rule, is refused here as Intake refuses to take a Version of it.
    const pipeline = loadPipeline(home.pipelinesDir, ticket.pipeline);
    const { version, fresh } = versions.peek(pipeline);
    if (version === ticket.pipeline_version) throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} already runs ${ticket.pipeline} v${version}, the Pipeline as it stands`);
    const old = versions.get(ticket.pipeline, ticket.pipeline_version);
    const stage = pipeline.stages.find((s) => s.name === ticket.stage) ?? null;
    const running = this.deps.sessions.running(ticket.id).find((s) => s.mode !== "terminal");
    return {
      pipeline,
      from: ticket.pipeline_version,
      to: version,
      fresh,
      stages: pipeline.stages.map((s) => s.name),
      stage: ticket.stage,
      keeps: stage !== null,
      pick: this.pickAcross(ticket, old, pipeline),
      unavailable: running ? `${running.stage} has a Session running; upgrade once it ends` : null,
    };
  }

  /** The current Visit's pick, followed into the new Version by Route name on the same-named Stage. */
  private pickAcross(ticket: TicketRow, old: Pipeline | null, next: Pipeline): PickAcross | null {
    const visit = this.deps.visits.current(ticket.id);
    if (!visit?.picked_route) return null;
    const route = visit.picked_route;
    const from = old?.stages.find((s) => s.name === ticket.stage)?.routes?.[route]?.to ?? null;
    const stage = next.stages.find((s) => s.name === ticket.stage);
    const declared = stage?.routes?.[route];
    const reached = declared && next.stages.some((s) => s.name === declared.to);
    const dropped = !stage
      ? null
      : !declared
        ? `Route ${route} is gone from ${ticket.stage} in the new Version`
        : !reached
          ? `Route ${route} goes to ${declared.to}, which the new Version does not have`
          : null;
    return { route, by: visit.picked_by, note: visit.picked_note, from, to: dropped || !declared ? null : declared.to, dropped, held: ticket.holding_since !== null };
  }

  /**
   * Upgrade the Ticket. `stage` picks the landing; left out, or naming its own Stage, the Visit continues there, which
   * needs the new Version to have that Stage. A pick the upgrade drops needs `drop: true`, the human having seen the
   * warning. A new landing clears a Flag and a hold, as a send does, and ends terminal Sessions on the Stage left.
   */
  upgrade(ticket: TicketRow, request: UpgradeRequest): TicketRow {
    const { tickets, log, progress } = this.deps;
    if (request.stage !== undefined && request.stage !== null && (typeof request.stage !== "string" || !request.stage)) throw new TriggerError("stage must name a Stage of the new Version, or be left out to stay on this one");
    const plan = this.plan(ticket);
    if (plan.unavailable) throw new TriggerError(plan.unavailable);
    const landing = typeof request.stage === "string" ? request.stage : null;
    if (landing !== null && !plan.stages.includes(landing)) throw new TriggerError(`${ticket.pipeline} v${plan.to} has no Stage named ${landing}; it has ${plan.stages.join(", ")}`);
    const stays = landing === null || landing === ticket.stage;
    if (stays && !plan.keeps) throw new TriggerError(`${ticket.pipeline} v${plan.to} has no Stage named ${ticket.stage}; pick the Stage the Ticket lands on`);
    const drop = stays && plan.pick?.dropped ? plan.pick : null;
    if (drop && request.drop !== true) throw new TriggerError(`${drop.dropped}; upgrading drops the ${drop.by ?? "earlier"} pick of it. Confirm with drop: true`);
    const version = this.deps.versions.pin(plan.pipeline);
    const now = new Date().toISOString();
    if (!stays) progress.endHumanSessions(ticket);
    const clear: Partial<TicketRow> = stays ? {} : { holding_since: null, runnable_since: null, ...(ticket.flagged_at ? { flagged_at: null, flag_reason: null, flag_detail: null, unflagged_at: now } : {}) };
    const { ticket: upgraded } = tickets.upgrade(ticket.id, { version, stages: plan.stages }, { landing: stays ? null : landing, drop: drop && { route: drop.route, to: drop.from } }, clear, now);
    log.info("ticket.upgraded", {
      ticket: ticket.id,
      from: plan.from,
      to: version,
      stage: upgraded.stage,
      landed: !stays,
      route: stays && plan.pick && !drop ? plan.pick.route : null,
      route_to: stays && plan.pick && !drop ? plan.pick.to : null,
      dropped: drop?.route ?? null,
    });
    if (!stays) progress.entered(upgraded, plan.pipeline.stages.find((s) => s.name === landing)!);
    this.deps.mirror.pushSoon(upgraded.id);
    return upgraded;
  }
}
