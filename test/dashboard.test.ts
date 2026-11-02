import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { startLaissoWithRepos, waitFor, claudeFixture, type Laisso, type LaissoConfig, type TrackerReply } from "./harness.ts";
import { sortForLedger, type TicketView, type TicketDetail, type IntakeResult, type DisplayState } from "../src/api/views.ts";
import { metroDiagram, metroTrack, sessionsForStage, quickAction, relative, tickIndicator, TICK_GRACE_MS, sessionProfile, profileApplies, profileLine, profileSummary, profileUsers, usedByLine, profileWarnings, MODEL_SUGGESTIONS, stageProfileView, profileIndex, scopeNote, profileScopes, overridableRepos, scopedProfile, profileRoute, ticketProfileView, ledgerStageText, pipelineLine } from "../src/dashboard/metro.ts";
import type { ConfigFile, PipelineListing, PipelineFile } from "../src/api/views.ts";
import type { ProfileConfig } from "../src/server/config.ts";
import type { TickChange, TickStatus } from "../src/server/tick.ts";
import { setScene, sceneFile, swapTo, type Scene } from "./scenes.ts";

// Seam one for the live parts: the localhost JSON API the dashboard reads. The Ledger order and the
// Metro drawings are pure functions of that API's views, so they are checked on real API data
// without a browser (LASSO-41).
const running: Laisso[] = [];
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

