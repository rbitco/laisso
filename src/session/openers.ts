import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalSetting } from "../server/config.ts";
import { appleString, shellQuote } from "../macos.ts";
import { missingFromPath, notOnPath } from "../tools/tools.ts";

const run = promisify(execFile);

export class TerminalError extends Error {}

/** A terminal Laisso can open a window in. */
export type TerminalKind = Exclude<TerminalSetting, "auto">;

/** Puts a launcher script in a new terminal window, tab or pane, in `cwd`, named `name`. */
export interface WindowOpener {
  open(launcher: string, name: string, cwd: string): Promise<void>;
}

/** The terminal a human Stage opens in, and why; `auto` when config left it to Laisso, which may then fall back. */
export interface TerminalChoice {
  kind: TerminalKind;
  auto: boolean;
  why: string;
}

/**
 * Where terminal: sends a human Stage. auto reads the environment Laisso was
 * started in: herdr marks its panes HERDR_ENV=1, tmux sets TMUX; herdr wins
 * when both are set, as the one inside the other is the nearer.
 */
export function chooseTerminal(setting: TerminalSetting, env: NodeJS.ProcessEnv): TerminalChoice {
  if (setting !== "auto") return { kind: setting, auto: false, why: `terminal: ${setting} in config.yaml` };
  if (env.HERDR_ENV === "1") return { kind: "herdr", auto: true, why: "Laisso runs inside herdr (HERDR_ENV=1)" };
  if (env.TMUX) return { kind: "tmux", auto: true, why: "Laisso runs inside tmux (TMUX is set)" };
  return { kind: "terminal-app", auto: true, why: "Laisso runs outside herdr and tmux" };
}

export function openerFor(kind: TerminalKind, env: NodeJS.ProcessEnv): WindowOpener {
  if (kind === "herdr") return herdrTab(env);
  if (kind === "tmux") return tmuxWindow(env);
  return macosTerminal();
}

/** macOS: Terminal.app runs the launcher in a new window and comes to the front. */
export function macosTerminal(): WindowOpener {
  return {
    async open(launcher) {
      // The launcher path is a shell line inside an AppleScript string: quoted for each in turn.
      const script = `tell application "Terminal"\ndo script ${appleString(shellQuote(launcher))}\nactivate\nend tell`;
      await tool("osascript", ["-e", script], process.env);
    },
  };
}

/**
 * tmux: a new window in the session holding Laisso's own pane, which becomes
 * that session's current window. new-window takes no pane as its target, so
 * the pane's session is looked up first; outside tmux, tmux picks the session.
 */
export function tmuxWindow(env: NodeJS.ProcessEnv): WindowOpener {
  return {
    async open(launcher, name, cwd) {
      let target: string[] = [];
      if (env.TMUX_PANE) {
        // A pane that has gone answers nothing rather than failing.
        const session = (await tool("tmux", ["display-message", "-p", "-t", env.TMUX_PANE, "#{session_id}"], env)).trim();
        if (!session) throw new TerminalError(`tmux: Laisso's pane ${env.TMUX_PANE} is gone`);
        target = ["-t", `${session}:`];
      }
      // tmux runs the window's command through sh: the path is quoted for it.
      await tool("tmux", ["new-window", ...target, "-c", cwd, "-n", name, shellQuote(launcher)], env);
    },
  };
}

/**
 * herdr: a new tab in Laisso's workspace, focused, then the launcher typed
 * into its shell. pane run returns once the line is queued, not when it runs.
 */
export function herdrTab(env: NodeJS.ProcessEnv): WindowOpener {
  return {
    async open(launcher, name, cwd) {
      const workspace = env.HERDR_WORKSPACE_ID ? ["--workspace", env.HERDR_WORKSPACE_ID] : [];
      const created = await tool("herdr", ["tab", "create", ...workspace, "--cwd", cwd, "--label", name, "--focus"], env);
      let pane: unknown;
      try {
        pane = (JSON.parse(created) as { result?: { root_pane?: { pane_id?: unknown } } }).result?.root_pane?.pane_id;
      } catch {
        // not JSON; reported below
      }
      if (typeof pane !== "string") throw new TerminalError(`herdr: tab create named no pane: ${created.trim()}`);
      await tool("herdr", ["pane", "run", pane, shellQuote(launcher)], env);
    },
  };
}

/** Runs a terminal's own CLI and returns its stdout, or throws a TerminalError saying what went wrong. */
async function tool(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (await run(command, args, { env })).stdout;
  } catch (error) {
    const e = error as { code?: unknown; stderr?: string; message?: string };
    if (missingFromPath(command, typeof e.code === "string" ? e.code : undefined)) throw new TerminalError(notOnPath(command, "opening a terminal"));
    throw new TerminalError(`could not open a terminal: ${command}: ${reason(e.stderr || e.message || "")}`);
  }
}

/** herdr reports errors as JSON on stderr; the message is what a person needs. */
function reason(stderr: string): string {
  try {
    const message = (JSON.parse(stderr) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string") return message;
  } catch {
    // plain text
  }
  return stderr.trim();
}
