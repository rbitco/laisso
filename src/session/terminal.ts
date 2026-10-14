import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { currentConfig, type Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import { shortId, type TicketRow } from "../store/tickets.ts";
import { runnerOf, sessionProfile, type Sessions, type SessionRow } from "../store/sessions.ts";
import { ticketProfile } from "./overrides.ts";
import type { Pipeline, RunnerStage } from "../pipeline/load.ts";
import { requestFor, type Command, type RunRequest, type RunnerAdapter } from "../runner/adapter.ts";
import { adapterFor } from "../runner/adapters.ts";
import { shellQuote } from "../macos.ts";
import { chooseTerminal, macosTerminal, openerFor, TerminalError, type TerminalKind } from "./openers.ts";

export { TerminalError };

export interface TerminalDeps {
  config: Config;
  home: LassoHome;
  sessions: Sessions;
  log: Logger;
  /** Flags the Ticket; a Stage whose profile is gone from config cannot open. */
  flag: (ticket: string, reason: string, detail: string) => Promise<void>;
  /** The environment Lasso started in, which says whether it runs inside herdr or tmux; defaults to the process's. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Human Stages: Open terminal launches the Runner interactively on a Lasso-
 * chosen session id and tracks it by that id only. Opening again relaunches
 * on the held id (Resume); a Runner that names its own session (Codex) is
 * asked for it first. Lasso never checks liveness; the row ends only by a
 * human's act (spec: human Stages).
 */
export class Terminal {
  private deps: TerminalDeps;
  private env: NodeJS.ProcessEnv;

  constructor(deps: TerminalDeps) {
    this.deps = deps;
    this.env = deps.env ?? process.env;
  }

  async open(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage): Promise<SessionRow> {
    const { sessions, home, log } = this.deps;
    // Read at each open, as for headless Sessions (ADR 0011): an edit to the profile reaches the next window.
    const config = currentConfig(home, this.deps.config);
    const profile = ticketProfile(config, ticket, pipeline, stage);
    if ("problem" in profile) {
      await this.deps.flag(ticket.id, "profile.missing", profile.problem);
      throw new TerminalError(profile.problem);
    }
    const adapter = adapterFor(profile.profile.runner);
    let held = sessions.running(ticket.id).find((s) => s.mode === "terminal" && s.stage === stage.name) ?? null;
    // A held Session on another Runner (an override or a config edit moved the Stage) cannot be re-entered in this
    // one: it ends, and a fresh Session opens, as a Retry would. The Resume exit refuses instead (Exits).
    const was = held?.opened_at != null ? runnerOf(held) : null;
    const switched = was !== null && was !== profile.profile.runner ? was : null;
    if (switched) {
      sessions.end(held!.id, { ended_by: "human", ended_reason: null, outcome: null, final_message: `${profile.name} runs ${profile.profile.runner}, not ${switched}`, usage: null, cost_usd: null, transcript_path: held!.transcript_path });
      log.info("session.runner_switched", { session: held!.id, ticket: ticket.id, stage: stage.name, from: switched, to: profile.profile.runner });
      held = null;
    }
    const sessionId = held?.id ?? randomUUID();
    // Resume only a session the Runner has been launched on; a row whose window never opened starts afresh.
    const launched = held?.opened_at != null ? held : null;
    const runnerSessionId = launched && adapter.sessionIds === "runner" ? this.runnerSessionOf(launched, ticket.worktree, adapter) : undefined;
    // A Runner that names its own session and has not recorded one since the window opened cannot be re-entered.
    const lost = launched !== null && adapter.sessionIds === "runner" && runnerSessionId === null;
    if (lost) log.warn("session.resume_lost", { session: sessionId, ticket: ticket.id, stage: stage.name, runner: adapter.name });
    const request: RunRequest = {
      ...requestFor(ticket, stage, profile.profile),
      mode: "terminal",
      sessionId,
      resume: launched !== null && !lost,
      runnerSessionId: runnerSessionId ?? undefined,
      name: `Lasso: ${ticket.reference ?? shortId(ticket.id)} ${stage.name}`,
      limits: {},
    };
    const command = adapter.command(request);
    const now = new Date().toISOString();
    const row =
      held ??
      sessions.insert(
        {
          id: sessionId,
          ticket: ticket.id,
          stage: stage.name,
          stage_snapshot: JSON.stringify(stage),
          mode: "terminal",
          started_by: "human",
          stdout_path: null,
          limits_honoured: "[]",
          transcript_path: adapter.transcriptPath(request),
          profile: sessionProfile(profile.name, profile.profile),
        },
        now,
      );

    const dir = path.join(home.ticketsDir, ticket.id, "sessions");
    mkdirSync(dir, { recursive: true });
    const launcher = path.join(dir, `${sessionId}.command`);
    const note = lost
      ? `Lasso found no ${adapter.name} session for ${stage.name} since the last window opened; starting afresh.`
      : switched
        ? `${stage.name} now runs ${profile.name} on ${adapter.name}, not ${switched}; starting afresh.`
        : null;
    writeFileSync(launcher, launcherScript(command, note), { mode: 0o755 });
    const terminal = await this.openWindow(config.terminal, launcher, request.name!, command.cwd);
    log.info(request.resume ? "session.resumed" : "session.opened", { session: sessionId, ticket: ticket.id, stage: stage.name, launcher, terminal });
    return sessions.setOpened(sessionId, new Date().toISOString());
  }

  /**
   * The launcher in the terminal config names, or the one Lasso runs inside.
   * A terminal Lasso chose itself falls back to Terminal.app when it fails
   * (a tmux server gone since Lasso started); one config names is reported.
   */
  private async openWindow(setting: Config["terminal"], launcher: string, name: string, cwd: string): Promise<TerminalKind> {
    const choice = chooseTerminal(setting, this.env);
    try {
      await openerFor(choice.kind, this.env).open(launcher, name, cwd);
      return choice.kind;
    } catch (error) {
      if (!choice.auto || choice.kind === "terminal-app" || !(error instanceof TerminalError)) throw error;
      this.deps.log.warn("terminal.fallback", { terminal: choice.kind, error: error.message });
      await macosTerminal().open(launcher, name, cwd);
      return "terminal-app";
    }
  }

  /** The id the Runner gave a launched Session: kept on the row once found, so later opens re-enter the same one. */
  private runnerSessionOf(row: SessionRow, worktree: string, adapter: RunnerAdapter): string | null {
    if (row.runner_session_id) return row.runner_session_id;
    // The Runner records the physical directory it ran in.
    let cwd = worktree;
    try {
      cwd = realpathSync(worktree);
    } catch {
      // A missing worktree finds nothing below.
    }
    const found = adapter.findSession({ cwd, launchedAfter: new Date(row.started_at) });
    if (found) this.deps.sessions.setRunnerSession(row.id, found);
    return found;
  }
}

/** A shell script that enters the worktree, exports the Ticket context, says anything the human should know, and becomes the Runner. */
export function launcherScript(command: Command, note: string | null = null): string {
  return [
    "#!/bin/sh",
    `cd ${shellQuote(command.cwd)} || exit 1`,
    ...Object.entries(command.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`),
    ...(note ? [`echo ${shellQuote(note)}`] : []),
    `exec ${command.argv.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}