async function laissoWithTicket(config: LaissoConfig = {}) {
  const started = await startLaissoWithRepos({ app: { pipeline: "three" } }, config, { three: PIPELINE });
  running.push(started.laisso);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "three" }) });
  return { ...started, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (laisso: Laisso, id: string, lever: string, body: object = {}) => laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const settled = (laisso: Laisso, id: string, count: number) => waitFor(async () => {
  const d = await detailOf(laisso, id);
  return d.sessions.length >= count && d.sessions.every((s) => !s.running) ? d : null;
}, `${count} Sessions to have ended`);
const flagged = (laisso: Laisso, id: string) => waitFor(async () => { const d = await detailOf(laisso, id); return d.flag ? d : null; }, "the Flag");

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
    const { laisso, ticket } = await laissoWithTicket();
    // Fresh: the current station is ringed, the two ahead are hollow, and the Ledger track agrees.
    const fresh = await detailOf(laisso, ticket.id);
    expect(fresh.stages.map((s) => [s.name, s.kind])).toEqual([["implement", "runner"], ["notes", "runner"], ["review", "runner"]]);
    let svg = metroDiagram(fresh, null);
    expect(svg).toContain('<g class="node current" data-stage="implement">');
    expect(svg).toContain('<g class="node ahead" data-stage="notes">');
    expect(svg).toContain('<g class="node ahead" data-stage="review">');
    expect(svg).toContain('>ready to start</text>');
    expect(svg).not.toContain("animateMotion");
    const rows = await laisso.api<TicketView[]>("/api/tickets");
    expect(rows[0]!.stages.map((s) => s.name)).toEqual(["implement", "notes", "review"]);
    const track = metroTrack(rows[0]!);
    expect(track).toContain('data-role="track" aria-label="implement, Stage 1 of 3"');
    expect(track.match(/class="current"/g)).toHaveLength(1);
    expect(track.match(/class="ahead"/g)).toHaveLength(2);
    expect(quickAction(rows[0]!)).toBeNull();

    // Two failed attempts: Flagged at implement, the octagon on its station and a 2-attempt orbit.
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    await flagged(laisso, ticket.id);
    await pull(laisso, ticket.id, "retry");
    const twice = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.flag && d.sessions.length === 2 ? d : null; }, "the second Flag");
    expect(twice.display.state).toBe("flagged");
    svg = metroDiagram(twice, null);
    expect(svg).toContain('<g class="node current" data-stage="implement"><polygon class="flagged"');
    expect(svg).toContain('class="orbit attempts"');
    expect(svg).toContain(">2 of 2 attempts</text>");
    expect(svg).toMatch(/<polygon class="flagged" points="[^"]*" fill="var\(--crit\)"/);
    const flaggedRows = await laisso.api<TicketView[]>("/api/tickets");
    expect(metroTrack(flaggedRows[0]!)).toContain('stroke="var(--crit)"');
    expect(quickAction(flaggedRows[0]!)).toEqual({ action: "retry", label: "Retry implement" });

    // A third attempt running (after Extend): the ring pulses and the orbit counts three.
    await laisso.runner.script({ hang: true });
    await pull(laisso, ticket.id, "extend", { attempts: 3 });
    const live = await pull(laisso, ticket.id, "retry");
    expect(live.display.state).toBe("running");
    svg = metroDiagram(live, "implement");
    expect(svg).toContain('<circle class="current pulse"');
    expect(svg).toContain(">3 of 3 attempts</text>");
    expect(svg).toContain('class="node current focus" data-stage="implement"><circle class="focus-ring"');
    expect(svg).not.toContain("animateMotion");

    // Another Ticket, Ready to start, sits above the running one in the Ledger: it asks for attention first.
    const second = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Rename things", repo: "app", pipeline: "three" }) });
    expect((await laisso.api<TicketView[]>("/api/tickets")).map((t) => [t.id, t.display.state])).toEqual([[second.id, "ready"], [ticket.id, "running"]]);
  });

  it("draw the PR feedback orbit with its Rounds badge, action Stages as ticks, and a done Ticket as all stations filled", async () => {
    // A JIRA-tracked repo: implement, then a tracker transition (an action Stage), then review on PR feedback.
    const started = await startLaissoWithRepos({ app: { tracker: "jira", project: "APP", pipeline: "flow" } }, {}, { flow: FLOW });
    const { laisso } = started;
    running.push(laisso);
    for (const reply of [...ACLI, NO_PR]) await laisso.tracker.reply(reply);
    const ticket = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "APP-12" }) });

    // implement succeeds, the transition runs itself on the next tick, and review is current.
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]] });
    await checkNow(laisso);
    await settled(laisso, ticket.id, 1);
    await checkNow(laisso);
    const atReview = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.stage.name === "review" ? d : null; }, "review to be current");
    expect(atReview.stages.map((s) => [s.name, s.kind])).toEqual([["implement", "runner"], ["transition-in-review", "action"], ["review", "runner"]]);
    expect(atReview.stage.repeat).toBe(true);
    let svg = metroDiagram(atReview, null);
    expect(svg).toContain('<g class="node done" data-stage="implement"><circle class="done"');
    expect(svg).toContain('<g class="node action" data-stage="transition-in-review"><rect');
    expect(svg).toContain('<g class="node current" data-stage="review">');
    expect(svg).not.toContain('class="orbit');
    expect(metroTrack((await laisso.api<TicketView[]>("/api/tickets"))[0]!).match(/<rect /g)).toHaveLength(1);

    // A failing check opens Round 1; the Runner pushes, and the check fails again on the new head.
    const failing: Scene = { tag: "failing", head: "aaaaaaa1", checks: [{ id: 900, name: "test", status: "completed", conclusion: "failure", at: T1 }] };
    const pushed: Scene = { tag: "pushed", head: "bbbbbbb2", checks: [{ id: 901, name: "test", status: "completed", conclusion: "failure", at: T2 }] };
    await setScene(laisso, ticket.branch, failing, ACLI);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "pushed", pushed, ACLI)) });
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toContain("started review Round 1");
    const afterRound = await settled(laisso, ticket.id, 3);
    expect(afterRound.budget.rounds).toMatchObject({ used: 1, limit: 5 });
    svg = metroDiagram(afterRound, null);
    expect(svg).toContain('class="orbit rounds"');
    expect(svg).toContain(">1 of 5 Rounds</text>");
    expect(svg).toContain(">1 Round</text>");
    const rows = await laisso.api<TicketView[]>("/api/tickets");
    expect(rows[0]!.prs.map((p) => p.url)).toEqual(["https://github.com/owner/app/pull/7"]);
    expect(quickAction(rows[0]!)).toEqual({ action: "check", label: "Check PR now" });

    // A station click filters the timeline to that Stage; no station shows every Session, action ones included.
    expect(sessionsForStage(afterRound.sessions, "review").map((s) => s.round)).toEqual([1]);
    expect(sessionsForStage(afterRound.sessions, null).map((s) => s.stage)).toEqual(["review", "transition-in-review", "implement"]);
    expect(sessionsForStage(afterRound.sessions, "transition-in-review")[0]).toMatchObject({ mode: "action", outcome: "succeeded" });

    // The same check failing twice Flags review: the octagon sits on the repeating station, its orbit red.
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "Flagged: check test failed again after Round 1" }]);
    const flaggedAtReview = await detailOf(laisso, ticket.id);
    svg = metroDiagram(flaggedAtReview, null);
    expect(svg).toContain('<g class="node current" data-stage="review"><polygon class="flagged"');
    expect(svg).toMatch(/class="orbit rounds"[^>]*stroke="var\(--crit\)"/);
    expect(quickAction((await laisso.api<TicketView[]>("/api/tickets"))[0]!)).toEqual({ action: "retry", label: "Retry review" });

    // Retry opens Round 2: the ring pulses while it runs; the PR is merged by the time it ends, so the Ticket is done.
    await laisso.runner.script({ stdout: claudeFixture("success.json"), delayMs: 1500, commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "merged", { ...pushed, tag: "merged", state: "MERGED" }, ACLI)) });
    const retried = await pull(laisso, ticket.id, "retry");
    expect(retried.session).toMatchObject({ round: 2, running: true });
    svg = metroDiagram(retried, null);
    expect(svg).toContain('<g class="node current" data-stage="review"><circle class="current pulse"');
    expect(svg).toContain(">2 of 5 Rounds</text>");
    expect(svg).toContain(">Round 2 running</text>");
    expect(svg).toMatch(/class="orbit rounds"[^>]*stroke="var\(--run\)"/);

    const done = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    svg = metroDiagram(done, null);
    expect(svg.match(/<circle class="done"/g)).toHaveLength(2);
    expect(svg).not.toContain('class="node current');
    expect(svg).not.toContain('class="segment ahead"');
    const ended = (await laisso.api<TicketView[]>("/api/tickets?all=1")).find((t) => t.id === ticket.id)!;
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

  it("draw a Pipeline's Stages as a small line: a ring per Runner or human Stage, a square per action Stage", () => {
    const line = pipelineLine([{ kind: "runner" }, { kind: "action" }, { kind: "runner" }]);
    expect(line).toContain('viewBox="0 0 33 12"');
    expect(line.match(/<circle /g)).toHaveLength(2);
    expect(line.match(/<rect /g)).toHaveLength(1);
    expect(line).toContain('<rect x="16" y="3"');
    expect(line).toContain('<circle cx="28" cy="6"');
    expect(pipelineLine([])).toContain('viewBox="0 0 5 12"');
  });
});

