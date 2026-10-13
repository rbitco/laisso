import { describe, it, expect, afterEach } from "vitest";
import { startLassoWithRepos, startLasso, runCli, waitFor, claudeFixture, type Lasso, type TrackerCall, type TrackerReply } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: action Stages and the label mirror, watched through the API and
// the gh/acli shim, which records every invocation and replays canned answers.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

// grill (human) → In Progress (action) → implement (headless) → Done (action)
const PIPELINE = `stages:
  - name: grill
    prompt: Interview me.
    human: true
  - action: tracker.transition
    status: In Progress
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
  - action: tracker.transition
    status: Done
`;

const jiraView = (key: string, summary: string) => JSON.stringify({ key, fields: { summary, description: "Body." } });
const jiraLabels = (...labels: string[]) => JSON.stringify({ key: "APP-12", fields: { labels } });
const ghLabels = (...names: string[]) => JSON.stringify({ labels: names.map((name) => ({ name })) });

/** A JIRA-tracked repo on the flow Pipeline; `before` replies take precedence over the generic ones. */
async function jiraLasso(before: TrackerReply[] = []) {
  const started = await startLassoWithRepos({ app: { tracker: "jira", project: "APP", pipeline: "flow" } }, {}, { flow: PIPELINE });
  running.push(started.lasso);
  const { lasso } = started;
  for (const reply of before) await lasso.tracker.reply(reply);
  await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "summary,description"], stdout: jiraView("APP-12", "Add dark mode") });
  await lasso.tracker.reply({ tool: "acli", match: ["workitem search"], stdout: "[]" });
  await lasso.tracker.reply({ tool: "acli", match: ["workitem transition"], stdout: "✓ ok\n" });
  await lasso.tracker.reply({ tool: "acli", match: ["workitem edit"], stdout: "✓ ok\n" });
  return started;
}

