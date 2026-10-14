import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startLassoWithRepos, waitFor, HERDR_PANE, type Lasso, type LassoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import { chooseTerminal } from "../src/session/openers.ts";
import { neededTools } from "../src/tools/tools.ts";
import { DEFAULT_CONFIG, parseConfig, type Config } from "../src/server/config.ts";
import { renderDoctor } from "../src/cli/doctor.ts";

// Where a human Stage's terminal opens: herdr or tmux when Lasso runs inside
// one, Terminal.app otherwise or when they fail, or what terminal: names.
// The fakes on PATH stand in for all three (osascript for Terminal.app).
const running: Lasso[] = [];
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

async function lassoWithTicket(env: Record<string, string> = {}, config: LassoConfig = {}) {
  const { lasso } = await startLassoWithRepos({ app: { pipeline: "human" } }, config, { human: PIPELINE }, env);
  running.push(lasso);
  const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "human" }) });
  return { lasso, ticket };
}

const openTerminal = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/terminal`, { method: "POST", body: "{}" });
const launcherOf = (lasso: Lasso, ticket: IntakeResult, session: string) => path.join(lasso.home, "tickets", ticket.id, "sessions", `${session}.command`);
const logLines = (lasso: Lasso) => readFileSync(path.join(lasso.home, "lasso.log"), "utf8");

describe("Open terminal inside tmux", () => {
  it("opens a named window in Lasso's tmux session, in the worktree, and again on Resume", async () => {
    const { lasso, ticket } = await lassoWithTicket(TMUX_ENV);
    const opened = await openTerminal(lasso, ticket.id);
    const name = `Lasso: ${ticket.id.slice(-8)} grill`;
    const launcher = launcherOf(lasso, ticket, opened.session!.id);
    expect(await lasso.windows()).toEqual([
      { tool: "tmux", args: ["display-message", "-p", "-t", "%4", "#{session_id}"] },
      { tool: "tmux", args: ["new-window", "-t", "$3:", "-c", ticket.worktree, "-n", name, `'${launcher}'`] },
    ]);
    expect(await lasso.terminals()).toEqual([]);
    expect(readFileSync(launcher, "utf8")).toContain(`exec 'claude' '--session-id' '${opened.session!.id}'`);

    const again = await openTerminal(lasso, ticket.id);
    expect(again.session!.id).toBe(opened.session!.id);
    const calls = await lasso.windows();
    expect(calls).toHaveLength(4);
    expect(calls[3]!.args.at(-1)).toBe(`'${launcher}'`);
    expect(readFileSync(launcher, "utf8")).toContain(`exec 'claude' '--resume' '${opened.session!.id}'`);
    expect(logLines(lasso)).toMatch(/session\.resumed .* terminal=tmux$/m);
  });

  it("falls back to Terminal.app when tmux fails, and logs why", async () => {
    const { lasso, ticket } = await lassoWithTicket(TMUX_ENV);
    await lasso.breakWindows("tmux");
    const opened = await openTerminal(lasso, ticket.id);
    const [window] = await lasso.terminals();
    expect(window!.launcher).toBe(launcherOf(lasso, ticket, opened.session!.id));
    const log = logLines(lasso);
    expect(log).toMatch(/terminal\.fallback terminal=tmux error="could not open a terminal: tmux: no server running/);
    expect(log).toMatch(/session\.opened .* terminal=terminal-app$/m);
  });
});

describe("Open terminal inside herdr", () => {
  it("opens a focused, labelled tab in Lasso's workspace and runs the launcher in its pane", async () => {
    const { lasso, ticket } = await lassoWithTicket({ ...HERDR_ENV, ...TMUX_ENV });
    const opened = await openTerminal(lasso, ticket.id);
    const launcher = launcherOf(lasso, ticket, opened.session!.id);
    expect(await lasso.windows()).toEqual([
      { tool: "herdr", args: ["tab", "create", "--workspace", "w1", "--cwd", ticket.worktree, "--label", `Lasso: ${ticket.id.slice(-8)} grill`, "--focus"] },
      { tool: "herdr", args: ["pane", "run", HERDR_PANE, `'${launcher}'`] },
    ]);
    expect(await lasso.terminals()).toEqual([]);
  });

  it("falls back to Terminal.app with herdr's own message when herdr fails", async () => {
    const { lasso, ticket } = await lassoWithTicket(HERDR_ENV);
    await lasso.breakWindows("herdr");
    await openTerminal(lasso, ticket.id);
    expect(await lasso.terminals()).toHaveLength(1);
    expect(logLines(lasso)).toMatch(/terminal\.fallback terminal=herdr error="could not open a terminal: herdr: no herdr server is running"/);
  });
});

describe("terminal: in config.yaml", () => {
  it("opens Terminal.app outside herdr and tmux", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await openTerminal(lasso, ticket.id);
    expect(await lasso.terminals()).toHaveLength(1);
    expect(await lasso.windows()).toEqual([]);
  });

  it("terminal-app keeps Terminal.app even inside tmux", async () => {
    const { lasso, ticket } = await lassoWithTicket(TMUX_ENV, { terminal: "terminal-app" });
    await openTerminal(lasso, ticket.id);
    expect(await lasso.terminals()).toHaveLength(1);
    expect(await lasso.windows()).toEqual([]);
  });

  it("a named terminal that fails is reported, not swapped for Terminal.app", async () => {
    const { lasso, ticket } = await lassoWithTicket({}, { terminal: "tmux" });
    await lasso.breakWindows("tmux");
    const res = await lasso.api<Response>(`/api/tickets/${ticket.id}/terminal`, { method: "POST", body: "{}", raw: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "could not open a terminal: tmux: no server running on /tmp/tmux-501/default" });
    expect(await lasso.terminals()).toEqual([]);
    // Outside tmux, tmux picks the session: no pane to look up.
    expect((await lasso.windows())[0]!.args.slice(0, 3)).toEqual(["new-window", "-c", ticket.worktree]);
  });

  it("applies a dashboard edit at the next Open terminal, and refuses a value it does not know", async () => {
    const { lasso, ticket } = await lassoWithTicket(TMUX_ENV);
    const saved = await lasso.api<{ config: Config }>("/api/config", { method: "PATCH", body: JSON.stringify({ terminal: "terminal-app" }) });
    expect(saved.config.terminal).toBe("terminal-app");
    expect(readFileSync(path.join(lasso.home, "config.yaml"), "utf8")).toContain("terminal: terminal-app");
    await openTerminal(lasso, ticket.id);
    expect(await lasso.terminals()).toHaveLength(1);

    const bad = await lasso.api<Response>("/api/config", { method: "PATCH", body: JSON.stringify({ terminal: "kitty" }), raw: true });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/terminal must be one of auto, herdr, tmux, terminal-app, not kitty/);
  });

  it("logs at startup where human Stages will open", async () => {
    const { lasso } = await lassoWithTicket(HERDR_ENV);
    await waitFor(async () => /INFO terminal terminal=herdr why="Lasso runs inside herdr \(HERDR_ENV=1\)"/.test(logLines(lasso)), "the terminal line");
  });
});

describe("choosing a terminal", () => {
  it("prefers herdr, then tmux, then Terminal.app; a named one always wins", () => {
    expect(chooseTerminal("auto", { HERDR_ENV: "1", TMUX: "x" })).toEqual({ kind: "herdr", auto: true, why: "Lasso runs inside herdr (HERDR_ENV=1)" });
    expect(chooseTerminal("auto", { TMUX: "x" })).toEqual({ kind: "tmux", auto: true, why: "Lasso runs inside tmux (TMUX is set)" });
    expect(chooseTerminal("auto", {})).toEqual({ kind: "terminal-app", auto: true, why: "Lasso runs outside herdr and tmux" });
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

  it("is the last line of lasso doctor", () => {
    const text = renderDoctor("/h", [], [], [], "1.0.0", chooseTerminal("auto", { TMUX: "x" }));
    expect(text.split("\n").at(-1)).toBe("human Stages open in: a tmux window, as Lasso runs inside tmux (TMUX is set)");
  });
});
