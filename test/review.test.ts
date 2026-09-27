import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startLassoWithRepos, runCli, waitFor, claudeFixture, type Lasso, type TrackerReply } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: the Review loop through the API. The gh shim plays the PR: one
// scene per state of the PR, swapped by the fake Runner mid-Round the way a
// real Runner would change the PR by replying, resolving and pushing.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `runner: claude
stages:
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
`;

const PR_URL = "https://github.com/owner/app/pull/7";

interface Scene {
  state?: "OPEN" | "CLOSED" | "MERGED";
  head?: string;
  decision?: string | null;
  reviews?: Array<{ id: number; state: string; author: string; body: string; at: string }>;
  threads?: Array<{ id: string; resolved: boolean; path: string; line: number; comments: Array<{ id: number; author: string; body: string; at: string }> }>;
  comments?: Array<{ id: number; author: string; body: string; at: string }>;
  checks?: Array<{ id: number; name: string; status: string; conclusion: string | null; at: string }>;
  logs?: Record<number, string>;
  /** Distinguishes the ETags of one scene from another's. */
  tag: string;
}

const http = (status: number, etag: string, body?: unknown) => `HTTP/2.0 ${status} ${status === 200 ? "OK" : "Not Modified"}\r\nEtag: ${etag}\r\nX-Ratelimit-Remaining: 4999\r\n\r\n${body === undefined ? "" : JSON.stringify(body)}`;

/** The gh replies that play one state of the PR: discovery, the GraphQL query, and the three REST reads with ETags. */
function replies(branch: string, scene: Scene): TrackerReply[] {
  const state = scene.state ?? "OPEN";
  const head = scene.head ?? "aaaaaaa1";
  const url = (kind: string, id: number | string) => `${PR_URL}#${kind}-${id}`;
  const graphql = {
    data: {
      repository: {
        pullRequest: {
          number: 7,
          url: PR_URL,
          state,
          headRefOid: head,
          reviewDecision: scene.decision ?? null,
          reviewCount: { totalCount: (scene.reviews ?? []).length },
          reviews: { nodes: (scene.reviews ?? []).map((r) => ({ databaseId: r.id, state: r.state, body: r.body, submittedAt: r.at, url: url("review", r.id), author: { login: r.author } })) },
          reviewThreads: {
            nodes: (scene.threads ?? []).map((t) => ({
              id: t.id,
              isResolved: t.resolved,
              isOutdated: false,
              path: t.path,
              line: t.line,
              comments: { nodes: t.comments.map((c) => ({ databaseId: c.id, author: { login: c.author }, body: c.body, createdAt: c.at, updatedAt: c.at, url: url("discussion_r", c.id) })) },
            })),
          },
        },
      },
    },
  };
  const comments = (scene.comments ?? []).map((c) => ({ id: c.id, user: { login: c.author }, body: c.body, created_at: c.at, updated_at: c.at, html_url: url("issuecomment", c.id) }));
  const inline = (scene.threads ?? []).flatMap((t) => t.comments.map((c) => ({ id: c.id, user: { login: c.author }, body: c.body, path: t.path, line: t.line, created_at: c.at, updated_at: c.at, html_url: url("discussion_r", c.id) })));
  const checks = { check_runs: (scene.checks ?? []).map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, html_url: url("check", c.id), started_at: c.at, completed_at: c.at })) };
  const rest = (match: string, etag: string, body: unknown): TrackerReply[] => [
    { tool: "gh", match: [match, `If-None-Match: ${etag}`], stdout: http(304, etag), stderr: "gh: HTTP 304", code: 1 },
    { tool: "gh", match: [match], stdout: http(200, etag, body) },
  ];
  return [
    { tool: "gh", match: ["pr view", branch], stdout: JSON.stringify({ number: 7, url: PR_URL, state }) },
    { tool: "gh", match: ["api graphql", "n=7"], stdout: JSON.stringify(graphql) },
    ...rest("issues/7/comments", `W/"${scene.tag}-comments"`, comments),
    ...rest("pulls/7/comments", `W/"${scene.tag}-inline"`, inline),
    ...rest(`commits/${head}/check-runs`, `W/"${scene.tag}-checks"`, checks),
    ...Object.entries(scene.logs ?? {}).map(([job, text]): TrackerReply => ({ tool: "gh", match: [`actions/jobs/${job}/logs`], stdout: text })),
  ];
}

const repliesFile = (lasso: Lasso) => path.join(lasso.pathDir, "tracker-replies.json");

/** Make the shim play this scene from now on. */
async function setScene(lasso: Lasso, branch: string, scene: Scene): Promise<void> {
  await writeFile(repliesFile(lasso), JSON.stringify(replies(branch, scene)));
}

