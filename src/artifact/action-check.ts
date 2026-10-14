import { existsSync } from "node:fs";
import { actionsFor, currentConfig, type Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { TicketRow } from "../store/tickets.ts";
import { actionEnv, lastLine, missingParams, runCommand, type RunningCommand } from "../session/command.ts";
import type { ActionProbe, ArtifactVerdict } from "./check.ts";

export interface ActionChecksDeps {
  config: Config;
  home: LassoHome;
  log: Logger;
}

/**
 * Check Actions (ADR 0014): an Action from config.yaml run as a Stage's
 * Artifact, in the Ticket's worktree with the variables an action Stage
 * gets. No Session is recorded; the exit code is the verdict.
 */
export class ActionChecks {
  private deps: ActionChecksDeps;
  private live = new Set<RunningCommand>();

  constructor(deps: ActionChecksDeps) {
    this.deps = deps;
  }

  /** The probe checkArtifact runs for this Ticket at this Stage. */
  probe(ticket: TicketRow, stage: string): ActionProbe {
    return (action, params) => this.run(ticket, stage, action, params);
  }

  /** Ctrl-C: every running check is killed; it runs again when next asked. */
  async shutdown(): Promise<void> {
    const live = [...this.live];
    for (const run of live) run.kill("shutdown");
    await Promise.all(live.map((run) => run.done));
  }

  private async run(ticket: TicketRow, stage: string, name: string, params: Record<string, string>): Promise<ArtifactVerdict> {
    const config = currentConfig(this.deps.home, this.deps.config);
    const action = actionsFor(config, ticket.repo)[name];
    if (!action) return { present: false, detail: `no Action named ${name} in config.yaml`, broken: true };
    const missing = missingParams(action, params);
    if (missing.length) return { present: false, detail: `${name} needs ${missing.map((p) => `with.${p}`).join(", ")}`, broken: true };
    if (!existsSync(ticket.worktree)) return { present: false, detail: `the worktree ${ticket.worktree} is missing`, broken: true };
    const command = runCommand(action, ticket.worktree, actionEnv(this.deps.config, ticket, stage, "", params));
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
    return verdict;
  }
}
