import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLaissoWithRepos, startLaisso, runCli, waitFor, claudeFixture, type Laisso } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";
import { PR_URL, prUrl, setScene, setScenes, sceneFile, scenesFile, swapTo, marker, type Scene } from "./scenes.ts";

// Seam one: the Review loop through the API. The gh shim plays the PR: one
// scene per state of the PR, swapped by the fake Runner mid-Round the way a
// real Runner would change the PR by replying, resolving and pushing.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
`;


async function laissoWithTicket(pipeline = PIPELINE) {
  const started = await startLaissoWithRepos({ app: { pipeline: "loop" } }, {}, { loop: pipeline });
  running.push(started.laisso);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "loop" }) });
  return { ...started, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (laisso: Laisso, id: string, lever: string, body: object = {}) => laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const settled = (laisso: Laisso, id: string, count = 1) => waitFor(async () => {
  const d = await detailOf(laisso, id);
  return d.sessions.length >= count && d.sessions.every((s) => !s.running) ? d : null;
}, "the Round to end");
const launched = (laisso: Laisso, count: number) => waitFor(async () => { const c = await laisso.runner.calls(); return c.length >= count ? c : null; }, `${count} Runner launches`);

const T0 = "2026-09-27T10:00:00Z";
const T1 = "2026-09-27T10:05:00Z";
const T2 = "2026-09-27T10:10:00Z";
const T3 = "2026-09-27T11:00:00Z";

const green: Scene = { tag: "green", checks: [{ id: 1, name: "test", status: "completed", conclusion: "success", at: T0 }] };

describe("the Review loop", () => {
  it("polls the PR each tick with ETags and never launches a Round on an empty diff", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await setScene(laisso, ticket.branch, green);

    const first = await checkNow(laisso);
    expect(first.changes).toEqual([{ ticket: ticket.id, summary: "PR #7 found" }]);
    const d = await detailOf(laisso, ticket.id);
    expect(d.prs.map((p) => [p.role, p.source, p.url])).toEqual([["owned", "branch", PR_URL]]);
    expect((await runCli(["status", ticket.id], laisso)).stdout).toContain(`prs:\n  owned       ${PR_URL}\n`);
    expect(d.display).toEqual({ state: "quiet", label: "Quiet", why: "PR #7: checks green, nothing outstanding" });
    expect(d.sessions).toEqual([]);

    await laisso.tracker.clearCalls();
    expect((await checkNow(laisso)).changes).toEqual([]);
    const calls = await laisso.tracker.calls();
    const conditional = calls.filter((c) => c.args.includes("-i")).map((c) => [c.args[c.args.indexOf("-H") + 1], c.args.find((a) => a.startsWith("repos/"))]);
    // The three reads run in parallel, so compare them as a set.
    expect(conditional.sort()).toEqual([
      ['If-None-Match: W/"green-checks"', "repos/owner/app/commits/aaaaaaa1/check-runs"],
      ['If-None-Match: W/"green-comments"', "repos/owner/app/issues/7/comments"],
      ['If-None-Match: W/"green-inline"', "repos/owner/app/pulls/7/comments"],
    ]);
    expect(calls.some((c) => c.args.includes("pr"))).toBe(false);
    expect(await laisso.runner.calls()).toEqual([]);
    expect((await detailOf(laisso, ticket.id)).display.state).toBe("quiet");
  });

  it("opens a Round on new Feedback with the snapshot and marker in the prompt, records what it addressed, and goes quiet", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const asked: Scene = {
      tag: "asked",
      head: "aaaaaaa1",
      decision: "CHANGES_REQUESTED",
      reviews: [{ id: 55, state: "CHANGES_REQUESTED", author: "alice", body: "Two things.", at: T1 }],
      threads: [{ id: "RT_1", resolved: false, path: "src/a.ts", line: 12, comments: [{ id: 101, author: "alice", body: "Use a Map here.", at: T1 }] }],
      comments: [{ id: 201, author: "bob", body: "Please add a changelog entry.", at: T1 }],
      checks: [{ id: 900, name: "test", status: "completed", conclusion: "failure", at: T1 }],
      logs: { 900: "2026-09-27T10:04:00.000Z ##[group]Run pnpm test\n2026-09-27T10:04:01.000Z FAIL test/a.test.ts\n2026-09-27T10:04:02.000Z ##[error]Process completed with exit code 1.\n2026-09-27T10:04:03.000Z ##[endgroup]\n" },
    };
    const mark = marker(ticket.id, 1);
    const addressed: Scene = {
      ...asked,
      tag: "addressed",
      head: "bbbbbbb2",
      threads: [{ id: "RT_1", resolved: true, path: "src/a.ts", line: 12, comments: [...asked.threads![0]!.comments, { id: 102, author: "laisso-bot", body: `Done.\n${mark}`, at: T2 }] }],
      comments: [...asked.comments!, { id: 202, author: "laisso-bot", body: `Added the entry.\n${mark}`, at: T2 }],
      checks: [{ id: 901, name: "test", status: "in_progress", conclusion: null, at: T2 }],
    };
    await setScene(laisso, ticket.branch, asked);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "addressed", addressed)) });

    const tick = await checkNow(laisso);
    expect(tick.changes).toEqual([
      { ticket: ticket.id, summary: "PR #7 found" },
      { ticket: ticket.id, summary: "PR #7: 3 new Feedback items: check test failed, thread on src/a.ts:12 by alice, comment by bob" },
      { ticket: ticket.id, summary: "started review Round 1" },
    ]);
    const [call] = await launched(laisso, 1);
    const prompt = call!.argv[2]!;
    expect(prompt).toContain("Feedback on PR #7 (https://github.com/owner/app/pull/7), Round 1: 4 items.");
    expect(prompt).toContain(`1. [check 900] check test failed ${PR_URL}#check-900`);
    expect(prompt).toContain("   | ##[group]Run pnpm test\n   | FAIL test/a.test.ts\n   | ##[error]Process completed with exit code 1.");
    expect(prompt).toContain(`2. [thread RT_1] thread on src/a.ts:12 by alice at src/a.ts:12 ${PR_URL}#discussion_r-101\n   > alice: Use a Map here.`);
    expect(prompt).toContain(`3. [comment 201] comment by bob ${PR_URL}#issuecomment-201\n   > Please add a changelog entry.`);
    expect(prompt).toContain(`4. [verdict 55] changes requested by alice ${PR_URL}#review-55\n   > Two things.`);
    expect(prompt).toContain(`Reply to each comment separately, and end every comment you post on the PR with this marker, on its own line: ${mark}`);
    expect(call!.env).toMatchObject({ LAISSO_STAGE: "review", LAISSO_ROUND: "1", LAISSO_MARKER: mark });

    const d = await settled(laisso, ticket.id);
    expect(d.session).toMatchObject({ stage: "review", ordinal: 1, round: 1, outcome: "succeeded" });
    expect(d.session!.feedback).toEqual([
      { kind: "check", id: "900", summary: "check test failed", url: `${PR_URL}#check-900`, path: null, line: null, addressed: "new push bbbbbbb" },
      { kind: "thread", id: "RT_1", summary: "thread on src/a.ts:12 by alice", url: `${PR_URL}#discussion_r-101`, path: "src/a.ts", line: 12, addressed: `resolved after reply ${PR_URL}#discussion_r-102` },
      { kind: "comment", id: "201", summary: "comment by bob", url: `${PR_URL}#issuecomment-201`, path: null, line: null, addressed: `replied ${PR_URL}#issuecomment-202` },
      { kind: "verdict", id: "55", summary: "changes requested by alice", url: `${PR_URL}#review-55`, path: null, line: null, addressed: "its threads addressed" },
    ]);
    expect(d.flag).toBeNull();
    expect(d.display).toEqual({ state: "quiet", label: "Quiet", why: "PR #7: checks running" });
    expect(d.budget.rounds).toEqual({ used: 1, limit: 5, source: "global" });
    expect(d.prs.map((p) => [p.role, p.source, p.url])).toEqual([["owned", "branch", PR_URL]]);
    expect(d.budget.attempts).toEqual({ used: 1, limit: 2, source: "global" });

    // The Round's own marked comments are not Feedback: the next tick finds nothing new.
    expect((await checkNow(laisso)).changes).toEqual([]);
    expect(await laisso.runner.calls()).toHaveLength(1);
  });

  it("Flags review.unaddressed when a Round leaves an item standing; Retry re-runs the same Round", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const asked: Scene = { ...green, tag: "asked", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    await setScene(laisso, ticket.branch, asked);
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(laisso);
    const flagged = await settled(laisso, ticket.id);
    expect(flagged.flag).toMatchObject({ reason: "review.unaddressed", detail: "1 of 1 Feedback items unaddressed: comment by bob" });
    expect(flagged.session!.feedback).toEqual([{ kind: "comment", id: "201", summary: "comment by bob", url: `${PR_URL}#issuecomment-201`, path: null, line: null, addressed: null }]);
    expect(flagged.display.why).toBe("review.unaddressed");

    // Still polled while Flagged: nothing new on the PR, no Round, no second Flag.
    expect((await checkNow(laisso)).changes).toEqual([]);

    const replied: Scene = { ...asked, tag: "replied", comments: [...asked.comments!, { id: 202, author: "laisso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "replied", replied)) });
    const retried = await pull(laisso, ticket.id, "retry");
    expect(retried.session).toMatchObject({ ordinal: 2, round: 1, running: true, startedBy: "human" });
    expect(retried.display).toEqual({ state: "running", label: "Running", why: "review, Round 1 of 5" });
    const [, second] = await launched(laisso, 2);
    expect(second!.argv[2]).toContain("[comment 201] comment by bob");
    const done = await settled(laisso, ticket.id, 2);
    expect(done.flag).toBeNull();
    expect(done.session!.feedback[0]!.addressed).toBe(`replied ${PR_URL}#issuecomment-202`);
    expect(done.budget.rounds).toEqual({ used: 1, limit: 5, source: "global" });
    expect(done.budget.attempts).toEqual({ used: 2, limit: 2, source: "global" });
    expect(done.display.state).toBe("quiet");
  });

  it("Flags review.check_repeat when the same check fails in two consecutive Rounds", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const failing: Scene = { tag: "failing", head: "aaaaaaa1", checks: [{ id: 900, name: "test", status: "completed", conclusion: "failure", at: T1 }] };
    const pushed: Scene = { tag: "pushed", head: "bbbbbbb2", checks: [{ id: 901, name: "test", status: "completed", conclusion: "failure", at: T2 }] };
    await setScene(laisso, ticket.branch, failing);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "pushed", pushed)) });
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "PR #7: 1 new Feedback item: check test failed", "started review Round 1"]);
    const after = await settled(laisso, ticket.id);
    expect(after.flag).toBeNull();
    expect(after.session!.feedback[0]!.addressed).toBe("new push bbbbbbb");

    const tick = await checkNow(laisso);
    expect(tick.changes).toEqual([{ ticket: ticket.id, summary: "Flagged: check test failed again after Round 1" }]);
    const d = await detailOf(laisso, ticket.id);
    expect(d.flag).toMatchObject({ reason: "review.check_repeat", detail: "check test failed again after Round 1" });
    expect(d.sessions).toHaveLength(1);
    // Retry opens the next Round on the snapshot that Flagged.
    const retried = await pull(laisso, ticket.id, "retry");
    expect(retried.session).toMatchObject({ round: 2, running: true });
    expect(retried.session!.feedback).toEqual([expect.objectContaining({ kind: "check", id: "901" })]);
  });

  it("Flags review.pr_closed when the PR closes unmerged, and finishes the Stage when a human merges it", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await setScene(laisso, ticket.branch, { ...green, state: "CLOSED" });
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "Flagged: PR #7 closed without merging"]);
    const closed = await detailOf(laisso, ticket.id);
    expect(closed.flag).toMatchObject({ reason: "review.pr_closed" });
    expect((await checkNow(laisso)).changes).toEqual([]);

    await setScene(laisso, ticket.branch, { ...green, state: "MERGED" });
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "PR #7 merged; review finished" }]);
    const done = await detailOf(laisso, ticket.id);
    expect(done.state).toBe("done");
    expect(done.flag).toBeNull();
    expect(await laisso.runner.calls()).toEqual([]);
  });

  it("finishes the Stage when the PR is merged by the time a Round ends", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const asked: Scene = { ...green, tag: "asked", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    await setScene(laisso, ticket.branch, asked);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "merged", { ...asked, tag: "merged", state: "MERGED" })) });
    await checkNow(laisso);
    const done = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    expect(done.flag).toBeNull();
    expect(done.session).toMatchObject({ round: 1, outcome: "succeeded" });
  });

  it("counts Rounds against the Budget, refuses the next past the ceiling, and Extend opens it", async () => {
    const { laisso, ticket } = await laissoWithTicket(PIPELINE.replace("artifact: pr-merged", "artifact: pr-merged\n    budget: { rounds: 1 }"));
    expect(ticket.budget.rounds).toEqual({ used: 0, limit: 1, source: "pipeline" });
    const first: Scene = { ...green, tag: "first", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    const replied: Scene = { ...first, tag: "replied", comments: [...first.comments!, { id: 202, author: "laisso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    await setScene(laisso, ticket.branch, first);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "replied", replied)) });
    await checkNow(laisso);
    const one = await settled(laisso, ticket.id);
    expect(one.budget.rounds).toEqual({ used: 1, limit: 1, source: "pipeline" });
    expect(one.display.state).toBe("quiet");

    const more: Scene = { ...replied, tag: "more", comments: [...replied.comments!, { id: 203, author: "bob", body: "One more thing.", at: T3 }] };
    await setScene(laisso, ticket.branch, more);
    const tick = await checkNow(laisso);
    expect(tick.changes.map((c) => c.summary)).toEqual(["PR #7: 1 new Feedback item: comment by bob", "Flagged: review: 1 of 1 Rounds used"]);
    const refused = await detailOf(laisso, ticket.id);
    expect(refused.flag).toMatchObject({ reason: "budget.rounds", detail: "review: 1 of 1 Rounds used" });
    await expect(pull(laisso, ticket.id, "retry")).rejects.toThrow("review: 1 of 1 Rounds used; Extend the Budget first");

    const answered: Scene = { ...more, tag: "answered", comments: [...more.comments!, { id: 204, author: "laisso-bot", body: `Done.\n${marker(ticket.id, 2)}`, at: "2026-09-27T11:05:00Z" }] };
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "answered", answered)) });
    const extended = await pull(laisso, ticket.id, "extend", { rounds: 2 });
    expect(extended.flag).toBeNull();
    expect(extended.session).toMatchObject({ round: 2, ordinal: 2, running: true });
    expect(extended.session!.feedback).toEqual([expect.objectContaining({ kind: "comment", id: "203", addressed: null })]);
    expect(extended.budget.rounds).toEqual({ used: 2, limit: 2, source: "ticket" });
    const two = await settled(laisso, ticket.id, 2);
    expect(two.display).toEqual({ state: "quiet", label: "Quiet", why: "PR #7: checks green, nothing outstanding" });
  });

  it("re-runs a Round cut off by shutdown on the startup tick, with the same snapshot and no attempt spent", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await setScene(laisso, ticket.branch, { ...green, tag: "asked", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] });
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    await launched(laisso, 1);
    expect(await laisso.stop()).toBe(0);

    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    // The health check answers before the startup tick is through, so wait for the re-run to show.
    const d = await waitFor(async () => { const x = await detailOf(again, ticket.id); return x.sessions.length === 2 ? x : null; }, "the startup tick to re-run the Round");
    expect(d.sessions.map((s) => [s.ordinal, s.round, s.running, s.endedReason])).toEqual([[2, 1, true, null], [1, 1, false, "shutdown"]]);
    expect(d.session!.feedback).toEqual([expect.objectContaining({ kind: "comment", id: "201", addressed: null })]);
    expect(d.budget.attempts).toEqual({ used: 1, limit: 2, source: "global" });
    expect(d.budget.rounds).toEqual({ used: 1, limit: 5, source: "global" });
    const [, second] = await launched(again, 2);
    expect(second!.argv[2]).toContain("Round 1: 1 item.");
  });

  it("re-runs a Round past the first after shutdown without charging the earlier Round's attempts", async () => {
    const { laisso, ticket } = await laissoWithTicket(PIPELINE.replace("artifact: pr-merged", "artifact: pr-merged\n    budget: { attempts: 1 }"));
    const first: Scene = { ...green, tag: "first", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    const replied: Scene = { ...first, tag: "replied", comments: [...first.comments!, { id: 202, author: "laisso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    await setScene(laisso, ticket.branch, first);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "replied", replied)) });
    await checkNow(laisso);
    const one = await settled(laisso, ticket.id);
    expect(one.budget.attempts).toEqual({ used: 1, limit: 1, source: "pipeline" });

    await setScene(laisso, ticket.branch, { ...replied, tag: "more", comments: [...replied.comments!, { id: 203, author: "bob", body: "One more thing.", at: T3 }] });
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    await launched(laisso, 2);
    expect(await laisso.stop()).toBe(0);

    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    const d = await waitFor(async () => { const x = await detailOf(again, ticket.id); return x.sessions.length === 3 ? x : null; }, "the startup tick to re-run Round 2");
    expect(d.flag).toBeNull();
    expect(d.sessions.map((s) => [s.ordinal, s.round, s.running, s.endedReason])).toEqual([[3, 2, true, null], [2, 2, false, "shutdown"], [1, 1, false, null]]);
    expect(d.budget.attempts).toEqual({ used: 1, limit: 1, source: "pipeline" });
    expect(d.budget.rounds).toEqual({ used: 2, limit: 5, source: "global" });
  });

  it("laisso check reports what changed, or nothing new", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await setScene(laisso, ticket.branch, { ...green, state: "MERGED" });
    const changed = await runCli(["check"], laisso);
    expect(changed.code).toBe(0);
    expect(changed.stdout).toBe(`${ticket.shortId}  PR #7 found; PR #7 merged; review finished\n`);
    const quiet = await runCli(["check", ticket.id], laisso);
    expect(quiet.stdout).toBe("nothing new\n");
    const json = await runCli(["check", "--json"], laisso);
    expect(JSON.parse(json.stdout)).toMatchObject({ changes: [] });
    const other = await runCli(["check", "nope"], laisso);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("no Ticket matches nope");
  });
});

// Rounds across several Owned PRs (LASSO-165): PR #7 is on the Ticket's branch, PR #8 is linked through the API.
describe("several Owned PRs", () => {
  const PR8 = prUrl(8);
  const linkTicks = (laisso: Laisso) => laisso.stdout().split("\n").filter((line) => line.includes("trigger=pr-link")).length;
  /** Link a PR to an active Ticket and wait out the Tick the link kicks. */
  const link = async (laisso: Laisso, id: string, url: string) => {
    const before = linkTicks(laisso);
    await laisso.api(`/api/tickets/${id}/prs`, { method: "POST", body: JSON.stringify({ pr: url }) });
    await waitFor(async () => (linkTicks(laisso) > before ? true : null), "the Tick the link kicks");
  };
  const eight: Scene = { ...green, tag: "eight", number: 8, head: "ccccccc3", headRef: "feat-b", baseRef: "main" };

  it("runs one Round across every Owned PR with Feedback, grouped by PR with its head and base branch", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const seven: Scene = { ...green, tag: "seven", headRef: ticket.branch, baseRef: "main" };
    await setScene(laisso, ticket.branch, seven);
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "PR #7 found" }]);

    const asked7: Scene = { ...seven, tag: "asked7", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    const asked8: Scene = { ...eight, tag: "asked8", baseRef: ticket.branch, threads: [{ id: "RT_8", resolved: false, path: "src/b.ts", line: 4, comments: [{ id: 801, author: "alice", body: "Use a Set.", at: T1 }] }] };
    await setScenes(laisso, [[ticket.branch, asked7], ["feat-b", asked8]]);
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    await link(laisso, ticket.id, PR8);
    const [call] = await launched(laisso, 1);
    expect(call!.argv[2]).toContain([
      "Feedback on 2 PRs, Round 1: 2 items.",
      "",
      `PR #7 (${PR_URL}), head branch ${ticket.branch}, base branch main:`,
      `1. [comment 201] comment by bob ${PR_URL}#issuecomment-201`,
      "   > Rename this.",
      "",
      `PR #8 (${PR8}), head branch feat-b, base branch ${ticket.branch}:`,
      `2. [thread RT_8] thread on src/b.ts:4 by alice at src/b.ts:4 ${PR8}#discussion_r-801`,
      "   > alice: Use a Set.",
      "",
      `Reply to each comment separately, and end every comment you post on the PR with this marker, on its own line: ${marker(ticket.id, 1)}`,
    ].join("\n"));
    expect(call!.env).toMatchObject({ LAISSO_ROUND: "1", LAISSO_MARKER: marker(ticket.id, 1) });

    const d = await settled(laisso, ticket.id);
    expect(d.session!.feedback.map((f) => [f.kind, f.id])).toEqual([["comment", "201"], ["thread", "RT_8"]]);
    expect(d.flag).toMatchObject({ reason: "review.unaddressed", detail: "2 of 2 Feedback items unaddressed: comment by bob, thread on src/b.ts:4 by alice" });
  });

  it("counts Feedback already on a newly linked PR as new, however far another PR's watermark has moved", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const asked: Scene = { ...green, tag: "asked", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T2 }] };
    const replied: Scene = { ...asked, tag: "replied", comments: [...asked.comments!, { id: 202, author: "laisso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T3 }] };
    await setScene(laisso, ticket.branch, asked);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "replied", replied)) });
    await checkNow(laisso);
    expect((await settled(laisso, ticket.id)).flag).toBeNull();

    // PR #8's comment is older than anything PR #7's watermark has passed.
    const old8: Scene = { ...eight, comments: [{ id: 801, author: "carol", body: "An old note.", at: T0 }] };
    await setScenes(laisso, [[ticket.branch, replied], ["feat-b", old8]]);
    await link(laisso, ticket.id, PR8);
    const [, second] = await launched(laisso, 2);
    expect(second!.argv[2]).toContain(`Feedback on PR #8 (${PR8}), Round 2: 1 item.\n\nPR #8 (${PR8}), head branch feat-b, base branch main:\n1. [comment 801] comment by carol`);
    expect(second!.argv[2]).not.toContain("comment 201");
  });

  it("drops a merged PR from polling and keeps running Rounds on the rest until every one has merged", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const seven: Scene = { ...green, tag: "seven" };
    await setScenes(laisso, [[ticket.branch, seven], ["feat-b", eight]]);
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "PR #7 found" }]);
    await link(laisso, ticket.id, PR8);
    expect((await detailOf(laisso, ticket.id)).display).toEqual({ state: "quiet", label: "Quiet", why: "PR #7: checks green, nothing outstanding · PR #8: checks green, nothing outstanding" });

    const merged7: Scene = { ...seven, state: "MERGED" };
    const asked8: Scene = { ...eight, tag: "asked8", comments: [{ id: 801, author: "bob", body: "Rename this.", at: T1 }] };
    const replied8: Scene = { ...asked8, tag: "replied8", comments: [...asked8.comments!, { id: 802, author: "laisso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    await setScenes(laisso, [[ticket.branch, merged7], ["feat-b", asked8]]);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await scenesFile(laisso, "replied8", [[ticket.branch, merged7], ["feat-b", replied8]])) });
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 merged", "PR #8: 1 new Feedback item: comment by bob", "started review Round 1"]);
    const after = await settled(laisso, ticket.id);
    expect(after.state).toBe("active");
    expect(after.flag).toBeNull();
    expect(after.display).toEqual({ state: "quiet", label: "Quiet", why: "PR #8: checks green, nothing outstanding" });

    // PR #7 is read no more.
    await laisso.tracker.clearCalls();
    expect((await checkNow(laisso)).changes).toEqual([]);
    expect((await laisso.tracker.calls()).some((c) => c.args.includes("n=7"))).toBe(false);

    await setScenes(laisso, [[ticket.branch, merged7], ["feat-b", { ...replied8, state: "MERGED" }]]);
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "PR #8 merged; review finished" }]);
    expect((await detailOf(laisso, ticket.id)).state).toBe("done");
  });

  it("Flags review.pr_closed naming the Owned PR that closed without merging", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await setScenes(laisso, [[ticket.branch, green], ["feat-b", { ...eight, state: "CLOSED" }]]);
    await checkNow(laisso);
    await link(laisso, ticket.id, PR8);
    expect((await detailOf(laisso, ticket.id)).flag).toMatchObject({ reason: "review.pr_closed", detail: "PR #8 closed without merging" });
    expect(await laisso.runner.calls()).toEqual([]);
  });

  it("judges a repeated failing check on each PR's own Rounds", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const failing: Scene = { tag: "failing", head: "aaaaaaa1", checks: [{ id: 900, name: "test", status: "completed", conclusion: "failure", at: T1 }] };
    const fixed: Scene = { tag: "fixed", head: "bbbbbbb2", checks: [{ id: 901, name: "test", status: "completed", conclusion: "success", at: T2 }] };
    await setScene(laisso, ticket.branch, failing);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "fixed", fixed)) });
    await checkNow(laisso);
    expect((await settled(laisso, ticket.id)).flag).toBeNull();

    // PR #8's check named test fails for the first time on PR #8: Round 1's failure on PR #7 is not its history.
    const failing8: Scene = { ...eight, tag: "failing8", checks: [{ id: 950, name: "test", status: "completed", conclusion: "failure", at: T2 }] };
    const pushed8: Scene = { ...eight, tag: "pushed8", head: "ddddddd4", checks: [{ id: 951, name: "test", status: "completed", conclusion: "failure", at: T3 }] };
    await setScenes(laisso, [[ticket.branch, fixed], ["feat-b", failing8]]);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await scenesFile(laisso, "pushed8", [[ticket.branch, fixed], ["feat-b", pushed8]])) });
    await link(laisso, ticket.id, PR8);
    const second = await settled(laisso, ticket.id, 2);
    expect(second.session).toMatchObject({ round: 2 });
    expect(second.flag).toBeNull();

    // Failing again on PR #8 after PR #8's Round does Flag.
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "Flagged: check test failed again on PR #8 after Round 2" }]);
    expect((await detailOf(laisso, ticket.id)).flag).toMatchObject({ reason: "review.check_repeat" });
  });

  it("records a PR linked after Review has ended, and never polls it", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const merged7: Scene = { ...green, state: "MERGED" };
    await setScene(laisso, ticket.branch, merged7);
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "PR #7 merged; review finished"]);

    await setScenes(laisso, [[ticket.branch, merged7], ["feat-b", { ...eight, comments: [{ id: 801, author: "carol", body: "One more thing.", at: T1 }] }]]);
    await laisso.api(`/api/tickets/${ticket.id}/prs`, { method: "POST", body: JSON.stringify({ pr: PR8 }) });
    await laisso.tracker.clearCalls();
    expect((await checkNow(laisso)).changes).toEqual([]);
    expect((await laisso.tracker.calls()).some((c) => c.args.includes("n=8"))).toBe(false);
    const d = await detailOf(laisso, ticket.id);
    expect(d.state).toBe("done");
    expect(d.prs.map((p) => [p.role, p.url])).toEqual([["owned", PR_URL], ["owned", PR8]]);
    expect(await laisso.runner.calls()).toEqual([]);
  });
});