const admit = (lasso: Lasso, input: string) => lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input }) });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (lasso: Lasso, id: string, trigger: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/${trigger}`, { method: "POST", body: "{}" });
const argsOf = (calls: TrackerCall[]) => calls.map((c) => c.args.join(" "));
const callsSince = (lasso: Lasso, count: number) => waitFor(async () => { const c = await lasso.tracker.calls(); return c.length >= count ? c : null; }, `${count} tracker calls`);

describe("the tracker mirror", () => {
  it("labels the first Stage at intake, swaps the label on each transition, and clears it at done", async () => {
    const { lasso } = await jiraLasso();
    // A stale label from an earlier run and a human's own label: the first is overwritten, the second kept.
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels("lasso:review", "mine"), once: true });

    // Intake answers before the tracker push finishes; the push follows in the background.
    const ticket = await admit(lasso, "APP-12");
    expect(argsOf(await callsSince(lasso, 3))).toEqual([
      "jira workitem view APP-12 --fields summary,description --json",
      "jira workitem view APP-12 --fields labels --json",
      "jira workitem edit --key APP-12 --labels lasso:grill --remove-labels lasso:review --yes",
    ]);
    await lasso.tracker.clearCalls();

    // Skip grill: an action Stage keeps grill's label, so the push finds nothing to change.
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels("mine", "lasso:grill"), once: true });
    const skipped = await pull(lasso, ticket.id, "skip");
    expect(skipped.stage).toMatchObject({ name: "transition-in-progress", label: "In Progress", kind: "action" });
    expect(skipped.display).toMatchObject({ state: "ready", why: "In Progress starts on the next tick" });
    expect(argsOf(await callsSince(lasso, 1))).toEqual(["jira workitem view APP-12 --fields labels --json"]);
    await lasso.tracker.clearCalls();
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels("mine", "lasso:grill"), once: true });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels("mine", "lasso:implement") });

    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]] });
    const tick = await checkNow(lasso);
    expect(tick.changes).toEqual([{ ticket: ticket.id, summary: "started transition-in-progress" }]);
    // Each Session's end kicks the tick: the transition's starts implement, and implement's performs Done, with no check-now.
    const finished = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    expect(finished.sessions.map((s) => [s.stage, s.mode, s.outcome, s.finalMessage])).toEqual([
      ["transition-done", "action", "succeeded", "moved APP-12 to Done"],
      ["implement", "headless", "succeeded", expect.any(String)],
      ["transition-in-progress", "action", "succeeded", "moved APP-12 to In Progress"],
    ]);
    // The config Action moved the status through acli. Then the label swapped to implement, implement's finish found it
    // already right, and Done cleared it; those pushes run in the background, so their order against the kicked ticks varies.
    const calls = argsOf(await callsSince(lasso, 7));
    expect(calls[0]).toBe("jira workitem transition --key APP-12 --status In Progress --yes");
    expect(calls.slice(1).sort()).toEqual([
      "jira workitem view APP-12 --fields labels --json",
      "jira workitem edit --key APP-12 --labels lasso:implement --remove-labels lasso:grill --yes",
      "jira workitem transition --key APP-12 --status Done --yes",
      "jira workitem view APP-12 --fields labels --json",
      "jira workitem view APP-12 --fields labels --json",
      "jira workitem edit --key APP-12 --remove-labels lasso:implement --yes",
    ].sort());
    expect(calls.indexOf("jira workitem transition --key APP-12 --status Done --yes")).toBeLessThan(calls.indexOf("jira workitem edit --key APP-12 --remove-labels lasso:implement --yes"));
  });

  it("parks a failed push as pending, retries it on the tick, and overwrites the tracker after a restart", async () => {
    const { lasso } = await jiraLasso();
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stderr: "✗ Error: 503 Service Unavailable\n", code: 1, once: true });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels("lasso:elsewhere") });

    const ticket = await admit(lasso, "APP-12");
    await waitFor(async () => ((await detailOf(lasso, ticket.id)).mirrorPending ? true : null), "the failed push to go pending");
    await lasso.tracker.clearCalls();

    const cli = await runCli(["status", ticket.id], lasso);
    expect(cli.stdout).toContain("tracker:   labels not written yet; retried each tick");

    // The tick retries from the Ticket's current state and overwrites what the tracker had.
    const tick = await checkNow(lasso);
    expect(tick.changes).toEqual([{ ticket: ticket.id, summary: "mirror pushed" }]);
    expect((await detailOf(lasso, ticket.id)).mirrorPending).toBe(false);
    expect(argsOf(await lasso.tracker.calls())).toEqual([
      "jira workitem view APP-12 --fields labels --json",
      "jira workitem edit --key APP-12 --labels lasso:grill --remove-labels lasso:elsewhere --yes",
    ]);

    // A restart owes every tracker Ticket a push, so a hand edit made while Lasso was down does not stick.
    expect(await lasso.stop()).toBe(0);
    await lasso.tracker.clearCalls();
    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    expect(argsOf(await callsSince(again, 2))).toEqual([
      "jira workitem view APP-12 --fields labels --json",
      "jira workitem edit --key APP-12 --labels lasso:grill --remove-labels lasso:elsewhere --yes",
    ]);
    await waitFor(async () => ((await detailOf(again, ticket.id)).mirrorPending ? null : true), "the pending mark to clear");
  });

  it("creates a GitHub label on first use, closes the issue, and toggles lasso:flagged", async () => {
    const pipeline = `stages:
  - name: implement
    prompt: Do the work.
  - action: tracker.transition
    status: closed
`;
    const started = await startLassoWithRepos({ web: { tracker: "github", project: "acme/web", pipeline: "gh" } }, {}, { gh: pipeline });
    running.push(started.lasso);
    const { lasso } = started;
    await lasso.tracker.reply({ tool: "gh", match: ["issue view 7", "title,body"], stdout: JSON.stringify({ title: "Fix links", body: "" }) });
    await lasso.tracker.reply({ tool: "gh", match: ["issue view 7", "--json labels"], stdout: ghLabels("bug"), once: true });
    await lasso.tracker.reply({ tool: "gh", match: ["issue edit 7", "--add-label lasso:implement"], stderr: "could not add label: 'lasso:implement' not found\n", code: 1, once: true });
    await lasso.tracker.reply({ tool: "gh", match: ["issue edit 7"], stdout: "" });
    await lasso.tracker.reply({ tool: "gh", match: ["label create"], stdout: "" });
    await lasso.tracker.reply({ tool: "gh", match: ["issue close 7"], stdout: "" });

    const ticket = await admit(lasso, "acme/web#7");
    expect(argsOf(await callsSince(lasso, 5))).toEqual([
      "issue view 7 --repo acme/web --json title,body",
      "issue view 7 --repo acme/web --json labels",
      "issue edit 7 --repo acme/web --add-label lasso:implement",
      "label create lasso:implement --repo acme/web --color 5319E7 --description Set by Lasso --force",
      "issue edit 7 --repo acme/web --add-label lasso:implement",
    ]);
    await lasso.tracker.clearCalls();

    // implement fails (no script): Flagged, and the tracker shows it.
    await lasso.tracker.reply({ tool: "gh", match: ["issue view 7", "--json labels"], stdout: ghLabels("bug", "lasso:implement") });
    await checkNow(lasso);
    const flagged = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.flag ? d : null; }, "the Flag");
    expect(flagged.flag!.reason).toBe("budget.attempts");
    const calls = argsOf(await callsSince(lasso, 2)).filter((c) => !c.startsWith("issue view"));
    expect(calls).toEqual(["issue edit 7 --repo acme/web --add-label lasso:flagged"]);
  });

  it("Flags a failed transition as a failed action Session", async () => {
    const { lasso } = await jiraLasso([
      { tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels() },
      { tool: "acli", match: ["workitem transition", "--status In Progress"], stderr: "✗ Error: transition is not valid from Backlog\n", code: 1 },
    ]);
    const ticket = await admit(lasso, "APP-12");
    await pull(lasso, ticket.id, "skip");
    // Intake's fetch and push (three calls), then Skip's push (two), before the slate is wiped.
    await callsSince(lasso, 5);
    await lasso.tracker.clearCalls();

    const tick = await checkNow(lasso);
    expect(tick.changes).toEqual([{ ticket: ticket.id, summary: "started transition-in-progress" }]);
    const d = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.flag ? d : null; }, "the Flag");
    expect(d.flag).toMatchObject({ reason: "outcome.failed", detail: "tracker.transition exited 1: ✗ Error: transition is not valid from Backlog" });
    expect(d.session).toMatchObject({ stage: "transition-in-progress", mode: "action", outcome: "failed", running: false });
    // An action Stage has nothing to resume: Retry performs it again.
    expect(d.triggers.map((x) => x.action)).toEqual(["retry", "extend", "done", "skip", "abandon"]);
    expect(argsOf(await callsSince(lasso, 3))).toEqual([
      "jira workitem transition --key APP-12 --status In Progress --yes",
      "jira workitem view APP-12 --fields labels --json",
      "jira workitem edit --key APP-12 --labels lasso:grill,lasso:flagged --yes",
    ]);
    // Resume has nothing to re-enter on an action Stage; Retry performs the action again and it fails the same way.
    await expect(pull(lasso, ticket.id, "resume")).rejects.toThrow("transition-in-progress is an action Stage; Retry performs it again");
    await pull(lasso, ticket.id, "retry");
    const retried = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.flag && d.sessions.length === 2 ? d : null; }, "the retry to Flag");
    expect(retried.flag).toMatchObject({ reason: "outcome.failed" });
    expect(retried.sessions.filter((s) => s.stage === "transition-in-progress")).toHaveLength(2);
  });

  it("honours Ctrl-C that lands during the startup tick: the Session it started is recorded as shutdown", async () => {
    const { lasso } = await jiraLasso([{ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels("lasso:grill") }]);
    const ticket = await admit(lasso, "APP-12");
    await lasso.runner.script({ hang: true });
    await pull(lasso, ticket.id, "skip");
    // Intake's fetch and push (two calls: the label is already right), then Skip's push (one).
    await callsSince(lasso, 3);
    await checkNow(lasso);
    const headless = (d: TicketDetail) => d.sessions.filter((s) => s.mode === "headless").map((s) => [s.ordinal, s.running, s.endedReason]);
    await waitFor(async () => ((await detailOf(lasso, ticket.id)).session?.mode === "headless" ? true : null), "implement to start");
    expect(await lasso.stop()).toBe(0);
    // A slow tracker keeps the startup tick busy long enough for Ctrl-C to land inside it.
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels("lasso:implement"), sleepMs: 1500, once: true }, true);

    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    // Node's default handler would exit at once with 130, leaving the Session the tick spawns running.
    expect(await again.stop()).toBe(0);

    const third = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(third);
    const d = await waitFor(async () => { const x = await detailOf(third, ticket.id); return headless(x).length === 3 ? x : null; }, "the startup tick to start run 3");
    expect(d.flag).toBeNull();
    expect(headless(d)).toEqual([[3, true, null], [2, false, "shutdown"], [1, false, "shutdown"]]);
  });

  it("closes an action Session left running by a crash and performs the Stage again on the next tick", async () => {
    const { lasso } = await jiraLasso([{ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: jiraLabels("lasso:grill") }]);
    const ticket = await admit(lasso, "APP-12");
    await pull(lasso, ticket.id, "skip");
    await callsSince(lasso, 3);
    // A transition that never answers: the process is stopped while the action Session is open.
    await lasso.tracker.reply({ tool: "acli", match: ["workitem transition"], sleepMs: 60_000 }, true);
    void checkNow(lasso).catch(() => undefined);
    await waitFor(async () => ((await detailOf(lasso, ticket.id)).session?.mode === "action" ? true : null), "the action Session to open");
    await lasso.kill();

    // The tracker answers from here on. It is set before the restart: on a slow machine the startup tick
    // can already be performing the action again by the time the test looks.
    await lasso.tracker.reply({ tool: "acli", match: ["workitem transition"], stdout: "✓ ok\n" }, true);
    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    const interrupted = (await detailOf(again, ticket.id)).sessions.find((s) => s.mode === "action" && s.outcome === "interrupted");
    expect(interrupted).toMatchObject({ stage: "transition-in-progress", running: false, endedReason: "shutdown" });
    // The action is performed again on the next tick, the startup one or a Check now.
    void checkNow(again).catch(() => undefined);
    const actionRuns = async () => (await detailOf(again, ticket.id)).sessions.filter((s) => s.mode === "action").map((s) => [s.stage, s.outcome]);
    await waitFor(async () => ((await actionRuns())[0]?.[1] === "succeeded" ? true : null), "the transition to succeed");
    expect(await actionRuns()).toEqual([
      ["transition-in-progress", "succeeded"],
      ["transition-in-progress", "interrupted"],
    ]);
  });

  it("Flags an action Stage on a prompt Ticket that has no tracker issue yet", async () => {
    const started = await startLassoWithRepos({ app: { tracker: "jira", project: "APP", pipeline: "flow" } }, {}, { flow: PIPELINE });
    running.push(started.lasso);
    const { lasso } = started;
    const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "flow" }) });
    await pull(lasso, ticket.id, "skip");
    await checkNow(lasso);
    const d = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.flag ? d : null; }, "the Flag");
    expect(d.flag).toMatchObject({ reason: "outcome.failed", detail: "tracker.transition exited 1: transition-in-progress: the Ticket has no tracker issue yet" });
    expect(await lasso.tracker.calls()).toEqual([]);
  });
});
