import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { startLassoWithRepos, waitFor, claudeFixture, type Lasso, type LassoConfig, type TrackerReply } from "./harness.ts";
import { sortForLedger, type TicketView, type TicketDetail, type IntakeResult, type DisplayState } from "../src/api/views.ts";
import { metroDiagram, metroTrack, sessionsForStage, quickAction, relative, tickIndicator, sessionProfile } from "../src/dashboard/metro.js";
import type { TickChange, TickStatus } from "../src/server/tick.ts";
import { setScene, sceneFile, swapTo, type Scene } from "./scenes.ts";

// Seam one for the live parts: the localhost JSON API the dashboard reads. The Ledger order and the
// Metro drawings are pure functions of that API's views, so they are checked on real API data
// without a browser (LASSO-41).
const running: Lasso[] = [];
afterEach(async () => { while (running.length) await running.pop()!.destroy(); });

const PIPELINE = `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
`;

// implement, then a tracker transition (an action Stage), then review on PR feedback.
const FLOW = `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
  - action: tracker.transition
    status: In Review
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
`;

/** The acli replies a JIRA-tracked Ticket needs: its issue, no duplicates, and transitions and label edits that succeed. */
const ACLI: TrackerReply[] = [
  { tool: "acli", match: ["workitem view APP-12", "summary,description"], stdout: JSON.stringify({ key: "APP-12", fields: { summary: "Add dark mode", description: "Body." } }) },
  { tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: JSON.stringify({ key: "APP-12", fields: { labels: [] } }) },
  { tool: "acli", match: ["workitem search"], stdout: "[]" },
  { tool: "acli", match: ["workitem transition"], stdout: "✓ ok\n" },
  { tool: "acli", match: ["workitem edit"], stdout: "✓ ok\n" },
];
const NO_PR: TrackerReply = { tool: "gh", match: ["pr view"], code: 1, stderr: "no pull requests found for branch\n" };
const T1 = "2026-09-27T10:05:00Z";
const T2 = "2026-09-27T10:10:00Z";

async function lassoWithTicket(config: LassoConfig = {}) {
  const started = await startLassoWithRepos({ app: { pipeline: "three" } }, config, { three: PIPELINE });
  running.push(started.lasso);
  const ticket = await started.lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "three" }) });
  return { ...started, ticket };
}

const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (lasso: Lasso, id: string, lever: string, body: object = {}) => lasso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const settled = (lasso: Lasso, id: string, count: number) => waitFor(async () => {
  const d = await detailOf(lasso, id);
  return d.sessions.length >= count && d.sessions.every((s) => !s.running) ? d : null;
}, `${count} Sessions to have ended`);
const flagged = (lasso: Lasso, id: string) => waitFor(async () => { const d = await detailOf(lasso, id); return d.flag ? d : null; }, "the Flag");

function view(state: DisplayState, updatedAt: string, queue: number | null = null): TicketView {
  return { id: `${state}-${updatedAt}`, display: { state, label: state, why: "" }, queue, updatedAt } as unknown as TicketView;
}

describe("the Ledger order", () => {
  it("is Flagged, Needs you, Holding, Ready to start, Running, Queued by place, Quiet, then done and Abandoned, newest activity first within a group", () => {
    const seeded = [
      view("quiet", "2026-09-27T09:00:00Z"),
      view("done", "2026-09-27T12:00:00Z"),
      view("queued", "2026-09-27T11:00:00Z", 2),
      view("running", "2026-09-27T08:00:00Z"),
      view("abandoned", "2026-09-27T13:00:00Z"),
      view("flagged", "2026-09-27T01:00:00Z"),
      view("needs_you", "2026-09-27T10:00:00Z"),
      view("queued", "2026-09-27T12:30:00Z", 1),
      view("ready", "2026-09-27T07:00:00Z"),
      view("quiet", "2026-09-27T10:30:00Z"),
      view("holding", "2026-09-27T06:00:00Z"),
      view("flagged", "2026-09-27T02:00:00Z"),
      view("running", "2026-09-27T09:30:00Z"),
    ];
    expect(sortForLedger(seeded).map((v) => v.id)).toEqual([
      "flagged-2026-09-27T02:00:00Z",
      "flagged-2026-09-27T01:00:00Z",
      "needs_you-2026-09-27T10:00:00Z",
      "holding-2026-09-27T06:00:00Z",
      "ready-2026-09-27T07:00:00Z",
      "running-2026-09-27T09:30:00Z",
      "running-2026-09-27T08:00:00Z",
      "queued-2026-09-27T12:30:00Z",
      "queued-2026-09-27T11:00:00Z",
      "quiet-2026-09-27T10:30:00Z",
      "quiet-2026-09-27T09:00:00Z",
      "done-2026-09-27T12:00:00Z",
      "abandoned-2026-09-27T13:00:00Z",
    ]);
  });
});