describe("the Tick dot", () => {
  it("is healthy with the time since the last Tick and the countdown to the next, from a real status", async () => {
    const { laisso } = await laissoWithTicket();
    await checkNow(laisso);
    const real = await laisso.api<TickStatus>("/api/tick");
    expect(real.running).toBe(false);
    expect(real.nextTick).not.toBeNull();
    // The real status with the next Tick pinned 23s after the last, so the countdown is a known number.
    const last = Date.parse(real.lastTick!);
    const status = { ...real, nextTick: new Date(last + 23_000).toISOString() };
    expect(tickIndicator(status, last + 12_000)).toEqual({ state: "healthy", label: "Healthy", detail: "last tick 12s ago · next in 11s" });
    // Timing reads at minute scale too.
    expect(tickIndicator({ ...real, nextTick: new Date(last + 3 * 60_000 + 5_000).toISOString() }, last + 3 * 60_000).detail).toBe("last tick 3m ago · next in 5s");
  });

  it("stays healthy just past the next Tick's due time, then is late", async () => {
    const { laisso } = await laissoWithTicket();
    const real = { ...(await laisso.api<TickStatus>("/api/tick")), tickSeconds: 60 };
    const last = Date.parse("2026-10-15T10:00:00Z");
    const status = { ...real, running: false, lastTick: new Date(last).toISOString(), nextTick: new Date(last + 60_000).toISOString() };
    expect(tickIndicator(status, last + 60_000 + TICK_GRACE_MS).state).toBe("healthy");
    expect(tickIndicator(status, last + 3 * 60_000)).toEqual({ state: "late", label: "Tick delayed", detail: "last tick 3m ago · next was due 2m ago; ticks run every 60s" });
  });

  it("says next: manual when the timer is off, and is never late then", async () => {
    const { laisso } = await laissoWithTicket();
    await checkNow(laisso);
    // A running Laisso always has a timer, so the real status stands in with nextTick cleared.
    const status = { ...(await laisso.api<TickStatus>("/api/tick")), nextTick: null };
    expect(tickIndicator(status, Date.parse(status.lastTick!) + 3 * 60_000)).toEqual({ state: "healthy", label: "Healthy", detail: "last tick 3m ago · next: manual" });
  });

  it("says no tick yet before the first Tick", async () => {
    const { laisso } = await laissoWithTicket();
    // The startup Tick may already have run, so the fresh status stands in with lastTick cleared.
    const status = { ...(await laisso.api<TickStatus>("/api/tick")), lastTick: null };
    expect(tickIndicator(status, Date.now())).toEqual({ state: "healthy", label: "Healthy", detail: "no tick yet" });
  });

  it("is running while a Tick is in flight", async () => {
    const { laisso } = await laissoWithTicket();
    // Catching a real in-flight Tick is racy, so the real status stands in with running set.
    const status = { ...(await laisso.api<TickStatus>("/api/tick")), running: true };
    expect(tickIndicator(status, Date.now())).toEqual({ state: "running", label: "Healthy", detail: "tick running" });
  });

  it("is down while Laisso is unreachable", () => {
    expect(tickIndicator("down", Date.now())).toEqual({ state: "down", label: "Not connected", detail: "Can't reach Laisso; reconnecting on its own" });
  });
});

