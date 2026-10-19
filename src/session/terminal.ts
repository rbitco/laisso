import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { currentConfig, type Config, type ProfileSettings } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import { ticketLabel, type TicketRow } from "../store/tickets.ts";
import type { PrLinks } from "../store/links.ts";
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
  /** The Ticket's linked PRs, which every Session's prompt lists. */
  links: PrLinks;
  log: Logger;
  /** Flags the Ticket; a Stage whose profile is gone from config cannot open. */
  flag: (ticket: string, reason: string, detail: string) => Promise<void>;
  /** The environment Lasso started in, which says whether it runs inside herdr or tmux; defaults to the process's. */
  env?: NodeJS.ProcessEnv;
}

/** A headless Session a terminal takes over: `stop` ends it first when it still runs, then the terminal re-enters its session. */
export interface TakeOver {
  from: SessionRow;
  stop: () => Promise<SessionRow>;
}

/**
 * Human Stages: Open terminal launches the Runner interactively on a Lasso-
 * chosen session id and tracks it by that id only. Opening again relaunches
 * on the held id (Resume); a Runner that names its own session (Codex) is
 * asked for it first. Lasso never checks liveness; the row ends only by a
 * human's act (spec: human Stages). Take over in terminal does the same for
 * a headless Stage, re-entering its last headless Session instead of a new one.
 */
export class Terminal {
  private deps: TerminalDeps;
  private env: NodeJS.ProcessEnv;

  constructor(deps: TerminalDeps) {
    this.deps = deps;
    this.env = deps.env ?? process.env;
  }

  async open(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage, takeOver: TakeOver | null = null): Promise<SessionRow> {
    const { sessions, log } = this.deps;
    const { config, profile, adapter } = await this.resolve(ticket, pipeline, stage);
    let held = sessions.running(ticket.id).find((s) => s.mode === "terminal" && s.stage === stage.name) ?? null;
    // A held Session on another Runner (an override or a config edit moved the Stage) cannot be re-entered in this
    // one: it ends, and a fresh Session opens, as a Retry would. The Resume exit refuses instead (Exits).
    const was = held && (held.opened_at != null || held.runner_session_id != null) ? runnerOf(held) : null;
    const switched = was !== null && was !== profile.profile.runner ? was : null;
    if (switched) {
      sessions.end(held!.id, { ended_by: "human", ended_reason: null, outcome: null, final_message: `${profile.name} runs ${profile.profile.runner}, not ${switched}`, usage: null, cost_usd: null, transcript_path: held!.transcript_path });
      log.info("session.runner_switched", { session: held!.id, ticket: ticket.id, stage: stage.name, from: switched, to: profile.profile.runner });
      held = null;
    }
    const sessionId = held?.id ?? randomUUID();
    const taking = held ? null : takeOver;
    // The row exists before a taken-over run stops, so the tick never sees the Ticket idle in between.
    const row =
      held ??
      sessions.insert({
        id: sessionId,
        ticket: ticket.id,
        stage: stage.name,
        stage_snapshot: JSON.stringify(stage),
        mode: "terminal",
        started_by: "human",
        stdout_path: null,
        limits_honoured: "[]",
        transcript_path: taking ? null : adapter.transcriptPath({ cwd: ticket.worktree, sessionId }),
        profile: sessionProfile(profile.name, profile.profile),
      });
    let reentered = row;
    if (taking) {
      const ended = await taking.stop();
      // The headless chain's earliest id is the session the Runner re-enters; a Runner naming its own may have none.
      const chain = adapter.sessionIds === "lasso" ? (ended.runner_session_id ?? ended.id) : ended.runner_session_id;
      if (chain) reentered = sessions.setRunnerSession(row.id, chain);
      log.info("session.taken_over", { session: row.id, ticket: ticket.id, stage: stage.name, from: ended.id, runnerSession: chain });
    }
    // Resume only a session the Runner has been launched on: a window that opened, or a taken-over headless run.
    const launched = reentered.opened_at != null || reentered.runner_session_id != null ? reentered : null;
    const runnerSessionId = launched ? this.runnerSessionOf(launched, ticket.worktree, adapter) : null;
    // A Runner that names its own session and has not recorded one cannot be re-entered.
    const lost = launched !== null && adapter.sessionIds === "runner" && runnerSessionId === null;
    if (lost || (taking && !launched)) log.warn("session.resume_lost", { session: sessionId, ticket: ticket.id, stage: stage.name, runner: adapter.name });
    const note = lost
      ? `Lasso found no ${adapter.name} session for ${stage.name} since the last window opened; starting afresh.`
      : taking && !launched
        ? `Lasso found no ${adapter.name} session for ${stage.name} to re-enter; starting afresh.`
        : switched
          ? `${stage.name} now runs ${profile.name} on ${adapter.name}, not ${switched}; starting afresh.`
          : null;
    const resume = launched !== null && !lost;
    const opened = await this.launch(config, ticket, stage, profile, adapter, { sessionId, resume, runnerSessionId: runnerSessionId ?? undefined }, sessionId, note);
    log.info(resume ? "session.resumed" : "session.opened", { session: sessionId, ticket: ticket.id, stage: stage.name, launcher: opened.launcher, terminal: opened.terminal });
    return sessions.setOpened(sessionId, new Date().toISOString());
  }