describe("the Metro drawings from API data", () => {
  it("draw Flagged as a red octagon with an attempt orbit, running as a pulsing ring, and never a travelling dot", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    // Fresh: the current station is ringed, the two ahead are hollow, and the Ledger track agrees.
    const fresh = await detailOf(lasso, ticket.id);
    expect(fresh.stages.map((s) => [s.name, s.kind])).toEqual([["implement", "runner"], ["notes", "runner"], ["review", "runner"]]);
    let svg = metroDiagram(fresh, null);
    expect(svg).toContain('<g class="node current" data-stage="implement">');
    expect(svg).toContain('<g class="node ahead" data-stage="notes">');
    expect(svg).toContain('<g class="node ahead" data-stage="review">');
    expect(svg).toContain('>ready to start</text>');
    expect(svg).not.toContain("animateMotion");
    const rows = await lasso.api<TicketView[]>("/api/tickets");
    expect(rows[0]!.stages.map((s) => s.name)).toEqual(["implement", "notes", "review"]);
    const track = metroTrack(rows[0]!);
    expect(track).toContain('data-role="track" aria-label="implement, Stage 1 of 3"');
    expect(track.match(/class="current"/g)).toHaveLength(1);
    expect(track.match(/class="ahead"/g)).toHaveLength(2);
    expect(quickAction(rows[0]!)).toBeNull();

    // Two failed attempts: Flagged at implement, the octagon on its station and a 2-attempt orbit.
    await lasso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(lasso);
    await flagged(lasso, ticket.id);
    await pull(lasso, ticket.id, "retry");
    const twice = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.flag && d.sessions.length === 2 ? d : null; }, "the second Flag");
    expect(twice.display.state).toBe("flagged");
    svg = metroDiagram(twice, null);
    expect(svg).toContain('<g class="node current" data-stage="implement"><polygon class="flagged"');
    expect(svg).toContain('class="orbit attempts"');
    expect(svg).toContain(">2 of 2 attempts</text>");
    expect(svg).toMatch(/<polygon class="flagged" points="[^"]*" fill="var\(--crit\)"/);
    const flaggedRows = await lasso.api<TicketView[]>("/api/tickets");
    expect(metroTrack(flaggedRows[0]!)).toContain('stroke="var(--crit)"');
    expect(quickAction(flaggedRows[0]!)).toEqual({ action: "retry", label: "Retry implement" });

    // A third attempt running (after Extend): the ring pulses and the orbit counts three.
    await lasso.runner.script({ hang: true });
    await pull(lasso, ticket.id, "extend", { attempts: 3 });
    const live = await pull(lasso, ticket.id, "retry");
    expect(live.display.state).toBe("running");
    svg = metroDiagram(live, "implement");
    expect(svg).toContain('<circle class="current pulse"');
    expect(svg).toContain(">3 of 3 attempts</text>");
    expect(svg).toContain('class="node current focus" data-stage="implement"><circle class="focus-ring"');
    expect(svg).not.toContain("animateMotion");

    // Another Ticket, Ready to start, sits above the running one in the Ledger: it asks for attention first.
    const second = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Rename things", repo: "app", pipeline: "three" }) });
    expect((await lasso.api<TicketView[]>("/api/tickets")).map((t) => [t.id, t.display.state])).toEqual([[second.id, "ready"], [ticket.id, "running"]]);
  });

  it("draw the PR feedback orbit with its Rounds badge, action Stages as ticks, and a done Ticket as all stations filled", async () => {
    // A JIRA-tracked repo: implement, then a tracker transition (an action Stage), then review on PR feedback.
    const started = await startLassoWithRepos({ app: { tracker: "jira", project: "APP", pipeline: "flow" } }, {}, { flow: FLOW });
    const { lasso } = started;
    running.push(lasso);
    for (const reply of [...ACLI, NO_PR]) await lasso.tracker.reply(reply);
    const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "APP-12" }) });

    // implement succeeds, the transition runs itself on the next tick, and review is current.
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]] });
    await checkNow(lasso);
    await settled(lasso, ticket.id, 1);
    await checkNow(lasso);
    const atReview = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.stage.name === "review" ? d : null; }, "review to be current");
    expect(atReview.stages.map((s) => [s.name, s.kind])).toEqual([["implement", "runner"], ["transition-in-review", "action"], ["review", "runner"]]);
    expect(atReview.stage.repeat).toBe(true);
    let svg = metroDiagram(atReview, null);
    expect(svg).toContain('<g class="node done" data-stage="implement"><circle class="done"');
    expect(svg).toContain('<g class="node action" data-stage="transition-in-review"><rect');
    expect(svg).toContain('<g class="node current" data-stage="review">');
    expect(svg).not.toContain('class="orbit');
    expect(metroTrack((await lasso.api<TicketView[]>("/api/tickets"))[0]!).match(/<rect /g)).toHaveLength(1);

    // A failing check opens Round 1; the Runner pushes, and the check fails again on the new head.
    const failing: Scene = { tag: "failing", head: "aaaaaaa1", checks: [{ id: 900, name: "test", status: "completed", conclusion: "failure", at: T1 }] };
    const pushed: Scene = { tag: "pushed", head: "bbbbbbb2", checks: [{ id: 901, name: "test", status: "completed", conclusion: "failure", at: T2 }] };
    await setScene(lasso, ticket.branch, failing, ACLI);
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(lasso, await sceneFile(lasso, ticket.branch, "pushed", pushed, ACLI)) });
    expect((await checkNow(lasso)).changes.map((c) => c.summary)).toContain("started review Round 1");
    const afterRound = await settled(lasso, ticket.id, 3);
    expect(afterRound.budget.rounds).toMatchObject({ used: 1, limit: 5 });
    svg = metroDiagram(afterRound, null);
    expect(svg).toContain('class="orbit rounds"');
    expect(svg).toContain(">1 of 5 Rounds</text>");
    expect(svg).toContain(">1 Round</text>");
    const rows = await lasso.api<TicketView[]>("/api/tickets");
    expect(rows[0]!.pr).toBe("https://github.com/owner/app/pull/7");
    expect(quickAction(rows[0]!)).toEqual({ action: "check", label: "Check PR now" });

    // A station click filters the timeline to that Stage; no station shows every Session, action ones included.
    expect(sessionsForStage(afterRound.sessions, "review").map((s) => s.round)).toEqual([1]);
    expect(sessionsForStage(afterRound.sessions, null).map((s) => s.stage)).toEqual(["review", "transition-in-review", "implement"]);
    expect(sessionsForStage(afterRound.sessions, "transition-in-review")[0]).toMatchObject({ mode: "action", outcome: "succeeded" });

    // The same check failing twice Flags review: the octagon sits on the repeating station, its orbit red.
    expect((await checkNow(lasso)).changes).toEqual([{ ticket: ticket.id, summary: "Flagged: check test failed again after Round 1" }]);
    const flaggedAtReview = await detailOf(lasso, ticket.id);
    svg = metroDiagram(flaggedAtReview, null);
    expect(svg).toContain('<g class="node current" data-stage="review"><polygon class="flagged"');
    expect(svg).toMatch(/class="orbit rounds"[^>]*stroke="var\(--crit\)"/);
    expect(quickAction((await lasso.api<TicketView[]>("/api/tickets"))[0]!)).toEqual({ action: "retry", label: "Retry review" });

    // Retry opens Round 2: the ring pulses while it runs; the PR is merged by the time it ends, so the Ticket is done.
    await lasso.runner.script({ stdout: claudeFixture("success.json"), delayMs: 1500, commands: swapTo(lasso, await sceneFile(lasso, ticket.branch, "merged", { ...pushed, tag: "merged", state: "MERGED" }, ACLI)) });
    const retried = await pull(lasso, ticket.id, "retry");
    expect(retried.session).toMatchObject({ round: 2, running: true });
    svg = metroDiagram(retried, null);
    expect(svg).toContain('<g class="node current" data-stage="review"><circle class="current pulse"');
    expect(svg).toContain(">2 of 5 Rounds</text>");
    expect(svg).toContain(">Round 2 running</text>");
    expect(svg).toMatch(/class="orbit rounds"[^>]*stroke="var\(--run\)"/);

    const done = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    svg = metroDiagram(done, null);
    expect(svg.match(/<circle class="done"/g)).toHaveLength(2);
    expect(svg).not.toContain('class="node current');
    expect(svg).not.toContain('class="segment ahead"');
    const ended = (await lasso.api<TicketView[]>("/api/tickets?all=1")).find((t) => t.id === ticket.id)!;
    expect(ended.display.state).toBe("done");
    expect(metroTrack(ended).match(/class="done"/g)).toHaveLength(2);
    expect(quickAction(ended)).toBeNull();
  });

  it("reads times at second, minute and hour scale", () => {
    const now = Date.parse(T2);
    expect(relative(new Date(now - 12_000).toISOString(), now)).toBe("12s ago");
    expect(relative(new Date(now - 3 * 60_000).toISOString(), now)).toBe("3m ago");
    expect(relative(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe("2h ago");
    expect(relative(null, now)).toBe("never");
  });
});

