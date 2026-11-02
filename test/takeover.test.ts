import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startLaissoWithRepos, waitFor, claudeFixture, runnerFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";
import { setScene, type Scene } from "./scenes.ts";

// Take over in terminal (LASSO-105): a human steps into a headless Stage's Session, running or Flagged, on its own
// session id, and works the Stage as a human Stage from there; Hand back (LASSO-107) returns it to Laisso. At a Start
// gate, the finished Stage's Session opens in a terminal while Start stays the approval. The fakes on PATH stand in
// for the Runners, the PR and Terminal.app.
const running: Laisso[] = [];
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

async function laissoWithTicket(config: LaissoConfig = {}) {
  const started = await startLaissoWithRepos({ app: { pipeline: "gated" } }, config, { gated: PIPELINE });
  running.push(started.laisso);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "gated" }) });
  return { laisso: started.laisso, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const pull = (laisso: Laisso, id: string, lever: string, body: object = {}) => laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const runningSession = (laisso: Laisso, id: string) => waitFor(async () => { const t = await detailOf(laisso, id); return t.session?.running && t.session.mode === "headless" ? t.session : null; }, "the headless Session to run");
const launches = (laisso: Laisso, count: number) => waitFor(async () => { const c = await laisso.runner.calls(); return c.length >= count ? c : null; }, `${count} Runner launches`);
const launcherText = (launcher: string | null) => readFileSync(launcher!, "utf8");
/** The fake Runner has started, and written what it was scripted to, before anything takes its Session over. */
const underWay = (laisso: Laisso, id: string, session: string, text = "") =>
  waitFor(async () => (await laisso.runner.calls()).length > 0 && (await laisso.api<{ text: string }>(`/api/tickets/${id}/sessions/${session}/stdout`)).text.includes(text), "the Runner to start");

describe("Take over in terminal", () => {
  it("stops a running Claude Session, re-enters its session in a terminal, and is worked as a human Stage", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    const headless = await runningSession(laisso, ticket.id);
    await underWay(laisso, ticket.id, headless.id);
    expect((await detailOf(laisso, ticket.id)).triggers).toEqual([
      { action: "takeover", label: "Take over in terminal" },
      { action: "abandon", label: "Abandon" },
    ]);

    const taken = await pull(laisso, ticket.id, "takeover");
    expect(taken.flag).toBeNull();
    expect(taken.session).toMatchObject({ stage: "plan", mode: "terminal", startedBy: "human", running: true, runnerSessionId: headless.id });
    expect(taken.display).toMatchObject({ state: "needs_you" });
    expect(taken.display.why).toMatch(/^taken over; terminal opened \d\d:\d\d$/);
    expect(taken.triggers.map((t) => t.action)).toEqual(["terminal", "handback", "done", "skip", "abandon"]);
    const stopped = taken.sessions.find((s) => s.id === headless.id)!;
    expect(stopped).toMatchObject({ running: false, outcome: "interrupted", endedReason: "stop", finalMessage: "taken over in a terminal" });

    const [window] = await laisso.terminals();
    expect(launcherText(window!.launcher)).toContain(`exec 'claude' '--resume' '${headless.id}' '--permission-mode' 'acceptEdits'`);
    // The terminal holds the Stage: the tick starts nothing, and opening again re-enters the same session.
    expect((await checkNow(laisso)).changes).toEqual([]);
    const again = await pull(laisso, ticket.id, "terminal");
    expect(again.session!.id).toBe(taken.session!.id);
    const windows = await laisso.terminals();
    expect(windows).toHaveLength(2);
    expect(launcherText(windows[1]!.launcher)).toContain(`'--resume' '${headless.id}'`);
    expect(await laisso.runner.calls()).toHaveLength(1);

    // Mark done checks the artifact and finishes the Stage; plan says advance: false, so act waits for Start.
    writeFileSync(path.join(ticket.worktree, "PLAN.md"), "the plan\n");
    const done = await pull(laisso, ticket.id, "done");
    expect(done.stage.name).toBe("act");
    expect(done.display.state).toBe("holding");
    expect(done.session).toMatchObject({ id: taken.session!.id, running: false, endedBy: "human" });
  });

  it("takes over a Flagged Stage, clearing the Flag, without stopping anything", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    const flagged = await waitFor(async () => { const t = await detailOf(laisso, ticket.id); return t.flag ? t : null; }, "the Flag");
    const failed = flagged.session!;
    expect(flagged.triggers.map((t) => t.action)).toEqual(["retry", "resume", "takeover", "extend", "done", "skip", "abandon"]);

    const taken = await pull(laisso, ticket.id, "takeover");
    expect(taken.flag).toBeNull();
    expect(taken.session).toMatchObject({ mode: "terminal", running: true, runnerSessionId: failed.runnerSessionId ?? failed.id });
    expect(launcherText((await laisso.terminals())[0]!.launcher)).toContain(`'--resume' '${failed.runnerSessionId ?? failed.id}'`);
    const skipped = await pull(laisso, ticket.id, "skip");
    expect(skipped.display.state).toBe("holding");
  });

  it("re-enters a Codex Session on the thread id it reported", async () => {
    const config: LaissoConfig = { profiles: { "codex-high": { runner: "codex", model: "gpt-6-sol" } }, default_profile: "codex-high" };
    const { laisso, ticket } = await laissoWithTicket(config);
    const stdout = runnerFixture("codex", "killed.jsonl");
    const thread = /"thread_id":"([^"]+)"/.exec(stdout)![1]!;
    await laisso.runner.script({ stdout, hang: true });
    await checkNow(laisso);
    await underWay(laisso, ticket.id, (await runningSession(laisso, ticket.id)).id, thread);
    const taken = await pull(laisso, ticket.id, "takeover");
    expect(taken.session).toMatchObject({ mode: "terminal", runnerSessionId: thread });
    expect(launcherText((await laisso.terminals())[0]!.launcher)).toContain(`exec 'codex' 'resume' '${thread}'`);
  });

  it("is refused on a Stage with no Session yet", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    expect(ticket.triggers.map((t) => t.action)).toEqual(["skip", "abandon"]);
    const res = await laisso.api<Response>(`/api/tickets/${ticket.id}/takeover`, { method: "POST", body: "{}", raw: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no Session of plan to take over yet");
  });
});