/** A scene file the fake Runner copies over the replies mid-Round: what the Runner "did" to the PR. */
async function sceneFile(lasso: Lasso, branch: string, name: string, scene: Scene): Promise<string> {
  const file = path.join(lasso.pathDir, `scene-${name}.json`);
  await writeFile(file, JSON.stringify(replies(branch, scene)));
  return file;
}

const swapTo = (lasso: Lasso, file: string) => [["cp", file, repliesFile(lasso)]];

async function lassoWithTicket(pipeline = PIPELINE) {
  const started = await startLassoWithRepos({ app: { pipeline: "loop" } }, {}, { loop: pipeline });
  running.push(started.lasso);
  const ticket = await started.lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "loop" }) });
  return { ...started, ticket };
}

const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (lasso: Lasso, id: string, lever: string, body: object = {}) => lasso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const settled = (lasso: Lasso, id: string, count = 1) => waitFor(async () => {
  const d = await detailOf(lasso, id);
  return d.sessions.length >= count && d.sessions.every((s) => !s.running) ? d : null;
}, "the Round to end");
const launched = (lasso: Lasso, count: number) => waitFor(async () => { const c = await lasso.runner.calls(); return c.length >= count ? c : null; }, `${count} Runner launches`);

const T0 = "2026-09-27T10:00:00Z";
const T1 = "2026-09-27T10:05:00Z";
const T2 = "2026-09-27T10:10:00Z";
const T3 = "2026-09-27T11:00:00Z";
const marker = (ticket: string, round: number) => `<!-- lasso:${ticket}:review:round-${round} -->`;

const green: Scene = { tag: "green", checks: [{ id: 1, name: "test", status: "completed", conclusion: "success", at: T0 }] };