describe("the Session header", () => {
  const FABLE = { "claude-fable": { runner: "claude" as const, model: "fable", effort: "high" as const, permission: "auto" as const, args: ["--verbose"] } };

  it("shows profile (model), with the recorded runner, effort, permission and args on hover, unchanged by a later profile edit", async () => {
    const { laisso, ticket } = await laissoWithTicket({ profiles: FABLE, default_profile: "claude-fable" });
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(laisso);
    const ended = (await settled(laisso, ticket.id, 1)).sessions[0]!;
    const shown = { text: "claude-fable (fable)", title: "runner claude · effort high · permission auto · args --verbose" };
    expect(sessionProfile(ended)).toEqual(shown);

    // Editing the profile afterwards leaves the ended Session as it ran.
    const file = path.join(laisso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("model: fable", "model: opus").replace("effort: high", "effort: low"));
    expect((await laisso.api<{ config: { profiles: typeof FABLE } }>("/api/config")).config.profiles["claude-fable"]).toMatchObject({ model: "opus", effort: "low" });
    const after = (await detailOf(laisso, ticket.id)).sessions.find((s) => s.id === ended.id)!;
    expect(sessionProfile(after)).toEqual(shown);
    // Unset fields read as the defaults they fell back to; no model shows the name alone.
    expect(sessionProfile({ ...ended, profile: { name: "blank", runner: "pi", model: null, effort: null, permission: null, args: [] } })).toEqual({ text: "blank", title: "runner pi · effort default · permission default · args none" });

  });

  it("shows only the Runner for a Session from before profiles, and nothing for one with neither", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(laisso);
    const ran = (await settled(laisso, ticket.id, 1)).sessions[0]!;
    // Put the row back as a Laisso from before ADR 0011 wrote it: no profile record, the Runner on the Stage snapshot.
    const db = new DatabaseSync(path.join(laisso.home, "laisso.db"));
    const { stage_snapshot } = db.prepare("SELECT stage_snapshot FROM sessions WHERE id = ?").get(ran.id) as { stage_snapshot: string };
    db.prepare("UPDATE sessions SET profile = NULL, stage_snapshot = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(stage_snapshot), runner: "codex" }), ran.id);
    db.close();
    const old = (await detailOf(laisso, ticket.id)).sessions[0]!;
    expect(old).toMatchObject({ profile: null, runner: "codex" });
    expect(sessionProfile(old)).toEqual({ text: "codex", title: "runner codex · from before Agent Profiles" });
    expect(sessionProfile({ ...old, runner: null })).toBeNull();
  });
});

