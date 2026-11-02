import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startLaissoWithRepos, waitFor, HERDR_PANE, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import { chooseTerminal } from "../src/session/openers.ts";
import { neededTools } from "../src/tools/tools.ts";
import { DEFAULT_CONFIG, parseConfig, type Config } from "../src/server/config.ts";
import { renderDoctor } from "../src/cli/doctor.ts";

// Where a human Stage's terminal opens: herdr or tmux when Laisso runs inside
// one, Terminal.app otherwise or when they fail, or what terminal: names.
// The fakes on PATH stand in for all three (osascript for Terminal.app).
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: grill
    prompt: Interview me about the Ticket.
    human: true
`;

const TMUX_ENV = { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%4" };
const HERDR_ENV = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1" };

async function laissoWithTicket(env: Record<string, string> = {}, config: LaissoConfig = {}) {
  const { laisso } = await startLaissoWithRepos({ app: { pipeline: "human" } }, config, { human: PIPELINE }, env);
  running.push(laisso);
  const ticket = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "human" }) });
  return { laisso, ticket };
}

const openTerminal = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}/terminal`, { method: "POST", body: "{}" });
const launcherOf = (laisso: Laisso, ticket: IntakeResult, session: string) => path.join(laisso.home, "tickets", ticket.id, "sessions", `${session}.command`);
const logLines = (laisso: Laisso) => readFileSync(path.join(laisso.home, "laisso.log"), "utf8");

describe("Open terminal inside tmux", () => {
  it("opens a named window in Laisso's tmux session, in the worktree, and again on Resume", async () => {
    const { laisso, ticket } = await laissoWithTicket(TMUX_ENV);
    const opened = await openTerminal(laisso, ticket.id);
    const name = `Laisso: ${ticket.id.slice(-8)} grill`;
    const launcher = launcherOf(laisso, ticket, opened.session!.id);
    expect(await laisso.windows()).toEqual([
      { tool: "tmux", args: ["display-message", "-p", "-t", "%4", "#{session_id}"] },
      { tool: "tmux", args: ["new-window", "-t", "$3:", "-c", ticket.worktree, "-n", name, `'${launcher}'`] },
    ]);
    expect(await laisso.terminals()).toEqual([]);
    expect(readFileSync(launcher, "utf8")).toContain(`exec 'claude' '--session-id' '${opened.session!.id}'`);

    const again = await openTerminal(laisso, ticket.id);
    expect(again.session!.id).toBe(opened.session!.id);
    const calls = await laisso.windows();
    expect(calls).toHaveLength(4);
    expect(calls[3]!.args.at(-1)).toBe(`'${launcher}'`);
    expect(readFileSync(launcher, "utf8")).toContain(`exec 'claude' '--resume' '${opened.session!.id}'`);
    expect(logLines(laisso)).toMatch(/session\.resumed .* terminal=tmux$/m);
  });

  it("falls back to Terminal.app when tmux fails, and logs why", async () => {
    const { laisso, ticket } = await laissoWithTicket(TMUX_ENV);
    await laisso.breakWindows("tmux");
    const opened = await openTerminal(laisso, ticket.id);
    const [window] = await laisso.terminals();
    expect(window!.launcher).toBe(launcherOf(laisso, ticket, opened.session!.id));
    const log = logLines(laisso);
    expect(log).toMatch(/terminal\.fallback terminal=tmux error="could not open a terminal: tmux: no server running/);
    expect(log).toMatch(/session\.opened .* terminal=terminal-app$/m);
  });
});

describe("Open terminal inside herdr", () => {
  it("opens a focused, labelled tab in Laisso's workspace and runs the launcher in its pane", async () => {
    const { laisso, ticket } = await laissoWithTicket({ ...HERDR_ENV, ...TMUX_ENV });
    const opened = await openTerminal(laisso, ticket.id);
    const launcher = launcherOf(laisso, ticket, opened.session!.id);
    expect(await laisso.windows()).toEqual([
      { tool: "herdr", args: ["tab", "create", "--workspace", "w1", "--cwd", ticket.worktree, "--label", `Laisso: ${ticket.id.slice(-8)} grill`, "--focus"] },
      { tool: "herdr", args: ["pane", "run", HERDR_PANE, `'${launcher}'`] },
    ]);
    expect(await laisso.terminals()).toEqual([]);
  });

  it("falls back to Terminal.app with herdr's own message when herdr fails", async () => {
    const { laisso, ticket } = await laissoWithTicket(HERDR_ENV);
    await laisso.breakWindows("herdr");
    await openTerminal(laisso, ticket.id);
    expect(await laisso.terminals()).toHaveLength(1);
    expect(logLines(laisso)).toMatch(/terminal\.fallback terminal=herdr error="could not open a terminal: herdr: no herdr server is running"/);
  });
});

describe("terminal: in config.yaml", () => {
  it("opens Terminal.app outside herdr and tmux", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await openTerminal(laisso, ticket.id);
    expect(await laisso.terminals()).toHaveLength(1);
    expect(await laisso.windows()).toEqual([]);
  });

  it("terminal-app keeps Terminal.app even inside tmux", async () => {
    const { laisso, ticket } = await laissoWithTicket(TMUX_ENV, { terminal: "terminal-app" });
    await openTerminal(laisso, ticket.id);
    expect(await laisso.terminals()).toHaveLength(1);
    expect(await laisso.windows()).toEqual([]);
  });

  it("a named terminal that fails is reported, not swapped for Terminal.app", async () => {
    const { laisso, ticket } = await laissoWithTicket({}, { terminal: "tmux" });
    await laisso.breakWindows("tmux");
    const res = await laisso.api<Response>(`/api/tickets/${ticket.id}/terminal`, { method: "POST", body: "{}", raw: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "could not open a terminal: tmux: no server running on /tmp/tmux-501/default" });
    expect(await laisso.terminals()).toEqual([]);
    // Outside tmux, tmux picks the session: no pane to look up.
    expect((await laisso.windows())[0]!.args.slice(0, 3)).toEqual(["new-window", "-c", ticket.worktree]);
  });

  it("applies a dashboard edit at the next Open terminal, and refuses a value it does not know", async () => {
    const { laisso, ticket } = await laissoWithTicket(TMUX_ENV);
    const saved = await laisso.api<{ config: Config }>("/api/config", { method: "PATCH", body: JSON.stringify({ terminal: "terminal-app" }) });
    expect(saved.config.terminal).toBe("terminal-app");
    expect(readFileSync(path.join(laisso.home, "config.yaml"), "utf8")).toContain("terminal: terminal-app");
    await openTerminal(laisso, ticket.id);
    expect(await laisso.terminals()).toHaveLength(1);

    const bad = await laisso.api<Response>("/api/config", { method: "PATCH", body: JSON.stringify({ terminal: "kitty" }), raw: true });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/terminal must be one of auto, herdr, tmux, terminal-app, not kitty/);
  });

  it("logs at startup where human Stages will open", async () => {
    const { laisso } = await laissoWithTicket(HERDR_ENV);
    await waitFor(async () => /INFO terminal terminal=herdr why="Laisso runs inside herdr \(HERDR_ENV=1\)"/.test(logLines(laisso)), "the terminal line");
  });
});