  /**
   * Open the draft: a terminal on a finished Stage's last headless Session while the Ticket holds for Start. The
   * window is the human's: Lasso keeps no row for it, and Start still releases the next Stage.
   */
  async openDraft(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage, from: SessionRow): Promise<void> {
    const { config, profile, adapter } = await this.resolve(ticket, pipeline, stage);
    const chain = adapter.sessionIds === "lasso" ? (from.runner_session_id ?? from.id) : from.runner_session_id;
    if (!chain) throw new TerminalError(`${adapter.name} left no session id for ${stage.name} to re-enter`);
    const opened = await this.launch(config, ticket, stage, profile, adapter, { sessionId: from.id, resume: true, runnerSessionId: chain }, `draft-${from.id}`, null);
    this.deps.log.info("session.draft_opened", { session: from.id, ticket: ticket.id, stage: stage.name, launcher: opened.launcher, terminal: opened.terminal });
  }

  /** The Stage's profile as config now has it (ADR 0011: read at each open), or the Flag that says it is gone. */
  private async resolve(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage) {
    const config = currentConfig(this.deps.home, this.deps.config);
    const profile = ticketProfile(config, ticket, pipeline, stage);
    if ("problem" in profile) {
      await this.deps.flag(ticket.id, "profile.missing", profile.problem);
      throw new TerminalError(profile.problem);
    }
    return { config, profile, adapter: adapterFor(profile.profile.runner) };
  }

  /** Writes the launcher for one interactive run of the Runner and opens it in a window. */
  private async launch(
    config: Config,
    ticket: TicketRow,
    stage: RunnerStage,
    profile: { profile: ProfileSettings },
    adapter: RunnerAdapter,
    session: Pick<RunRequest, "sessionId" | "resume" | "runnerSessionId">,
    file: string,
    note: string | null,
  ): Promise<{ launcher: string; terminal: TerminalKind }> {
    const request: RunRequest = { ...requestFor(ticket, stage, profile.profile, this.deps.links.links(ticket.id)), mode: "terminal", ...session, name: `Lasso: ${ticketLabel(ticket)} ${stage.name}`, limits: {} };
    const command = adapter.command(request);
    const dir = path.join(this.deps.home.ticketsDir, ticket.id, "sessions");
    mkdirSync(dir, { recursive: true });
    const launcher = path.join(dir, `${file}.command`);
    writeFileSync(launcher, launcherScript(command, note), { mode: 0o755 });
    const terminal = await this.openWindow(config.terminal, launcher, request.name!, command.cwd);
    return { launcher, terminal };
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

  /**
   * The id the Runner re-enters for a launched Session: the taken-over run's, or the one a Runner naming its own
   * sessions gave it, kept on the row once found so later opens re-enter the same one. Null for a Lasso-chosen id.
   */
  private runnerSessionOf(row: SessionRow, worktree: string, adapter: RunnerAdapter): string | null {
    if (row.runner_session_id) return row.runner_session_id;
    if (adapter.sessionIds !== "runner") return null;
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