describe("the Review loop", () => {
  it("polls the PR each tick with ETags and never launches a Round on an empty diff", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await setScene(lasso, ticket.branch, green);

    const first = await checkNow(lasso);
    expect(first.changes).toEqual([{ ticket: ticket.id, summary: "PR #7 found" }]);
    const d = await detailOf(lasso, ticket.id);
    expect(d.pr).toBe(PR_URL);
    expect(d.display).toEqual({ state: "quiet", label: "Quiet", why: "PR #7: checks green, nothing outstanding" });
    expect(d.sessions).toEqual([]);

    await lasso.tracker.clearCalls();
    expect((await checkNow(lasso)).changes).toEqual([]);
    const calls = await lasso.tracker.calls();
    const conditional = calls.filter((c) => c.args.includes("-i")).map((c) => [c.args[c.args.indexOf("-H") + 1], c.args.find((a) => a.startsWith("repos/"))]);
    // The three reads run in parallel, so compare them as a set.
    expect(conditional.sort()).toEqual([
      ['If-None-Match: W/"green-checks"', "repos/owner/app/commits/aaaaaaa1/check-runs"],
      ['If-None-Match: W/"green-comments"', "repos/owner/app/issues/7/comments"],
      ['If-None-Match: W/"green-inline"', "repos/owner/app/pulls/7/comments"],
    ]);
    expect(calls.some((c) => c.args.includes("pr"))).toBe(false);
    expect(await lasso.runner.calls()).toEqual([]);
    expect((await detailOf(lasso, ticket.id)).display.state).toBe("quiet");
  });

  it("opens a Round on new Feedback with the snapshot and marker in the prompt, records what it addressed, and goes quiet", async () => {
    const { lasso, ticket } = await lassoWithTicket();
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
      threads: [{ id: "RT_1", resolved: true, path: "src/a.ts", line: 12, comments: [...asked.threads![0]!.comments, { id: 102, author: "lasso-bot", body: `Done.\n${mark}`, at: T2 }] }],
      comments: [...asked.comments!, { id: 202, author: "lasso-bot", body: `Added the entry.\n${mark}`, at: T2 }],
      checks: [{ id: 901, name: "test", status: "in_progress", conclusion: null, at: T2 }],
    };
    await setScene(lasso, ticket.branch, asked);
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(lasso, await sceneFile(lasso, ticket.branch, "addressed", addressed)) });

    const tick = await checkNow(lasso);
    expect(tick.changes).toEqual([
      { ticket: ticket.id, summary: "PR #7 found" },
      { ticket: ticket.id, summary: "PR #7: 3 new Feedback items: check test failed, thread on src/a.ts:12 by alice, comment by bob" },
      { ticket: ticket.id, summary: "started review Round 1" },
    ]);
    const [call] = await launched(lasso, 1);
    const prompt = call!.argv[2]!;
    expect(prompt).toContain("Feedback on PR #7 (https://github.com/owner/app/pull/7), Round 1: 4 items.");
    expect(prompt).toContain(`1. [check 900] check test failed ${PR_URL}#check-900`);
    expect(prompt).toContain("   | ##[group]Run pnpm test\n   | FAIL test/a.test.ts\n   | ##[error]Process completed with exit code 1.");
    expect(prompt).toContain(`2. [thread RT_1] thread on src/a.ts:12 by alice at src/a.ts:12 ${PR_URL}#discussion_r-101\n   > alice: Use a Map here.`);
    expect(prompt).toContain(`3. [comment 201] comment by bob ${PR_URL}#issuecomment-201\n   > Please add a changelog entry.`);
    expect(prompt).toContain(`4. [verdict 55] changes requested by alice ${PR_URL}#review-55\n   > Two things.`);
    expect(prompt).toContain(`Reply to each comment separately, and end every comment you post on the PR with this marker, on its own line: ${mark}`);
    expect(call!.env).toMatchObject({ LASSO_STAGE: "review", LASSO_ROUND: "1", LASSO_MARKER: mark });

    const d = await settled(lasso, ticket.id);
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
    expect(d.pr).toBe(PR_URL);
    expect(d.budget.attempts).toEqual({ used: 1, limit: 2, source: "global" });

    // The Round's own marked comments are not Feedback: the next tick finds nothing new.
    expect((await checkNow(lasso)).changes).toEqual([]);
    expect(await lasso.runner.calls()).toHaveLength(1);
  });

  it("Flags review.unaddressed when a Round leaves an item standing; Retry re-runs the same Round", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    const asked: Scene = { ...green, tag: "asked", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    await setScene(lasso, ticket.branch, asked);
    await lasso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(lasso);
    const flagged = await settled(lasso, ticket.id);
    expect(flagged.flag).toMatchObject({ reason: "review.unaddressed", detail: "1 of 1 Feedback items unaddressed: comment by bob" });
    expect(flagged.session!.feedback).toEqual([{ kind: "comment", id: "201", summary: "comment by bob", url: `${PR_URL}#issuecomment-201`, path: null, line: null, addressed: null }]);
    expect(flagged.display.why).toBe("review.unaddressed");

    // Still polled while Flagged: nothing new on the PR, no Round, no second Flag.
    expect((await checkNow(lasso)).changes).toEqual([]);

    const replied: Scene = { ...asked, tag: "replied", comments: [...asked.comments!, { id: 202, author: "lasso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(lasso, await sceneFile(lasso, ticket.branch, "replied", replied)) });
    const retried = await pull(lasso, ticket.id, "retry");
    expect(retried.session).toMatchObject({ ordinal: 2, round: 1, running: true, startedBy: "human" });
    expect(retried.display).toEqual({ state: "running", label: "Running", why: "review, Round 1 of 5" });
    const [, second] = await launched(lasso, 2);
    expect(second!.argv[2]).toContain("[comment 201] comment by bob");
    const done = await settled(lasso, ticket.id, 2);
    expect(done.flag).toBeNull();
    expect(done.session!.feedback[0]!.addressed).toBe(`replied ${PR_URL}#issuecomment-202`);
    expect(done.budget.rounds).toEqual({ used: 1, limit: 5, source: "global" });
    expect(done.budget.attempts).toEqual({ used: 2, limit: 2, source: "global" });
    expect(done.display.state).toBe("quiet");
  });

  it("Flags review.check_repeat when the same check fails in two consecutive Rounds", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    const failing: Scene = { tag: "failing", head: "aaaaaaa1", checks: [{ id: 900, name: "test", status: "completed", conclusion: "failure", at: T1 }] };
    const pushed: Scene = { tag: "pushed", head: "bbbbbbb2", checks: [{ id: 901, name: "test", status: "completed", conclusion: "failure", at: T2 }] };
    await setScene(lasso, ticket.branch, failing);
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(lasso, await sceneFile(lasso, ticket.branch, "pushed", pushed)) });
    expect((await checkNow(lasso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "PR #7: 1 new Feedback item: check test failed", "started review Round 1"]);
    const after = await settled(lasso, ticket.id);
    expect(after.flag).toBeNull();
    expect(after.session!.feedback[0]!.addressed).toBe("new push bbbbbbb");

    const tick = await checkNow(lasso);
    expect(tick.changes).toEqual([{ ticket: ticket.id, summary: "Flagged: check test failed again after Round 1" }]);
    const d = await detailOf(lasso, ticket.id);
    expect(d.flag).toMatchObject({ reason: "review.check_repeat", detail: "check test failed again after Round 1" });
    expect(d.sessions).toHaveLength(1);
    // Retry opens the next Round on the snapshot that Flagged.
    const retried = await pull(lasso, ticket.id, "retry");
    expect(retried.session).toMatchObject({ round: 2, running: true });
    expect(retried.session!.feedback).toEqual([expect.objectContaining({ kind: "check", id: "901" })]);
  });

  it("Flags review.pr_closed when the PR closes unmerged, and finishes the Stage when a human merges it", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await setScene(lasso, ticket.branch, { ...green, state: "CLOSED" });
    expect((await checkNow(lasso)).changes.map((c) => c.summary)).toEqual(["PR #7 found", "Flagged: PR #7 closed without merging"]);
    const closed = await detailOf(lasso, ticket.id);
    expect(closed.flag).toMatchObject({ reason: "review.pr_closed" });
    expect((await checkNow(lasso)).changes).toEqual([]);

    await setScene(lasso, ticket.branch, { ...green, state: "MERGED" });
    expect((await checkNow(lasso)).changes).toEqual([{ ticket: ticket.id, summary: "PR #7 merged; review finished" }]);
    const done = await detailOf(lasso, ticket.id);
    expect(done.state).toBe("done");
    expect(done.flag).toBeNull();
    expect(await lasso.runner.calls()).toEqual([]);
  });

  it("finishes the Stage when the PR is merged by the time a Round ends", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    const asked: Scene = { ...green, tag: "asked", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    await setScene(lasso, ticket.branch, asked);
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(lasso, await sceneFile(lasso, ticket.branch, "merged", { ...asked, tag: "merged", state: "MERGED" })) });
    await checkNow(lasso);
    const done = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    expect(done.flag).toBeNull();
    expect(done.session).toMatchObject({ round: 1, outcome: "succeeded" });
  });

  it("counts Rounds against the Budget, refuses the next past the ceiling, and Extend opens it", async () => {
    const { lasso, ticket } = await lassoWithTicket(PIPELINE.replace("artifact: pr-merged", "artifact: pr-merged\n    budget: { rounds: 1 }"));
    expect(ticket.budget.rounds).toEqual({ used: 0, limit: 1, source: "pipeline" });
    const first: Scene = { ...green, tag: "first", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    const replied: Scene = { ...first, tag: "replied", comments: [...first.comments!, { id: 202, author: "lasso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    await setScene(lasso, ticket.branch, first);
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(lasso, await sceneFile(lasso, ticket.branch, "replied", replied)) });
    await checkNow(lasso);
    const one = await settled(lasso, ticket.id);
    expect(one.budget.rounds).toEqual({ used: 1, limit: 1, source: "pipeline" });
    expect(one.display.state).toBe("quiet");

    const more: Scene = { ...replied, tag: "more", comments: [...replied.comments!, { id: 203, author: "bob", body: "One more thing.", at: T3 }] };
    await setScene(lasso, ticket.branch, more);
    const tick = await checkNow(lasso);
    expect(tick.changes.map((c) => c.summary)).toEqual(["PR #7: 1 new Feedback item: comment by bob", "Flagged: review: 1 of 1 Rounds used"]);
    const refused = await detailOf(lasso, ticket.id);
    expect(refused.flag).toMatchObject({ reason: "budget.rounds", detail: "review: 1 of 1 Rounds used" });
    await expect(pull(lasso, ticket.id, "retry")).rejects.toThrow("review: 1 of 1 Rounds used; Extend the Budget first");

    const answered: Scene = { ...more, tag: "answered", comments: [...more.comments!, { id: 204, author: "lasso-bot", body: `Done.\n${marker(ticket.id, 2)}`, at: "2026-09-27T11:05:00Z" }] };
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(lasso, await sceneFile(lasso, ticket.branch, "answered", answered)) });
    const extended = await pull(lasso, ticket.id, "extend", { rounds: 2 });
    expect(extended.flag).toBeNull();
    expect(extended.session).toMatchObject({ round: 2, ordinal: 2, running: true });
    expect(extended.session!.feedback).toEqual([expect.objectContaining({ kind: "comment", id: "203", addressed: null })]);
    expect(extended.budget.rounds).toEqual({ used: 2, limit: 2, source: "ticket" });
    const two = await settled(lasso, ticket.id, 2);
    expect(two.display).toEqual({ state: "quiet", label: "Quiet", why: "PR #7: checks green, nothing outstanding" });
  });

  it("lasso check reports what changed, or nothing new", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await setScene(lasso, ticket.branch, { ...green, state: "MERGED" });
    const changed = await runCli(["check"], lasso);
    expect(changed.code).toBe(0);
    expect(changed.stdout).toBe(`${ticket.shortId}  PR #7 found; PR #7 merged; review finished\n`);
    const quiet = await runCli(["check", ticket.id], lasso);
    expect(quiet.stdout).toBe("nothing new\n");
    const json = await runCli(["check", "--json"], lasso);
    expect(JSON.parse(json.stdout)).toMatchObject({ changes: [] });
    const other = await runCli(["check", "nope"], lasso);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("no Ticket matches nope");
  });
});
