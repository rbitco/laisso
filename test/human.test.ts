import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startLaissoWithRepos, startLaisso, runCli, waitFor, claudeFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";
import { showTicket } from "../src/notify/notifier.ts";

// Seam one again: a human Stage from intake through Open terminal, Mark done,
// Skip and the Start gate, watched through the API and the fakes on PATH
// (osascript stands in for Terminal.app, terminal-notifier for notifications).
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: grill
    prompt: Interview me about the Ticket.
    skills: [grilling]
    human: true
    advance: false
    artifact: file SPEC.md
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    human: true
    artifact: file NOTES.md
`;

async function laissoWithTicket(config: LaissoConfig = {}, pipeline = PIPELINE) {
  const started = await startLaissoWithRepos({ app: { pipeline: "human" } }, config, { human: pipeline });
  running.push(started.laisso);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", {
    method: "POST",
    body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "human" }),
  });
  return { ...started, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const pull = (laisso: Laisso, id: string, lever: string, body: object = {}) =>
  laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const notified = (laisso: Laisso, count: number) =>
  waitFor(async () => { const n = await laisso.notifications(); return n.length >= count ? n : null; }, `${count} notifications`);

describe("a human Stage", () => {
  it("needs you from intake, opens a named terminal Session, and resumes it on the held id", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    expect(ticket.display).toEqual({ state: "needs_you", label: "Needs you", why: "not started" });
    expect(ticket.triggers).toEqual([
      { action: "terminal", label: "Open terminal" },
      { action: "done", label: "Mark grill done" },
      { action: "skip", label: "Skip grill" },
      { action: "abandon", label: "Abandon" },
    ]);
    const [hello] = await notified(laisso, 1);
    expect(hello).toEqual({ title: "Add dark mode", body: "grill needs you", click: showTicket(laisso.url, `${laisso.url}/#${ticket.id}`) });

    // check-now leaves a human Stage alone: nothing to run headless.
    expect((await laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" })).changes).toEqual([]);

    const opened = await pull(laisso, ticket.id, "terminal");
    expect(opened.display.state).toBe("needs_you");
    expect(opened.display.why).toMatch(/^terminal opened \d\d:\d\d$/);
    expect(opened.session).toMatchObject({ stage: "grill", ordinal: 1, mode: "terminal", startedBy: "human", running: true, outcome: null, stdoutPath: null });
    expect(opened.session!.openedAt).toBeTruthy();
    expect(opened.session!.transcriptPath).toContain(`${opened.session!.id}.jsonl`);

    const [first] = await laisso.terminals();
    expect(first!.script).toContain('tell application "Terminal"');
    expect(first!.launcher).toBe(`${laisso.home}/tickets/${ticket.id}/sessions/${opened.session!.id}.command`);
    const launcher = readFileSync(first!.launcher!, "utf8");
    expect(launcher).toContain(`cd '${ticket.worktree}'`);
    expect(launcher).toContain(`export LAISSO_TICKET='${ticket.id}'`);
    expect(launcher).toContain(`export LAISSO_STAGE='grill'`);
    expect(launcher).toContain(`exec 'claude' '--session-id' '${opened.session!.id}' '--permission-mode' 'acceptEdits' '--name' 'Laisso: ${ticket.id.slice(-8)} grill'`);
    expect(launcher).toContain("/grilling");
    expect(launcher).toContain("Add dark mode");

    // Open terminal again: the same row, relaunched on the held id.
    const again = await pull(laisso, ticket.id, "terminal");
    expect(again.session!.id).toBe(opened.session!.id);
    expect(again.sessions).toHaveLength(1);
    const calls = await laisso.terminals();
    expect(calls).toHaveLength(2);
    expect(readFileSync(calls[1]!.launcher!, "utf8")).toContain(`exec 'claude' '--resume' '${opened.session!.id}' '--permission-mode' 'acceptEdits'\n`);

    // The Runner exiting (or never starting) does not end the row.
    const still = await detailOf(laisso, ticket.id);
    expect(still.session!.running).toBe(true);
    // A terminal Session adds nothing to wall time or spend, so the gauges say so.
    expect([still.budget.wallTime.untracked, still.budget.spend.untracked, still.budget.attempts.untracked]).toEqual([true, true, undefined]);

    const cli = await runCli(["status", ticket.id], laisso);
    expect(cli.stdout).toContain("Needs you");
    expect(cli.stdout).toContain("grill #1  terminal  running");
    expect(cli.stdout).toContain("levers:    Open terminal · Mark grill done · Skip grill");
  });

  it("warns on a missing artifact, advances on override, holds for Start, and notifies each event once", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await notified(laisso, 1);
    await pull(laisso, ticket.id, "terminal");

    const refused = await laisso.api<Response>(`/api/tickets/${ticket.id}/done`, { method: "POST", body: "{}", raw: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "file SPEC.md: SPEC.md does not exist in the worktree", artifact: "file SPEC.md", detail: "SPEC.md does not exist in the worktree", override: true });
    expect((await detailOf(laisso, ticket.id)).stage.name).toBe("grill");

    const held = await pull(laisso, ticket.id, "done", { override: true });
    expect(held.stage.name).toBe("implement");
    expect(held.display).toEqual({ state: "holding", label: "Holding", why: "Start implement when ready" });
    expect(held.triggers).toEqual([{ action: "start", label: "Start implement" }, { action: "skip", label: "Skip implement" }, { action: "abandon", label: "Abandon" }]);
    expect(held.session).toMatchObject({ stage: "grill", mode: "terminal", running: false, endedBy: "human", endedReason: null, outcome: null });
    const [, gate] = await notified(laisso, 2);
    expect(gate).toMatchObject({ title: "Add dark mode", body: "grill finished; Start implement when ready" });

    // Holding: the tick does not start implement on its own.
    expect((await laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" })).changes).toEqual([]);
    const holding = await laisso.api<Response>(`/api/tickets/${ticket.id}/terminal`, { method: "POST", raw: true });
    expect(holding.status).toBe(400);
    expect(await holding.json()).toEqual({ error: `Ticket ${ticket.id} is holding; Start implement first` });

    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]] });
    const started = await pull(laisso, ticket.id, "start");
    expect(started.display.state).toBe("running");
    expect(started.triggers).toEqual([{ action: "takeover", label: "Take over in terminal" }, { action: "abandon", label: "Abandon" }]);

    const notes = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.stage.name === "notes" ? d : null; }, "implement to finish");
    expect(notes.display).toEqual({ state: "needs_you", label: "Needs you", why: "not started" });
    const all = await notified(laisso, 3);
    expect(all[2]).toMatchObject({ body: "notes needs you" });

    // Start is only for a holding Ticket.
    const early = await laisso.api<Response>(`/api/tickets/${ticket.id}/start`, { method: "POST", raw: true });
    expect(early.status).toBe(400);
    expect(await early.json()).toEqual({ error: `Ticket ${ticket.id} is not holding; notes is already under way` });

    writeFileSync(path.join(ticket.worktree, "NOTES.md"), "done\n");
    const done = await pull(laisso, ticket.id, "done");
    expect(done.state).toBe("done");
    expect(done.display.state).toBe("done");
    expect(done.triggers).toEqual([]);
    // Mark done on the last Stage tears the worktree down before answering (ADR 0007).
    expect(existsSync(ticket.worktree)).toBe(false);
    expect(await laisso.notifications()).toHaveLength(3);
  });

  it("leaves a terminal Session alone across a restart: no liveness check, no reconcile", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const opened = await pull(laisso, ticket.id, "terminal");
    expect(await laisso.stop()).toBe(0);

    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    const d = await detailOf(again, ticket.id);
    expect(d.session).toMatchObject({ id: opened.session!.id, mode: "terminal", running: true, endedReason: null });
    expect(d.display.why).toMatch(/^terminal opened /);
    expect(d.sessions).toHaveLength(1);
    // Open terminal after the restart relaunches the same row on its held id.
    const reopened = await pull(again, ticket.id, "terminal");
    expect(reopened.session!.id).toBe(opened.session!.id);
    expect(reopened.sessions).toHaveLength(1);
    expect(await again.terminals()).toHaveLength(2);
  });

  it("skips a human Stage without its artifact", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const skipped = await pull(laisso, ticket.id, "skip");
    expect(skipped.stage.name).toBe("implement");
    expect(skipped.display.state).toBe("holding");
    expect(skipped.sessions).toEqual([]);
  });

  it("skips Stages that have not started, one at a time to the end, and records each (LASSO-159)", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    // grill says advance: false, so skipping it holds before implement, as finishing it would.
    const held = await pull(laisso, ticket.id, "skip");
    expect(held.display.state).toBe("holding");
    // implement is skipped from the gate without a Session; it auto-advances, so notes is current.
    const notes = await pull(laisso, ticket.id, "skip");
    expect(notes.stage.name).toBe("notes");
    expect(notes.sessions).toEqual([]);
    expect(notes.stages.map((s) => [s.name, s.skippedAt !== null])).toEqual([["grill", true], ["implement", true], ["notes", false]]);
    // Skipping the last Stage finishes the Ticket.
    const done = await pull(laisso, ticket.id, "skip");
    expect(done.state).toBe("done");
    expect(done.stages.every((s) => s.skippedAt !== null)).toBe(true);
  });

  it("refuses Skip once a headless Stage has started", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await pull(laisso, ticket.id, "skip");
    await laisso.runner.script({ hang: true });
    const started = await pull(laisso, ticket.id, "start");
    expect(started.triggers.map((x) => x.action)).toEqual(["takeover", "abandon"]);
    const refused = await laisso.api<Response>(`/api/tickets/${ticket.id}/skip`, { method: "POST", body: "{}", raw: true });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "implement has started; Skip only a Stage that has not, or one that is Flagged" });
    expect((await detailOf(laisso, ticket.id)).stage.name).toBe("implement");
  });

  it("holds after a headless Stage with advance: false and Start resumes the run", async () => {
    const pipeline = `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
    advance: false
  - name: ship
    prompt: Ship it.
`;
    const { laisso, ticket } = await laissoWithTicket({}, pipeline);
    expect(ticket.display.state).toBe("ready");
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]] });
    await laisso.api("/api/check-now", { method: "POST" });
    const held = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.stage.name === "ship" ? d : null; }, "implement to finish");
    expect(held.display).toEqual({ state: "holding", label: "Holding", why: "Start ship when ready" });
    expect((await notified(laisso, 1)).map((n) => n.body)).toEqual(["implement finished; Start ship when ready"]);

    const started = await pull(laisso, ticket.id, "start");
    expect(started.display.state).toBe("running");
    const done = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.state === "done" ? d : null; }, "ship to finish");
    expect(done.sessions.map((s) => s.stage)).toEqual(["ship", "implement"]);
  });

  it("keeps quiet when the event is switched off and only logs a failed post", async () => {
    const { laisso, ticket } = await laissoWithTicket({ notifications: { human: false } });
    await pull(laisso, ticket.id, "done", { override: true });
    const [gate] = await notified(laisso, 1);
    expect(gate!.body).toBe("grill finished; Start implement when ready");
    expect(await laisso.notifications()).toHaveLength(1);

    await laisso.breakNotifier();
    await pull(laisso, ticket.id, "start");
    // implement runs headless and fails with no script: a Flag, whose notification fails.
    await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.flag ? d : null; }, "the Flag");
    await waitFor(async () => (laisso.stdout().includes("notify.failed") ? true : null), "the failure to be logged");
    expect(laisso.stdout()).toMatch(/WARN notify.failed event=flagged .*terminal-notifier: broken/);
    expect(await laisso.notifications()).toHaveLength(1);
    expect((await detailOf(laisso, ticket.id)).triggers.map((x) => x.action)).toEqual(["retry", "resume", "takeover", "extend", "done", "skip", "abandon"]);
  });
});