describe("the Tick dot", () => {
  it("is idle with the time since the last Tick and the countdown to the next, from a real status", async () => {
    const { lasso } = await lassoWithTicket();
    await checkNow(lasso);
    const real = await lasso.api<TickStatus>("/api/tick");
    expect(real.running).toBe(false);
    expect(real.nextTick).not.toBeNull();
    // The real status with the next Tick pinned 23s after the last, so the countdown is a known number.
    const last = Date.parse(real.lastTick!);
    const status = { ...real, nextTick: new Date(last + 23_000).toISOString() };
    expect(tickIndicator(status, last + 12_000)).toEqual({ state: "idle", title: "last tick 12s ago · next in 11s" });
    // Timing reads at minute scale too.
    expect(tickIndicator({ ...real, nextTick: new Date(last + 3 * 60_000 + 5_000).toISOString() }, last + 3 * 60_000).title).toBe("last tick 3m ago · next in 5s");
  });

  it("says next: manual when the timer is off", async () => {
    const { lasso } = await lassoWithTicket();
    await checkNow(lasso);
    // A running Lasso always has a timer, so the real status stands in with nextTick cleared.
    const status = { ...(await lasso.api<TickStatus>("/api/tick")), nextTick: null };
    expect(tickIndicator(status, Date.parse(status.lastTick!) + 3 * 60_000)).toEqual({ state: "idle", title: "last tick 3m ago · next: manual" });
  });

  it("says no tick yet before the first Tick", async () => {
    const { lasso } = await lassoWithTicket();
    // The startup Tick may already have run, so the fresh status stands in with lastTick cleared.
    const status = { ...(await lasso.api<TickStatus>("/api/tick")), lastTick: null };
    expect(tickIndicator(status, Date.now())).toEqual({ state: "idle", title: "no tick yet" });
    expect(tickIndicator({ ...status, nextTick: null }, Date.now())).toEqual({ state: "idle", title: "no tick yet" });
  });

  it("is running while a Tick is in flight", async () => {
    const { lasso } = await lassoWithTicket();
    // Catching a real in-flight Tick is racy, so the real status stands in with running set.
    const status = { ...(await lasso.api<TickStatus>("/api/tick")), running: true };
    expect(tickIndicator(status, Date.now())).toEqual({ state: "running", title: "tick running" });
  });

  it("is down while Lasso is unreachable", () => {
    expect(tickIndicator("down", Date.now())).toEqual({ state: "down", title: "lasso unreachable; reconnecting" });
  });
});