describe("the Agent Profiles list and drawer", () => {
  const PROFILES: Record<string, ProfileConfig> = {
    "claude-opus": { runner: "claude", model: "opus", permission: "auto" },
    "claude-haiku": { runner: "claude", model: "haiku", args: ["--verbose"], human: { permission: "auto", args: ["--debug"] } },
    "codex-high": { runner: "codex", model: "gpt-6-sol", effort: "high", skills_dir: "/opt/skills", human: { permission: "auto" } },
    "pi-gpt": { runner: "pi", model: "openai/gpt-5", permission: "full" },
  };
  // review names claude-haiku; implement and notes inherit the Pipeline's codex-high; the default Pipeline's Stages name the shipped ones or inherit claude-opus.
  const NAMED = `profile: codex-high
stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
  - name: review
    prompt: Address the Feedback.
    profile: claude-haiku
    repeat: feedback
    artifact: pr-merged
`;

  it("summarises each profile per mode, lists the Stages that use it, and warns on Haiku with auto, from real config and Pipelines", async () => {
    const { laisso } = await laissoWithTicket({ profiles: { ...PROFILES, "claude-fable": { runner: "claude", model: "fable" }, "claude-sonnet": { runner: "claude", model: "sonnet" } }, default_profile: "claude-opus" });
    await laisso.api("/api/pipelines/named", { method: "PUT", body: JSON.stringify({ text: NAMED, create: true }) });
    const { config } = await laisso.api<ConfigFile>("/api/config");
    const pipelines = await laisso.api<PipelineListing[]>("/api/pipelines");
    const p = config.profiles;

    // The summary: the headless line, then only what a human Session runs differently; unset permission shows each mode's default.
    expect(profileSummary(p["claude-opus"]!)).toBe("claude · opus · effort default · auto");
    expect(profileSummary(p["claude-haiku"]!)).toBe("claude · haiku · effort default · auto (default) · --verbose; human: auto · --verbose --debug");
    expect(profileSummary(p["codex-high"]!)).toBe("codex · gpt-6-sol · effort high · edits (default); human: auto");
    expect(profileSummary(p["pi-gpt"]!)).toBe("pi · openai/gpt-5 · effort default · permission n/a");
    expect(profileLine({ runner: "claude" }, "human")).toBe("claude · model default · effort default · edits (default)");

    // Used by: Stages naming the profile, then those inheriting it from their Pipeline or from default_profile.
    expect(usedByLine(profileUsers("codex-high", pipelines, config.default_profile))).toBe("inherited by named/implement, named/notes");
    expect(usedByLine(profileUsers("claude-haiku", pipelines, config.default_profile))).toBe("used by named/review");
    expect(usedByLine(profileUsers("claude-opus", pipelines, config.default_profile))).toBe("inherited by default/implement, default/review, three/implement, three/notes, three/review");
    expect(usedByLine(profileUsers("claude-fable", pipelines, config.default_profile))).toBe("used by default/grill, default/plan, default/code-review, pr-review/review-pr");
    expect(usedByLine(profileUsers("pi-gpt", pipelines, config.default_profile))).toBe("used by no Stages");

    // The known bad pair, per mode: Haiku runs headless in auto by default, and the human block asks for auto too.
    expect(profileWarnings(p["claude-haiku"]!)).toEqual(["Claude runs Haiku in Manual mode, not auto (headless and human Sessions)"]);
    expect(profileWarnings({ runner: "claude", model: "haiku", permission: "edits", human: { permission: "auto" } })).toEqual(["Claude runs Haiku in Manual mode, not auto (human Sessions)"]);
    expect(profileWarnings({ runner: "claude", model: "opus", human: { model: "claude-haiku-4-5" } })).toEqual([]);
    expect(profileWarnings({ runner: "claude", model: "opus", headless: { model: "claude-haiku-4-5" } })).toEqual(["Claude runs Haiku in Manual mode, not auto (headless Sessions)"]);
    expect(profileWarnings({ runner: "pi", model: "anthropic/claude-haiku-4-5", permission: "auto" })).toEqual([]);
    expect(profileWarnings(p["claude-opus"]!)).toEqual([]);

    // n/a: permission on Pi, and skills_dir on any Runner but Codex.
    expect(["claude", "codex", "pi"].map((r) => profileApplies(r, "permission"))).toEqual([true, true, false]);
    expect(["claude", "codex", "pi"].map((r) => profileApplies(r, "skills_dir"))).toEqual([false, true, false]);
    expect(MODEL_SUGGESTIONS.claude).toEqual(["fable", "opus", "sonnet", "haiku"]);
  });
  // The Config tiles and the drawer itself are React components, tested in profile-drawer.test.tsx.
});

