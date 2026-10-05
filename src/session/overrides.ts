import { currentConfig, profilesFor, resolveProfile, type Config, type ProfileScope, type ResolvedProfile } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import { overrideFor, type Tickets, type TicketRow } from "../store/tickets.ts";
import { runnerOf, type SessionRow } from "../store/sessions.ts";
import type { Pipeline, RunnerStage } from "../pipeline/load.ts";
import { TriggerError, type Progress } from "./progress.ts";

/** The profile a Stage of a Ticket runs under: the Ticket's override for it first, then the Pipeline's choice (ADR 0011). */
export function ticketProfile(config: ProfileScope, ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage): ResolvedProfile | { problem: string } {
  return resolveProfile(config, ticket.repo, pipeline, stage, overrideFor(ticket, stage.name));
}

/**
 * Why Resume cannot re-enter `last` under the profile the Stage resolves to
 * now, or null when it can. Resume keeps the Session's Runner, so a profile
 * on another Runner (by override or a config edit) needs a Retry. A profile
 * that does not resolve is left for the start to Flag.
 */
export function resumeRefusal(stage: string, last: SessionRow, profile: ResolvedProfile | { problem: string }): string | null {
  if ("problem" in profile) return null;
  const was = runnerOf(last);
  if (was === null || was === profile.profile.runner) return null;
  return `${stage} last ran on ${was} and ${profile.name} runs ${profile.profile.runner}; Resume stays on one Runner, so Retry starts afresh`;
}

export interface OverridesDeps {
  config: Config;
  home: LassoHome;
  tickets: Tickets;
  progress: Progress;
  log: Logger;
}

/**
 * A human's override of one Stage's profile on one Ticket (LASSO-75). It is
 * kept on the Ticket by Stage name and read at each Session start, so it
 * reaches every later Session of the Stage, retries and Rounds included, until
 * cleared; a Session already running keeps what it started with.
 */
export class Overrides {
  private deps: OverridesDeps;

  constructor(deps: OverridesDeps) {
    this.deps = deps;
  }

  /** Set the override for a Runner Stage of the Ticket's Version to a profile its repo can reach. */
  set(ticket: TicketRow, stageName: string, profile: unknown): TicketRow {
    this.stageOf(ticket, stageName);
    if (typeof profile !== "string" || !profile.trim()) throw new TriggerError("name the profile to use: { profile: <name> }");
    const config = currentConfig(this.deps.home, this.deps.config);
    if (!profilesFor(config, ticket.repo)[profile]) throw new TriggerError(`no profile named ${profile} in config.yaml for repo ${ticket.repo}`);
    const updated = this.deps.tickets.setOverride(ticket.id, stageName, profile);
    this.deps.log.info("ticket.profile_override", { ticket: ticket.id, stage: stageName, profile });
    return updated;
  }

  /** Clear the override: the Stage goes back to its Pipeline's choice from its next Session. */
  clear(ticket: TicketRow, stageName: string): TicketRow {
    this.stageOf(ticket, stageName);
    if (!overrideFor(ticket, stageName)) return ticket;
    const updated = this.deps.tickets.setOverride(ticket.id, stageName, null);
    this.deps.log.info("ticket.profile_override", { ticket: ticket.id, stage: stageName, profile: null });
    return updated;
  }

  /** The profile the Stage would start under now. */
  resolve(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage): ResolvedProfile | { problem: string } {
    return ticketProfile(currentConfig(this.deps.home, this.deps.config), ticket, pipeline, stage);
  }

  /** The Runner Stage of that name in the Ticket's Version, or the error that says why there is none. */
  private stageOf(ticket: TicketRow, name: string): RunnerStage {
    if (ticket.state !== "active") throw new TriggerError(`Ticket ${ticket.reference ?? ticket.id} is ${ticket.state}`);
    const current = this.deps.progress.current(ticket);
    if ("problem" in current) throw new TriggerError(current.problem);
    const stage = current.pipeline.stages.find((s) => s.name === name);
    if (!stage) throw new TriggerError(`Pipeline ${ticket.pipeline}${ticket.pipeline_version === null ? "" : ` v${ticket.pipeline_version}`} has no Stage named ${name}`);
    if (stage.kind !== "runner") throw new TriggerError(`${name} is an action Stage; it runs no profile`);
    return stage;
  }
}
