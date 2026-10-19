import { existsSync } from "node:fs";
import { actionsFor, currentConfig, type Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { PrLinks } from "../store/links.ts";
import { actionEnv, lastLine, missingParams, runCommand, type RunningCommand } from "../session/command.ts";
import type { ActionProbe, ArtifactVerdict } from "./check.ts";

export interface ActionChecksDeps {
  config: Config;
  home: LassoHome;
  tickets: Tickets;
  links: PrLinks;
  log: Logger;
}

/**
 * Check Actions (ADR 0014): an Action from config.yaml run as a Stage's
 * Artifact, in the Ticket's worktree with the variables an action Stage
 * gets. No Session is recorded; the exit code is the verdict, and the
 * latest at each Stage is kept on the Ticket for the page to show.
 */
export class ActionChecks {
  private deps: ActionChecksDeps;
  private live = new Set<RunningCommand>();
  /** Tickets with a check running now: a poll leaves them alone rather than run a second. */
  private busy = new Set<string>();

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

  /** Ctrl-C: every running check is killed; it runs again when next asked. */
  async shutdown(): Promise<void> {
    const live = [...this.live];
    for (const run of live) run.kill("shutdown");
    await Promise.all(live.map((run) => run.done));
  }

  private async run(ticket: TicketRow, stage: string, name: string, params: Record<string, string>): Promise<ArtifactVerdict> {
    this.busy.add(ticket.id);
    const { verdict, code } = await this.verdict(ticket, stage, name, params).finally(() => this.busy.delete(ticket.id));
    // Shutdown cut it short: it is no verdict, so nothing is kept.
    if (code !== "shutdown") {
      const result = verdict.present ? "met" : verdict.broken ? "error" : "not_met";
      this.deps.tickets.setCheck(ticket.id, stage, { action: name, result, at: new Date().toISOString(), code: typeof code === "number" ? code : null, line: verdict.detail });
    }
    return verdict;
  }

  private async verdict(ticket: TicketRow, stage: string, name: string, params: Record<string, string>): Promise<{ verdict: ArtifactVerdict; code: number | null | "shutdown" }> {
    const config = currentConfig(this.deps.home, this.deps.config);
    const action = actionsFor(config, ticket.repo)[name];
    const cannot = (detail: string) => ({ verdict: { present: false, detail, broken: true }, code: null });
    if (!action) return cannot(`no Action named ${name} in config.yaml`);
    const missing = missingParams(action, params);
    if (missing.length) return cannot(`${name} needs ${missing.map((p) => `with.${p}`).join(", ")}`);
    if (!existsSync(ticket.worktree)) return cannot(`the worktree ${ticket.worktree} is missing`);
    const command = runCommand(action, ticket.worktree, actionEnv(this.deps.config, ticket, this.deps.links.links(ticket.id), stage, "", params));
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
