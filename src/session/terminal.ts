import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { currentConfig, resolveProfile, type Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import { shortId, type TicketRow } from "../store/tickets.ts";
import { sessionProfile, type Sessions, type SessionRow } from "../store/sessions.ts";
import type { Pipeline, RunnerStage } from "../pipeline/load.ts";
import { requestFor, type Command, type RunRequest, type RunnerAdapter } from "../runner/adapter.ts";
import { adapterFor } from "../runner/adapters.ts";
import { appleString, shellQuote } from "../macos.ts";

const run = promisify(execFile);

export class TerminalError extends Error {}

export interface TerminalDeps {
  config: Config;
  home: LassoHome;
  sessions: Sessions;
  log: Logger;
  /** Flags the Ticket; a Stage whose profile is gone from config cannot open. */
  flag: (ticket: string, reason: string, detail: string) => Promise<void>;
  /** How a command gets a window; defaults to the platform's. */
  opener?: WindowOpener;
}

/** Puts a launcher script in a new terminal window. */
export interface WindowOpener {
  open(launcher: string, name: string): Promise<void>;
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
  private opener: WindowOpener;

  constructor(deps: TerminalDeps) {
    this.deps = deps;
    this.opener = deps.opener ?? macosTerminal();
  }

  async open(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage): Promise<SessionRow> {
    const { sessions, home, log } = this.deps;
    // Read at each open, as for headless Sessions (ADR 0011): an edit to the profile reaches the next window.
    const profile = resolveProfile(currentConfig(home, this.deps.config), pipeline, stage);
    if ("problem" in profile) {
      await this.deps.flag(ticket.id, "profile.missing", profile.problem);
      throw new TerminalError(profile.problem);
    }
    const adapter = adapterFor(profile.profile.runner);
    const held = sessions.running(ticket.id).find((s) => s.mode === "terminal" && s.stage === stage.name) ?? null;
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
    const note = lost ? `Lasso found no ${adapter.name} session for ${stage.name} since the last window opened; starting afresh.` : null;
    writeFileSync(launcher, launcherScript(command, note), { mode: 0o755 });
    await this.opener.open(launcher, request.name!);
    log.info(request.resume ? "session.resumed" : "session.opened", { session: sessionId, ticket: ticket.id, stage: stage.name, launcher });
    return sessions.setOpened(sessionId, new Date().toISOString());
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

/** macOS: Terminal.app runs the launcher in a new window and comes to the front. */
export function macosTerminal(): WindowOpener {
  return {
    async open(launcher) {
      // The launcher path is a shell line inside an AppleScript string: quoted for each in turn.
      const script = `tell application "Terminal"\ndo script ${appleString(shellQuote(launcher))}\nactivate\nend tell`;
      try {
        await run("osascript", ["-e", script]);
      } catch (error) {
        const e = error as { stderr?: string; message?: string };
        throw new TerminalError(`could not open a terminal: ${(e.stderr || e.message || "").trim()}`);
      }
    },
  };
}