describe("the profile picker in the Pipeline editor", () => {
  const PROFILES: Record<string, ProfileConfig> = {
    "claude-opus": { runner: "claude", model: "opus", permission: "auto" },
    "claude-fable": { runner: "claude", model: "fable", effort: "high", human: { permission: "edits", args: ["--verbose"] } },
    "claude-sonnet": { runner: "claude", model: "sonnet" },
    "pi-gpt": { runner: "pi", model: "openai/gpt-5" },
  };
  const PICKED = `profile: pi-gpt
stages:
  - name: plan
    prompt: Plan it.
    profile: claude-fable
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
`;

  it("labels each Runner Stage's button with the profile it runs, inherited from the Pipeline or default_profile, and each mode's line", async () => {
    const { laisso } = await laissoWithTicket({ profiles: PROFILES, default_profile: "claude-opus" });
    await laisso.api("/api/pipelines/picked", { method: "PUT", body: JSON.stringify({ text: PICKED, create: true }) });
    const { config } = await laisso.api<ConfigFile>("/api/config");
    const file = await laisso.api<PipelineFile>("/api/pipelines/picked");
    const [plan, implement] = file.pipeline!.stages as Array<{ profile: string | null }>;

    // A Stage naming a profile shows it as is, with its headless and human lines.
    expect(stageProfileView(plan!.profile, file.pipeline!.profile, config)).toEqual({
      name: "claude-fable", inherited: false, label: "claude-fable",
      headless: "claude · fable · effort high · auto (default)",
      human: "claude · fable · effort high · edits · --verbose",
    });
    // One naming none inherits the Pipeline's; with the dropdown cleared, config's default_profile.
    expect(stageProfileView(implement!.profile, file.pipeline!.profile, config)).toMatchObject({ name: "pi-gpt", inherited: true, label: "inherit → pi-gpt", headless: "pi · openai/gpt-5 · effort default · permission n/a" });
    expect(stageProfileView(implement!.profile, null, config)).toMatchObject({ name: "claude-opus", inherited: true, label: "inherit → claude-opus", human: "claude · opus · effort default · auto" });
    // A name config lacks, and no default at all, say so in place of the lines.
    expect(stageProfileView("claude-ghost", null, config)).toMatchObject({ label: "claude-ghost", headless: "no profile named claude-ghost in config.yaml" });
    expect(stageProfileView(null, null, { profiles: {}, default_profile: null })).toMatchObject({ name: null, label: "inherit → none", human: "no profile: config.yaml sets no default_profile" });
  });
});

