import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import { shortId, type TicketRow } from "../store/tickets.ts";
import type { Sessions, SessionRow } from "../store/sessions.ts";
import type { RunnerStage } from "../pipeline/load.ts";
import { requestFor, type Command, type RunRequest } from "../runner/adapter.ts";
import { adapterFor } from "../runner/adapters.ts";
import { appleString, shellQuote } from "../macos.ts";

const run = promisify(execFile);

export class TerminalError extends Error {}

export interface TerminalDeps {
  home: LassoHome;
  sessions: Sessions;
  log: Logger;
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
 * on the held id (Resume). Lasso never checks liveness; the row ends only by
 * a human's act (spec: human Stages).
 */
export class Terminal {
  private deps: TerminalDeps;
  private opener: WindowOpener;

  constructor(deps: TerminalDeps) {
    this.deps = deps;
    this.opener = deps.opener ?? macosTerminal();
  }

  async open(ticket: TicketRow, stage: RunnerStage): Promise<SessionRow> {
    const { sessions, home, log } = this.deps;
    const adapter = adapterFor(stage.runner);
    const held = sessions.running(ticket.id).find((s) => s.mode === "terminal" && s.stage === stage.name) ?? null;
    const sessionId = held?.id ?? randomUUID();
    const request: RunRequest = {
      ...requestFor(ticket, stage),
      mode: "terminal",
      sessionId,
      // Resume only a session the Runner has been launched on; a row whose window never opened starts afresh.
      resume: held?.opened_at != null,
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
        },
        now,
      );

    const dir = path.join(home.ticketsDir, ticket.id, "sessions");
    mkdirSync(dir, { recursive: true });
    const launcher = path.join(dir, `${sessionId}.command`);
    writeFileSync(launcher, launcherScript(command), { mode: 0o755 });
    await this.opener.open(launcher, request.name!);
    log.info(request.resume ? "session.resumed" : "session.opened", { session: sessionId, ticket: ticket.id, stage: stage.name, launcher });
    return sessions.setOpened(sessionId, new Date().toISOString());
  }
}

/** A shell script that enters the worktree, exports the Ticket context, and becomes the Runner. */
export function launcherScript(command: Command): string {
  return [
    "#!/bin/sh",
    `cd ${shellQuote(command.cwd)} || exit 1`,
    ...Object.entries(command.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`),
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