// A check Action as a repeating Stage's end condition (ADR 0014, LASSO-117): the Action passes once `.ready` is in the worktree.
describe("ignored authors", () => {
  it("never opens a Round on comments by review.ignore_authors or the gh user, but does on a thread someone else joined", async () => {
    const started = await startLaissoWithRepos({ app: { pipeline: "loop" } }, { review: { ignore_authors: ["Dependabot"], ignore_self: true } }, { loop: PIPELINE });
    running.push(started.laisso);
    const { laisso } = started;
    const ticket = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "loop" }) });
    const viewer = { tool: "gh" as const, match: ["api user"], stdout: "me\n" };
    const notes: Scene = {
      tag: "notes",
      threads: [{ id: "RT_1", resolved: false, path: "src/a.ts", line: 12, comments: [{ id: 101, author: "me", body: "Context: this mirrors the old parser.", at: T1 }] }],
      comments: [{ id: 201, author: "me", body: "Note to self: bump the version.", at: T1 }, { id: 202, author: "dependabot", body: "Bumped a dependency.", at: T1 }],
    };
    await setScene(laisso, ticket.branch, notes, [viewer]);

    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "PR #7 found" }]);
    expect((await detailOf(laisso, ticket.id)).display).toEqual({ state: "quiet", label: "Quiet", why: "PR #7: nothing outstanding" });
    expect(await laisso.runner.calls()).toEqual([]);

    const joined: Scene = { ...notes, tag: "joined", threads: [{ ...notes.threads![0]!, comments: [...notes.threads![0]!.comments, { id: 102, author: "alice", body: "Then say so in a comment.", at: T2 }] }] };
    await setScene(laisso, ticket.branch, joined, [viewer]);
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    expect((await checkNow(laisso)).changes).toEqual([
      { ticket: ticket.id, summary: "PR #7: 1 new Feedback item: thread on src/a.ts:12 by me" },
      { ticket: ticket.id, summary: "started review Round 1" },
    ]);
    const [call] = await launched(laisso, 1);
    expect(call!.argv[2]).toContain("   > me: Context: this mirrors the old parser.");
    expect(call!.argv[2]).toContain("Then say so in a comment.");
    expect(call!.argv[2]).not.toContain("Note to self");
    expect(call!.argv[2]).not.toContain("Bumped a dependency");
  });
});