describe("the Session header", () => {
  const FABLE = { "claude-fable": { runner: "claude" as const, model: "fable", effort: "high" as const, permission: "auto" as const, args: ["--verbose"] } };

  it("shows profile (model), with the recorded runner, effort, permission and args on hover, unchanged by a later profile edit", async () => {
    const { lasso, ticket } = await lassoWithTicket({ profiles: FABLE, default_profile: "claude-fable" });
    await lasso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(lasso);
    const ended = (await settled(lasso, ticket.id, 1)).sessions[0]!;
    const shown = { text: "claude-fable (fable)", title: "runner claude · effort high · permission auto · args --verbose" };
    expect(sessionProfile(ended)).toEqual(shown);

    // Editing the profile afterwards leaves the ended Session as it ran.
    const file = path.join(lasso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("model: fable", "model: opus").replace("effort: high", "effort: low"));
    expect((await lasso.api<{ config: { profiles: typeof FABLE } }>("/api/config")).config.profiles["claude-fable"]).toMatchObject({ model: "opus", effort: "low" });
    const after = (await detailOf(lasso, ticket.id)).sessions.find((s) => s.id === ended.id)!;
    expect(sessionProfile(after)).toEqual(shown);
    // Unset fields read as the defaults they fell back to; no model shows the name alone.
    expect(sessionProfile({ ...ended, profile: { name: "blank", runner: "pi", model: null, effort: null, permission: null, args: [] } })).toEqual({ text: "blank", title: "runner pi · effort default · permission default · args none" });

    const html = await (await lasso.page("/")).text();
    expect(html).toMatch(/import \{[^}]*\bsessionProfile\b[^}]*\} from '\/metro\.js'/);
    expect(html).toContain("'data-role': 'profile'");
  });

  it("shows only the Runner for a Session from before profiles, and nothing for one with neither", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(lasso);
    const ran = (await settled(lasso, ticket.id, 1)).sessions[0]!;
    // Put the row back as a Lasso from before ADR 0011 wrote it: no profile record, the Runner on the Stage snapshot.
    const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
    const { stage_snapshot } = db.prepare("SELECT stage_snapshot FROM sessions WHERE id = ?").get(ran.id) as { stage_snapshot: string };
    db.prepare("UPDATE sessions SET profile = NULL, stage_snapshot = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(stage_snapshot), runner: "codex" }), ran.id);
    db.close();
    const old = (await detailOf(lasso, ticket.id)).sessions[0]!;
    expect(old).toMatchObject({ profile: null, runner: "codex" });
    expect(sessionProfile(old)).toEqual({ text: "codex", title: "runner codex · from before Agent Profiles" });
    expect(sessionProfile({ ...old, runner: null })).toBeNull();
  });
});