describe("Hand back", () => {
  it("ends the terminal and starts a headless Session re-entering its session, spending no attempt", async () => {
    const { laisso, ticket } = await laissoWithTicket({ budget: { attempts: 2 } });
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    const headless = await runningSession(laisso, ticket.id);
    await underWay(laisso, ticket.id, headless.id);
    const taken = await pull(laisso, ticket.id, "takeover");

    await laisso.runner.script({ stdout: claudeFixture("success.json"), files: { "PLAN.md": "the plan\n" } });
    const handed = await pull(laisso, ticket.id, "handback");
    const terminal = handed.sessions.find((s) => s.id === taken.session!.id)!;
    expect(terminal).toMatchObject({ running: false, endedBy: "human", endedReason: "stop", finalMessage: "handed back to Laisso" });
    expect(handed.session).toMatchObject({ stage: "plan", mode: "headless", startedBy: "human" });
    const calls = await launches(laisso, 2);
    expect(calls[1]!.argv).toEqual(expect.arrayContaining(["--resume", headless.id]));

    // The stopped run and the resumed one are the two attempts; the terminal between them is not a third.
    const done = await waitFor(async () => { const t = await detailOf(laisso, ticket.id); return t.display.state === "holding" ? t : null; }, "plan to finish");
    expect(done.flag).toBeNull();
    expect(done.stage.name).toBe("act");
  });

  it("is refused on a Stage nobody took over", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const res = await laisso.api<Response>(`/api/tickets/${ticket.id}/handback`, { method: "POST", body: "{}", raw: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("plan is not taken over in a terminal; there is nothing to hand back");
  });

  it("returns a Review Stage to Rounds: Feedback that came in while taken over opens the next Round", async () => {
    const started = await startLaissoWithRepos({ app: { pipeline: "loop" } }, {}, { loop: "stages:\n  - name: review\n    prompt: Address the Feedback.\n    repeat: feedback\n    artifact: pr-merged\n" });
    running.push(started.laisso);
    const laisso = started.laisso;
    const ticket = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "loop" }) });
    const asked: Scene = { tag: "asked", comments: [{ id: 201, author: "bob", body: "Please add a changelog entry.", at: "2026-09-27T10:05:00Z" }] };
    await setScene(laisso, ticket.branch, asked);
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    const round1 = await runningSession(laisso, ticket.id);
    expect(round1.round).toBe(1);
    await underWay(laisso, ticket.id, round1.id);
    await pull(laisso, ticket.id, "takeover");

    // While the terminal holds the Stage the PR is still read, but no Round starts.
    await setScene(laisso, ticket.branch, { tag: "more", comments: [...asked.comments!, { id: 203, author: "carol", body: "And a test, please.", at: "2026-09-27T11:00:00Z" }] });
    const polled = await checkNow(laisso);
    expect(polled.changes).toEqual([{ ticket: ticket.id, summary: "PR #7: 1 new Feedback item: comment by carol" }]);
    expect(await laisso.runner.calls()).toHaveLength(1);

    const handed = await pull(laisso, ticket.id, "handback");
    expect(handed.session).toMatchObject({ mode: "headless", round: 2, running: true });
    const calls = await launches(laisso, 2);
    // The Round carries everything still outstanding: the new comment, and the one nobody answered in the terminal.
    expect(calls[1]!.argv[2]).toContain("Round 2: 2 items.");
    expect(calls[1]!.argv[2]).toContain("> And a test, please.");
  });
});

describe("Open the draft at a Start gate", () => {
  it("opens the finished Stage's Session in a terminal, keeps no row for it, and Start still releases the next Stage", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("success.json"), files: { "PLAN.md": "the plan\n" } });
    await checkNow(laisso);
    const holding = await waitFor(async () => { const t = await detailOf(laisso, ticket.id); return t.display.state === "holding" ? t : null; }, "the gate");
    expect(holding.triggers).toEqual([
      { action: "start", label: "Start act" },
      { action: "draft", label: "Open plan in terminal" },
      { action: "skip", label: "Skip act" },
      { action: "abandon", label: "Abandon" },
    ]);
    const plan = holding.session!;

    const opened = await pull(laisso, ticket.id, "draft");
    expect(opened.display.state).toBe("holding");
    expect(opened.sessions).toHaveLength(1);
    const [window] = await laisso.terminals();
    expect(window!.launcher).toBe(`${laisso.home}/tickets/${ticket.id}/sessions/draft-${plan.id}.command`);
    expect(launcherText(window!.launcher)).toContain(`exec 'claude' '--resume' '${plan.runnerSessionId ?? plan.id}'`);

    await laisso.runner.script({ hang: true });
    const started = await pull(laisso, ticket.id, "start");
    expect(started.display.state).not.toBe("holding");
    await runningSession(laisso, ticket.id);
  });
});
