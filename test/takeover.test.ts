import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startLassoWithRepos, waitFor, claudeFixture, runnerFixture, type Lasso, type LassoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Take over in terminal (LASSO-105): a human steps into a headless Stage's Session, running or Flagged, on its own
// session id, and works the Stage as a human Stage from there; at a Start gate, the finished Stage's Session opens
// in a terminal while Start stays the approval. The fakes on PATH stand in for the Runners and Terminal.app.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: plan
    prompt: Draft a plan in PLAN.md.
    advance: false
    artifact: file PLAN.md
  - name: act
    prompt: Carry the plan out.
    artifact: file DONE.md
`;

async function lassoWithTicket(config: LassoConfig = {}) {
  const started = await startLassoWithRepos({ app: { pipeline: "gated" } }, config, { gated: PIPELINE });
  running.push(started.lasso);
  const ticket = await started.lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "gated" }) });
  return { lasso: started.lasso, ticket };
}

const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const pull = (lasso: Lasso, id: string, lever: string, body: object = {}) => lasso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const runningSession = (lasso: Lasso, id: string) => waitFor(async () => { const t = await detailOf(lasso, id); return t.session?.running && t.session.mode === "headless" ? t.session : null; }, "the headless Session to run");
const launcherText = (launcher: string | null) => readFileSync(launcher!, "utf8");
/** The fake Runner has started, and written what it was scripted to, before anything takes its Session over. */
const underWay = (lasso: Lasso, id: string, session: string, text = "") =>
  waitFor(async () => (await lasso.runner.calls()).length > 0 && (await lasso.api<{ text: string }>(`/api/tickets/${id}/sessions/${session}/stdout`)).text.includes(text), "the Runner to start");

describe("Take over in terminal", () => {
  it("stops a running Claude Session, re-enters its session in a terminal, and is worked as a human Stage", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ hang: true });
    await checkNow(lasso);
    const headless = await runningSession(lasso, ticket.id);
    await underWay(lasso, ticket.id, headless.id);
    expect((await detailOf(lasso, ticket.id)).triggers).toEqual([
      { action: "takeover", label: "Take over in terminal" },
      { action: "abandon", label: "Abandon" },
    ]);

    const taken = await pull(lasso, ticket.id, "takeover");
    expect(taken.flag).toBeNull();
    expect(taken.session).toMatchObject({ stage: "plan", mode: "terminal", startedBy: "human", running: true, runnerSessionId: headless.id });
    expect(taken.display).toMatchObject({ state: "needs_you" });
    expect(taken.display.why).toMatch(/^taken over; terminal opened \d\d:\d\d$/);
    expect(taken.triggers.map((t) => t.action)).toEqual(["terminal", "done", "skip", "abandon"]);
    const stopped = taken.sessions.find((s) => s.id === headless.id)!;
    expect(stopped).toMatchObject({ running: false, outcome: "interrupted", endedReason: "stop", finalMessage: "taken over in a terminal" });

    const [window] = await lasso.terminals();
    expect(launcherText(window!.launcher)).toContain(`exec 'claude' '--resume' '${headless.id}' '--permission-mode' 'acceptEdits'`);
    // The terminal holds the Stage: the tick starts nothing, and opening again re-enters the same session.
    expect((await checkNow(lasso)).changes).toEqual([]);
    const again = await pull(lasso, ticket.id, "terminal");
    expect(again.session!.id).toBe(taken.session!.id);
    const windows = await lasso.terminals();
    expect(windows).toHaveLength(2);
    expect(launcherText(windows[1]!.launcher)).toContain(`'--resume' '${headless.id}'`);
    expect(await lasso.runner.calls()).toHaveLength(1);

    // Mark done checks the artifact and finishes the Stage; plan says advance: false, so act waits for Start.
    writeFileSync(path.join(ticket.worktree, "PLAN.md"), "the plan\n");
    const done = await pull(lasso, ticket.id, "done");
    expect(done.stage.name).toBe("act");
    expect(done.display.state).toBe("holding");
    expect(done.session).toMatchObject({ id: taken.session!.id, running: false, endedBy: "human" });
  });

  it("takes over a Flagged Stage, clearing the Flag, without stopping anything", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(lasso);
    const flagged = await waitFor(async () => { const t = await detailOf(lasso, ticket.id); return t.flag ? t : null; }, "the Flag");
    const failed = flagged.session!;
    expect(flagged.triggers.map((t) => t.action)).toEqual(["retry", "resume", "takeover", "extend", "done", "skip", "abandon"]);

    const taken = await pull(lasso, ticket.id, "takeover");
    expect(taken.flag).toBeNull();
    expect(taken.session).toMatchObject({ mode: "terminal", running: true, runnerSessionId: failed.runnerSessionId ?? failed.id });
    expect(launcherText((await lasso.terminals())[0]!.launcher)).toContain(`'--resume' '${failed.runnerSessionId ?? failed.id}'`);
    const skipped = await pull(lasso, ticket.id, "skip");
    expect(skipped.display.state).toBe("holding");
  });

  it("re-enters a Codex Session on the thread id it reported", async () => {
    const config: LassoConfig = { profiles: { "codex-high": { runner: "codex", model: "gpt-6-sol" } }, default_profile: "codex-high" };
    const { lasso, ticket } = await lassoWithTicket(config);
    const stdout = runnerFixture("codex", "killed.jsonl");
    const thread = /"thread_id":"([^"]+)"/.exec(stdout)![1]!;
    await lasso.runner.script({ stdout, hang: true });
    await checkNow(lasso);
    await underWay(lasso, ticket.id, (await runningSession(lasso, ticket.id)).id, thread);
    const taken = await pull(lasso, ticket.id, "takeover");
    expect(taken.session).toMatchObject({ mode: "terminal", runnerSessionId: thread });
    expect(launcherText((await lasso.terminals())[0]!.launcher)).toContain(`exec 'codex' 'resume' '${thread}'`);
  });

  it("is refused on a Stage with no Session yet", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    expect(ticket.triggers.map((t) => t.action)).toEqual(["abandon"]);
    const res = await lasso.api<Response>(`/api/tickets/${ticket.id}/takeover`, { method: "POST", body: "{}", raw: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no Session of plan to take over yet");
  });
});

describe("Open the draft at a Start gate", () => {
  it("opens the finished Stage's Session in a terminal, keeps no row for it, and Start still releases the next Stage", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ stdout: claudeFixture("success.json"), files: { "PLAN.md": "the plan\n" } });
    await checkNow(lasso);
    const holding = await waitFor(async () => { const t = await detailOf(lasso, ticket.id); return t.display.state === "holding" ? t : null; }, "the gate");
    expect(holding.triggers).toEqual([
      { action: "start", label: "Start act" },
      { action: "draft", label: "Open plan in terminal" },
      { action: "abandon", label: "Abandon" },
    ]);
    const plan = holding.session!;

    const opened = await pull(lasso, ticket.id, "draft");
    expect(opened.display.state).toBe("holding");
    expect(opened.sessions).toHaveLength(1);
    const [window] = await lasso.terminals();
    expect(window!.launcher).toBe(`${lasso.home}/tickets/${ticket.id}/sessions/draft-${plan.id}.command`);
    expect(launcherText(window!.launcher)).toContain(`exec 'claude' '--resume' '${plan.runnerSessionId ?? plan.id}'`);

    await lasso.runner.script({ hang: true });
    const started = await pull(lasso, ticket.id, "start");
    expect(started.display.state).not.toBe("holding");
    await runningSession(lasso, ticket.id);
  });
});