describe("the dashboard page", () => {
  it("serves the Metro module, and the page carries every Ledger row and detail element the spec lists", async () => {
    const { lasso } = await lassoWithTicket();
    const script = await lasso.page("/metro.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("export function metroDiagram");
    const html = await (await lasso.page("/")).text();
    expect(html).toContain("from '/metro.js'");
    expect(html).toMatch(/import \{[^}]*\btickIndicator\b[^}]*\} from '\/metro\.js'/);
    // The header's Tick dot replaces the old tick-status text.
    expect(html).toContain('data-role="tick-dot"');
    const dot = html.match(/<span [^>]*data-role="tick-dot"[^>]*>/)![0];
    expect(dot).toContain('role="img"');
    // No tooltip until the first status or error arrives.
    expect(dot).not.toContain("title=");
    expect(html).not.toContain("tick-status");
    // Ledger rows: pill, reference over repo, title over why, mini track with the Stage name, rings, last activity, quick action.
    for (const role of ["pill", "ref", "why", "track", "rings", "last", "quick"]) expect(html).toContain(`'data-role': '${role}'`);
    // Detail: title bar with PR link, pill and triggers, the Metro flow, the Flag box, the Session pane, gauges, the timeline, and the collapsed Ledger sidebar.
    for (const role of ["titlebar", "pr-link", "check-pr", "triggers", "flow", "flagbox", "session", "gauges", "timeline", "stage-filter"]) expect(html).toContain(`'data-role': '${role}'`);
    expect(html).toContain('data-role="side"');
    expect(html).toContain("[data-stage]");
    expect(html).toContain("All Stages");
    expect(html).toContain("Check PR now");
  });
});