describe("repo overrides in the profile drawer", () => {
  const GLOBALS: Record<string, ProfileConfig> = {
    "claude-opus": { runner: "claude", model: "opus" },
    "claude-sonnet": { runner: "claude", model: "sonnet" },
  };

  it("index each profile with the repos defining their own, offer the rest for an override, and route saves per scope, from real config", async () => {
    // app overrides claude-opus and alone has solo; web overrides claude-opus too; docs has nothing of its own.
    const started = await startLaissoWithRepos(
      { app: { profiles: { "claude-opus": { runner: "claude", model: "fable" }, solo: { runner: "pi", model: "openai/gpt-5" } } }, web: {}, docs: {} },
      { profiles: GLOBALS, default_profile: "claude-opus" },
    );
    running.push(started.laisso);
    const laisso = started.laisso;
    await laisso.api("/api/repos/web/profiles/claude-opus", { method: "PUT", body: JSON.stringify({ profile: GLOBALS["claude-opus"], create: true }) });
    const { config } = await laisso.api<ConfigFile>("/api/config");

    const index = profileIndex(config);
    expect(index).toEqual([
      { name: "claude-opus", global: true, repos: ["app", "web"] },
      { name: "claude-sonnet", global: true, repos: [] },
      { name: "solo", global: false, repos: ["app"] },
    ]);
    const [opus, sonnet, solo] = index;
    // The Config list's line: overrides on a global profile, the repos of a repo-only one, nothing for a plain one.
    expect(index.map(scopeNote)).toEqual(["overridden in app, web", "", "only in app"]);
    // The tabs: global, then each repo with its own; a repo-only profile has only its repos' tabs.
    expect(profileScopes(opus!)).toEqual([{ repo: null, label: "global" }, { repo: "app", label: "app" }, { repo: "web", label: "web" }]);
    expect(profileScopes(sonnet!)).toEqual([{ repo: null, label: "global" }]);
    expect(profileScopes(solo!)).toEqual([{ repo: "app", label: "app" }]);
    // "Override for repo…" offers repos without their own; a repo-only profile has no global to copy.
    expect(overridableRepos(opus!, config)).toEqual(["docs"]);
    expect(overridableRepos(sonnet!, config)).toEqual(["app", "web", "docs"]);
    expect(overridableRepos(solo!, config)).toEqual([]);
    // Each tab edits its own definition.
    expect(scopedProfile(config, "claude-opus", null)).toEqual({ runner: "claude", model: "opus" });
    expect(scopedProfile(config, "claude-opus", "app")).toEqual({ runner: "claude", model: "fable" });
    expect(scopedProfile(config, "claude-opus", "docs")).toBeUndefined();
    expect(profileRoute("claude-opus", null)).toBe("/api/profiles/claude-opus");
    expect(profileRoute("claude-opus", "my app")).toBe("/api/repos/my%20app/profiles/claude-opus");
    // The route the drawer saves a repo tab through is the one the API serves.
    const saved = await laisso.api<ConfigFile>(profileRoute("claude-opus", "app"), { method: "PUT", body: JSON.stringify({ profile: { runner: "claude", model: "haiku" } }) });
    expect(scopedProfile(saved.config, "claude-opus", "app")).toEqual({ runner: "claude", model: "haiku" });
    expect(scopedProfile(saved.config, "claude-opus", null)).toEqual({ runner: "claude", model: "opus" });
  });
});

describe("the dashboard page", () => {
  it("serves the built page, a React root and its bundle, and nothing else at an unknown asset", async () => {
    const { laisso } = await laissoWithTicket();
    const page = await laisso.page("/");
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    // The page is only Vite's entry: the React root and the bundle; the Ledger, header and views are components (test/app.test.tsx, test/ledger.test.tsx).
    expect(html).toContain('<div id="root"></div>');
    const bundle = html.match(/<script type="module" crossorigin src="(\/assets\/[^"]+\.js)">/)![1]!;
    const script = await laisso.page(bundle);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("Show done and Abandoned");
    const styles = html.match(/<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/)![1]!;
    const css = await laisso.page(styles);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain(".ticket.ended");
    expect((await laisso.page("/assets/missing.js")).status).toBe(404);
  });
});

describe("a Ticket's profile override on the dashboard", () => {
  it("stars the Ledger's profile only for an overridden current Stage, and the Ticket page shows each Stage's profile", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const row = async () => (await laisso.api<TicketView[]>("/api/tickets")).find((t) => t.id === ticket.id)!;
    const before = await row();
    expect(ledgerStageText(before)).toBe(`${before.stage.label} · ${before.stage.index + 1}/${before.stages.length}`);

    const detail = await detailOf(laisso, ticket.id);
    const first = detail.profiles[0]!;
    expect(first.overridden).toBe(false);
    expect(ticketProfileView(first)).toMatchObject({ name: first.profile, overridden: false, label: first.profile });
    expect(ticketProfileView(first).headless).toBe(profileLine(first.headless!, "headless"));

    const name = first.profile!;
    const set = await laisso.api<TicketDetail>(`/api/tickets/${ticket.id}/stages/${first.stage}/profile`, { method: "PUT", body: JSON.stringify({ profile: name }) });
    expect(set.profiles[0]).toMatchObject({ stage: first.stage, profile: name, from: "override", overridden: true });
    const after = await row();
    expect(ledgerStageText(after)).toBe(`${after.stage.label} · ${after.stage.index + 1}/${after.stages.length} · ${name}*`);
    expect(ticketProfileView({ ...first, headless: null, human: null, problem: "gone" })).toMatchObject({ headless: "gone", human: "gone", summary: "gone" });
  });
});
