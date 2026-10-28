import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { actionsFor, currentConfig, type Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { TicketRow } from "../store/tickets.ts";
import type { PrLinks } from "../store/links.ts";
import type { Visits } from "../store/visits.ts";
import { actionEnv, lastLine, missingParams, runCommand, type RunningCommand } from "../session/command.ts";
import type { ActionProbe, ArtifactVerdict } from "./check.ts";

export interface ActionChecksDeps {
  config: Config;
  home: LassoHome;
  links: PrLinks;
  visits: Visits;
  log: Logger;
}

/**
 * A check run under way: its id is the run's LASSO_SESSION, so `lasso route`
 * inside it can pick a Route (LASSO-192). The pick lives here until the run
 * ends, and is kept on the Visit's check result only when the run is met.
 */
export interface CheckRun {
  id: string;
  ticket: string;
  stage: string;
  /** The Visit the run checks for: the Stage's latest when it began. */
  visit: number | null;
  pick: { route: string; note: string | null } | null;
}

/**
 * Check Actions (ADR 0014): an Action from config.yaml run as a Stage's
 * Artifact, in the Ticket's worktree with the variables an action Stage
 * gets. No Session is recorded; the exit code is the verdict, and the
 * latest is kept on the Stage's Visit for the page to show, with the
 * run's id and the Route a met run picked.
 */
export class ActionChecks {
  private deps: ActionChecksDeps;
  private live = new Set<RunningCommand>();
  /** Tickets with a check running now: a poll leaves them alone rather than run a second. */
  private busy = new Set<string>();
  /** The check runs under way, by id; a run's id stops naming one once it ends, so a late `lasso route` from it is refused. */
  private runs = new Map<string, CheckRun>();

  constructor(deps: ActionChecksDeps) {
    this.deps = deps;
  }

  /** The probe checkArtifact runs for this Ticket at this Stage. */
  probe(ticket: TicketRow, stage: string): ActionProbe {
    return (action, params) => this.run(ticket, stage, action, params);
  }

  /** Is a check running for this Ticket now? */
  running(ticket: string): boolean {
    return this.busy.has(ticket);
  }

  /** The check run under way with this id, whose pick `lasso route` sets; null once it has ended or for any other id. */
  liveRun(id: string): CheckRun | null {
    return this.runs.get(id) ?? null;
  }

  /** Ctrl-C: every running check is killed; it runs again when next asked. */
  async shutdown(): Promise<void> {
    const live = [...this.live];
    for (const run of live) run.kill("shutdown");
    await Promise.all(live.map((run) => run.done));
  }

  private async run(ticket: TicketRow, stage: string, name: string, params: Record<string, string>): Promise<ArtifactVerdict> {
    const run: CheckRun = { id: randomUUID(), ticket: ticket.id, stage, visit: this.deps.visits.latest(ticket.id, stage)?.id ?? null, pick: null };
    this.busy.add(ticket.id);
    this.runs.set(run.id, run);
    const { verdict, code } = await this.verdict(ticket, stage, name, params, run.id).finally(() => {
      this.busy.delete(ticket.id);
      this.runs.delete(run.id);
    });
    // Shutdown cut it short: it is no verdict, so nothing is kept.
    if (code !== "shutdown") {
      const result = verdict.present ? "met" : verdict.broken ? "error" : "not_met";
      // A pick counts only from a met run; a not-met or broken run's is discarded.
      const pick = result === "met" && run.pick ? { route: run.pick.route, note: run.pick.note } : {};
      this.deps.visits.setCheck(ticket.id, stage, { action: name, result, at: new Date().toISOString(), code: typeof code === "number" ? code : null, line: verdict.detail, ...pick }, run.id);
    }
    return verdict;
  }

  private async verdict(ticket: TicketRow, stage: string, name: string, params: Record<string, string>, runId: string): Promise<{ verdict: ArtifactVerdict; code: number | null | "shutdown" }> {
    const config = currentConfig(this.deps.home, this.deps.config);
    const action = actionsFor(config, ticket.repo)[name];
    const cannot = (detail: string) => ({ verdict: { present: false, detail, broken: true }, code: null });
    if (!action) return cannot(`no Action named ${name} in config.yaml`);
    const missing = missingParams(action, params);
    if (missing.length) return cannot(`${name} needs ${missing.map((p) => `with.${p}`).join(", ")}`);
    if (!existsSync(ticket.worktree)) return cannot(`the worktree ${ticket.worktree} is missing`);
    const command = runCommand(action, ticket.worktree, actionEnv(this.deps.config, ticket, this.deps.links.links(ticket.id), stage, runId, params));
    this.live.add(command);
    const { code, killed, spawnError, tail } = await command.done.finally(() => this.live.delete(command));
    const last = lastLine(tail);
    const verdict: ArtifactVerdict =
      killed === "timeout" ? { present: false, detail: `${name} timed out after ${action.timeout}`, broken: true }
      : killed === "shutdown" ? { present: false, detail: `${name} was stopped by shutdown`, broken: true }
      : spawnError ? { present: false, detail: `${name} could not start: ${spawnError}`, broken: true }
      : code === 0 ? { present: true, detail: last || null }
      : code === 1 ? { present: false, detail: last || `${name} exited 1` }
      : { present: false, detail: `${name} exited ${code ?? "on a signal"}${last ? `: ${last}` : ""}`, broken: true };
    this.deps.log.info("artifact.checked", { ticket: ticket.id, stage, action: name, code, present: verdict.present, broken: verdict.broken ?? false });
    return { verdict, code: killed === "shutdown" ? "shutdown" : code };
  }
}