describe("a repeating Stage that ends on a check Action", () => {
  const CHECKED = `stages:
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: action ready
`;
  const READY = 'if [ -f .ready ]; then echo "ready to go"; else echo "no .ready yet"; exit 1; fi';

  async function laissoWithCheck(run = READY, pipeline = CHECKED) {
    const started = await startLaissoWithRepos({ app: { pipeline: "checked" } }, { actions: { ready: { run } } }, { checked: pipeline });
    running.push(started.laisso);
    const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "checked" }) });
    return { ...started, ticket };
  }
  const ready = (worktree: string) => writeFile(path.join(worktree, ".ready"), "");

  it("runs the check each poll, says so while it is not met, and finishes the Stage once it is", async () => {
    const { laisso, ticket } = await laissoWithCheck();
    await setScene(laisso, ticket.branch, green);
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "PR #7 found" }]);
    const waiting = await detailOf(laisso, ticket.id);
    expect(waiting.flag).toBeNull();
    expect(waiting.display).toEqual({ state: "quiet", label: "Quiet", why: "PR #7: checks green, nothing outstanding · ready not met" });
    expect(waiting.check).toMatchObject({ action: "ready", result: "not_met", code: 1, line: "no .ready yet" });

    await ready(ticket.worktree);
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "action ready met; review finished" }]);
    const done = await detailOf(laisso, ticket.id);
    expect(done.state).toBe("done");
    expect(await laisso.runner.calls()).toEqual([]);
  });

  it("is not ended by a merge alone: a merged PR whose check is not met Flags artifact.missing", async () => {
    const { laisso, ticket } = await laissoWithCheck();
    await setScene(laisso, ticket.branch, { ...green, state: "MERGED" });
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "Flagged: action ready: no .ready yet (the PR has merged)"]);
    const d = await detailOf(laisso, ticket.id);
    expect(d.state).toBe("active");
    expect(d.flag).toMatchObject({ reason: "artifact.missing", detail: "action ready: no .ready yet (the PR has merged)" });
    // Flagged, it is a human's: the poll runs no more checks and raises no second Flag.
    await ready(ticket.worktree);
    expect((await checkNow(laisso)).changes).toEqual([]);
    // Mark done runs the check, now met, and the Stage finishes.
    expect((await pull(laisso, ticket.id, "done")).state).toBe("done");
  });

  it("still Flags review.pr_closed on a PR closed unmerged, and Flags artifact.error on a broken check", async () => {
    const closed = await laissoWithCheck();
    await setScene(closed.laisso, closed.ticket.branch, { ...green, state: "CLOSED" });
    expect((await checkNow(closed.laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "Flagged: PR #7 closed without merging"]);

    const broken = await laissoWithCheck('echo "gh: not logged in" >&2; exit 4');
    await setScene(broken.laisso, broken.ticket.branch, green);
    expect((await checkNow(broken.laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "Flagged: action ready: ready exited 4: gh: not logged in"]);
    expect((await detailOf(broken.laisso, broken.ticket.id)).flag).toMatchObject({ reason: "artifact.error" });
  });

  it("runs Rounds on Feedback while not met, and ends the Stage when a Round meets it", async () => {
    const { laisso, ticket } = await laissoWithCheck();
    const asked: Scene = { ...green, tag: "asked", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    const replied: Scene = { ...asked, tag: "replied", comments: [...asked.comments!, { id: 202, author: "laisso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    await setScene(laisso, ticket.branch, asked);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), files: { ".ready": "" }, commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "replied", replied)) });
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "PR #7: 1 new Feedback item: comment by bob", "started review Round 1"]);
    const done = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    expect(done.flag).toBeNull();
    expect(done.session).toMatchObject({ round: 1, outcome: "succeeded" });
  });

  it("never runs two checks for one Ticket at once", async () => {
    const { laisso, ticket } = await laissoWithCheck('if [ -e ../check.lock ]; then echo overlap >> ../overlaps; fi; touch ../check.lock; sleep 1; rm ../check.lock; exit 1');
    await setScene(laisso, ticket.branch, green);
    await Promise.all([checkNow(laisso), checkNow(laisso), checkNow(laisso)]);
    expect(existsSync(path.join(ticket.worktree, "..", "overlaps"))).toBe(false);
    expect((await detailOf(laisso, ticket.id)).check).toMatchObject({ result: "not_met" });
  });

  it("moves nothing when the Ticket is sent back to the Stage while its check runs, keeping the result on the old Visit", async () => {
    const { laisso, ticket } = await laissoWithCheck('touch ../started; while [ ! -f ../release ]; do sleep 0.1; done; echo "ready to go"');
    await setScene(laisso, ticket.branch, green);
    const visitsOf = () => {
      const db = new DatabaseSync(path.join(laisso.home, "laisso.db"));
      try {
        return db.prepare("SELECT id, stage, arrived_by, check_result FROM visits WHERE ticket = ? ORDER BY id").all(ticket.id) as Array<{ id: number; stage: string; arrived_by: string; check_result: string | null }>;
      } finally {
        db.close();
      }
    };
    const tick = checkNow(laisso);
    await waitFor(async () => (existsSync(path.join(ticket.worktree, "..", "started")) ? true : null), "the check to start");
    const sent = pull(laisso, ticket.id, "send", { stage: "review" });
    await waitFor(async () => (visitsOf().length === 2 ? true : null), "the send to land");
    await writeFile(path.join(ticket.worktree, "..", "release"), "");
    const [{ changes }] = await Promise.all([tick, sent]);
    expect(changes.map((c) => c.summary)).not.toContain("action ready met; review finished");

    const d = await detailOf(laisso, ticket.id);
    expect(d).toMatchObject({ state: "active", stage: { name: "review" } });
    const [old, now] = visitsOf();
    expect(JSON.parse(old!.check_result!)).toMatchObject({ result: "met", line: "ready to go" });
    expect(now).toMatchObject({ stage: "review", arrived_by: "send", check_result: null });
  });

  it("takes the Route a met check picked with laisso route (LASSO-192)", async () => {
    const routed = `${CHECKED}    routes:\n      ahead: { to: later }\n  - name: next\n    prompt: Next.\n    human: true\n  - name: later\n    prompt: Later.\n    human: true\n`;
    const { laisso, ticket } = await laissoWithCheck('if [ -f .ready ]; then laisso route ahead --note "ready early"; else echo "no .ready yet"; exit 1; fi', routed);
    // `laisso` inside the check is this checkout's CLI, talking to this server.
    await writeFile(path.join(laisso.pathDir, "laisso"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dirname, "..", "bin", "laisso.js")}' --port ${laisso.port} "$@"\n`, { mode: 0o755 });
    await setScene(laisso, ticket.branch, green);
    await ready(ticket.worktree);
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "action ready met; review finished"]);
    const d = await detailOf(laisso, ticket.id);
    expect(d.flag).toBeNull();
    expect(d.stage.name).toBe("later");
  });
});