describe("Set up Laisso", () => {
  it("opens laisso setup in a terminal, in the home, with the Laisso skill installed first", async () => {
    const userHome = mkdtempSync(path.join(tmpdir(), "laisso-user-"));
    const { laisso } = await startLaissoWithRepos({}, {}, {}, { HOME: userHome });
    running.push(laisso);
    const opened = await laisso.api<{ launcher: string; terminal: string; profile: string }>("/api/setup", { method: "POST", body: "{}" });
    expect(opened).toEqual({ launcher: path.join(laisso.home, "setup.command"), terminal: "terminal-app", profile: "claude" });
    expect((await laisso.terminals()).map((t) => t.launcher)).toEqual([opened.launcher]);
    const script = readFileSync(opened.launcher, "utf8");
    expect(script).toContain(`cd '${laisso.home}'`);
    expect(script).toContain("exec 'claude' '--permission-mode'");
    expect(existsSync(path.join(userHome, ".claude", "skills", "laisso", "SKILL.md"))).toBe(true);
    expect(logLines(laisso)).toMatch(/setup\.opened .* terminal=terminal-app profile=claude$/m);
  });
});

describe("choosing a terminal", () => {
  it("prefers herdr, then tmux, then Terminal.app; a named one always wins", () => {
    expect(chooseTerminal("auto", { HERDR_ENV: "1", TMUX: "x" })).toEqual({ kind: "herdr", auto: true, why: "Laisso runs inside herdr (HERDR_ENV=1)" });
    expect(chooseTerminal("auto", { TMUX: "x" })).toEqual({ kind: "tmux", auto: true, why: "Laisso runs inside tmux (TMUX is set)" });
    expect(chooseTerminal("auto", {})).toEqual({ kind: "terminal-app", auto: true, why: "Laisso runs outside herdr and tmux" });
    expect(chooseTerminal("tmux", { HERDR_ENV: "1" })).toEqual({ kind: "tmux", auto: false, why: "terminal: tmux in config.yaml" });
  });

  it("defaults to auto and rejects anything else", () => {
    expect(parseConfig("", "c.yaml").terminal).toBe("auto");
    expect(parseConfig("terminal: herdr", "c.yaml").terminal).toBe("herdr");
    expect(() => parseConfig("terminal: iterm", "c.yaml")).toThrow("c.yaml: terminal must be one of auto, herdr, tmux, terminal-app, not iterm");
  });

  it("needs tmux or herdr only when config names it", () => {
    const tools = (terminal: Config["terminal"]) => neededTools({ config: { ...DEFAULT_CONFIG, terminal }, pipelines: [], tickets: [] }).map((t) => t.name);
    expect(tools("auto")).not.toContain("tmux");
    expect(tools("tmux")).toContain("tmux");
    expect(tools("herdr")).toContain("herdr");
  });

  it("is the last line of laisso doctor", () => {
    const text = renderDoctor("/h", [], [], [], "1.0.0", chooseTerminal("auto", { TMUX: "x" }));
    expect(text.split("\n").at(-1)).toBe("human Stages open in: a tmux window, as Laisso runs inside tmux (TMUX is set)");
  });
});
