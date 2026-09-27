import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { startLassoWithRepos, waitFor, claudeFixture, type Lasso, type LassoConfig, type RepoSpec } from "./harness.ts";
import type { TicketDetail, IntakeResult, TicketView } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: a Ticket's end of life (ADR 0007), watched through the API, the
// temp origin, and the gh/acli shim.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `runner: claude
stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
`;

const PR_URL = "https://github.com/owner/app/pull/7";
const WIP = "wip: abandoned in Lasso";

async function lassoWith(spec: RepoSpec, extra: LassoConfig = {}) {
  const started = await startLassoWithRepos({ app: { ...spec, pipeline: "one" } }, extra, { one: PIPELINE });
  running.push(started.lasso);
  return started;
}

async function lassoWithTicket(extra: LassoConfig = {}) {
  const started = await lassoWith({}, extra);
  const ticket = await started.lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "one" }) });
  return { ...started, ticket };
}

const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (lasso: Lasso, id: string, trigger: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/${trigger}`, { method: "POST", body: "{}" });
const ghCalls = async (lasso: Lasso) => (await lasso.tracker.calls()).filter((c) => c.tool === "gh").map((c) => c.args.join(" "));
const noPr = (lasso: Lasso) => lasso.tracker.reply({ tool: "gh", match: ["pr view"], code: 1, stderr: "no pull requests found for branch\n" });

/** Run the one Stage to its end: a commit on the branch and a succeeded Outcome. */
async function finish(lasso: Lasso, id: string): Promise<TicketDetail> {
  await lasso.runner.script({ commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], stdout: claudeFixture("success.json") });
  await checkNow(lasso);
  return finished(lasso, id);
}

/** Done is written before the worktree goes, so both are waited for. */
async function finished(lasso: Lasso, id: string): Promise<TicketDetail> {
  const done = await waitFor(async () => { const d = await detailOf(lasso, id); return d.state === "done" ? d : null; }, "the Ticket to be done");
  await waitFor(async () => (existsSync(done.worktree) ? null : true), "the worktree to go");
  return done;
}

describe("end of life", () => {
  it("done removes the worktree and the local branch, and keeps the Ticket directory and rows", async () => {
    const { lasso, repos, ticket } = await lassoWithTicket();
    const done = await finish(lasso, ticket.id);
    expect(existsSync(ticket.worktree)).toBe(false);
    expect(repos.app.git(["worktree", "list"])).not.toContain(ticket.worktree);
    expect(repos.app.git(["branch", "--list", ticket.branch])).toBe("");
    // The directory outlives the worktree so the Session's stdout stays readable (ADR 0007).
    const dir = path.dirname(ticket.worktree);
    expect(existsSync(path.join(dir, "sessions"))).toBe(true);
    expect(done.sessions).toHaveLength(1);
    expect((await lasso.api<{ text: string; ended: boolean }>(`/api/tickets/${ticket.id}/sessions/${done.sessions[0]!.id}/stdout?offset=0`)).ended).toBe(true);
    // At the default retention the next tick leaves the directory alone.
    expect((await checkNow(lasso)).changes).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(await lasso.api<TicketView[]>("/api/tickets")).toEqual([]);
    expect((await lasso.api<TicketView[]>("/api/tickets?all=1")).map((t) => [t.id, t.display.state])).toEqual([[ticket.id, "done"]]);
  });

  it("Abandon commits and pushes uncommitted work, removes the worktree, keeps the branch, and closes the open PR with a marked comment", async () => {
    const { lasso, repos, ticket } = await lassoWithTicket();
    await lasso.tracker.reply({ tool: "gh", match: ["pr view", ticket.branch], stdout: JSON.stringify({ number: 7, url: PR_URL, state: "OPEN" }) });
    await lasso.tracker.reply({ tool: "gh", match: ["pr close"], stdout: "" });
    // The Runner pushes a commit, leaves a file uncommitted, and hangs.
    await lasso.runner.script({ files: { "notes.txt": "draft\n" }, commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"], ["git", "push", "-q", "-u", "origin", "HEAD"]], hang: true });
    await checkNow(lasso);
    await waitFor(async () => (repos.app.git(["ls-remote", "--heads", "origin", ticket.branch]) ? true : null), "the Runner to push");

    const abandoned = await pull(lasso, ticket.id, "abandon");
    expect(abandoned).toMatchObject({ state: "abandoned" });
    expect(abandoned.session).toMatchObject({ running: false, outcome: "interrupted", endedReason: "abandon" });
    expect(existsSync(ticket.worktree)).toBe(false);
    expect(repos.app.git(["worktree", "list"])).not.toContain(ticket.worktree);
    expect(repos.app.git(["log", "-1", "--format=%s", ticket.branch])).toBe(WIP);
    expect(repos.app.git(["show", "--stat", "--format=", ticket.branch])).toContain("notes.txt");
    expect(repos.app.git(["ls-remote", "--heads", "origin", ticket.branch])).toContain(repos.app.git(["rev-parse", ticket.branch]));
    const gh = await ghCalls(lasso);
    expect(gh).toHaveLength(2);
    expect(gh[0]).toBe(`pr view ${ticket.branch} --json number,url,state`);
    expect(gh[1]).toContain(`pr close ${PR_URL} --comment `);
    expect(gh[1]).toContain(`<!-- lasso:${ticket.id}:abandoned -->`);
  });

  it("Abandon with no PR and no remote branch commits the work locally and closes nothing", async () => {
    const { lasso, repos, ticket } = await lassoWithTicket();
    await noPr(lasso);
    await lasso.runner.script({ files: { "notes.txt": "draft\n" }, hang: true });
    await checkNow(lasso);
    await waitFor(async () => (existsSync(path.join(ticket.worktree, "notes.txt")) ? true : null), "the Runner to write");

    await pull(lasso, ticket.id, "abandon");
    expect(existsSync(ticket.worktree)).toBe(false);
    expect(repos.app.git(["log", "-1", "--format=%s", ticket.branch])).toBe(WIP);
    expect(repos.app.git(["ls-remote", "--heads", "origin", ticket.branch])).toBe("");
    expect(await ghCalls(lasso)).toEqual([`pr view ${ticket.branch} --json number,url,state`]);
    // A clean worktree gets no WIP commit: the second Ticket's branch is what its Runner left.
    const clean = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Rename", repo: "app", pipeline: "one" }) });
    await lasso.runner.script({ commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], hang: true });
    await checkNow(lasso);
    await waitFor(async () => (repos.app.git(["log", "-1", "--format=%s", clean.branch]) === "work" ? true : null), "the Runner to commit");
    await pull(lasso, clean.id, "abandon");
    expect(repos.app.git(["log", "-1", "--format=%s", clean.branch])).toBe("work");
  });

  it("re-intake of an Abandoned reference makes a new Ticket on the kept branch", async () => {
    const { lasso, repos } = await lassoWith({ tracker: "jira", project: "APP" });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "summary,description"], stdout: JSON.stringify({ key: "APP-12", fields: { summary: "Add dark mode", description: "Body." } }) });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: JSON.stringify({ key: "APP-12", fields: { labels: [] } }), once: true });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: JSON.stringify({ key: "APP-12", fields: { labels: ["lasso:implement"] } }) });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem search"], stdout: "[]" });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem edit"], stdout: "✓ ok\n" });
    await noPr(lasso);
    const first = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "APP-12" }) });
    expect(first.branchExisted).toBe(false);
    await lasso.runner.script({ commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], hang: true });
    await checkNow(lasso);
    await waitFor(async () => (repos.app.git(["log", "-1", "--format=%s", first.branch]) === "work" ? true : null), "the Runner to commit");
    await pull(lasso, first.id, "abandon");
    // The tracker's status is untouched; only Lasso's labels go.
    const acli = (await lasso.tracker.calls()).filter((c) => c.tool === "acli").map((c) => c.args.join(" "));
    expect(acli.filter((a) => a.includes("transition"))).toEqual([]);
    expect(acli.at(-1)).toBe("jira workitem edit --key APP-12 --remove-labels lasso:implement --yes");

    const second = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "APP-12" }) });
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ branch: first.branch, branchExisted: true, state: "active" });
    expect(repos.app.git(["log", "-1", "--format=%s"], second.worktree)).toBe("work");
    expect((await lasso.api<TicketView[]>("/api/tickets?all=1")).map((t) => [t.id, t.state])).toEqual([[second.id, "active"], [first.id, "abandoned"]]);
  });

  it("sweeps a done Ticket's directory after retention days and keeps its rows", async () => {
    const { lasso, ticket } = await lassoWithTicket({ retention: 0 });
    const done = await finish(lasso, ticket.id);
    const dir = path.dirname(ticket.worktree);
    expect((await checkNow(lasso)).changes).toEqual([{ ticket: ticket.id, summary: "directory swept, 0 days after done" }]);
    expect(existsSync(dir)).toBe(false);
    const after = await detailOf(lasso, ticket.id);
    expect(after).toMatchObject({ state: "done", display: { state: "done" } });
    expect(after.sessions.map((s) => s.id)).toEqual(done.sessions.map((s) => s.id));
    expect(await lasso.api(`/api/tickets/${ticket.id}/sessions/${done.sessions[0]!.id}/stdout?offset=0`)).toEqual({ text: "", offset: 0, ended: true });
    expect((await checkNow(lasso)).changes).toEqual([]);
  });

  it("keeps a worktree whose WIP commit failed, still closes the PR, and sweeps it through git at retention", async () => {
    const { lasso, repos, ticket } = await lassoWithTicket({ retention: 0 });
    await lasso.tracker.reply({ tool: "gh", match: ["pr view"], stdout: JSON.stringify({ number: 7, url: PR_URL, state: "OPEN" }) + "\n" });
    await lasso.tracker.reply({ tool: "gh", match: ["pr close"], stdout: "" });
    await lasso.runner.script({ files: { "notes.txt": "draft\n" }, hang: true });
    await checkNow(lasso);
    await waitFor(async () => (existsSync(path.join(ticket.worktree, "notes.txt")) ? true : null), "the Runner to write");
    // Signing with no key makes the WIP commit fail; the uncommitted work is not discarded.
    repos.app.git(["config", "commit.gpgsign", "true"]);
    repos.app.git(["config", "user.signingkey", "0000000000000000"]);

    const abandoned = await pull(lasso, ticket.id, "abandon");
    expect(abandoned.state).toBe("abandoned");
    expect(existsSync(path.join(ticket.worktree, "notes.txt"))).toBe(true);
    expect(repos.app.git(["log", "-1", "--format=%s", ticket.branch])).not.toBe(WIP);
    expect((await ghCalls(lasso)).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["pr view", "pr close"]);
    const log = readFileSync(path.join(lasso.home, "lasso.log"), "utf8");
    expect(log).toContain("ticket.teardown_failed ticket=" + ticket.id + " step=wip");

    // At retention the sweep removes the worktree through git, so nothing dangles, then the directory.
    expect((await checkNow(lasso)).changes).toEqual([{ ticket: ticket.id, summary: "directory swept, 0 days after abandoned" }]);
    expect(existsSync(path.dirname(ticket.worktree))).toBe(false);
    expect(repos.app.git(["worktree", "list"])).not.toContain(ticket.worktree);
    expect(repos.app.git(["branch", "--list", ticket.branch])).toContain(ticket.branch);
  });

  it("puts done and Abandoned Tickets behind a toggle on the dashboard, greyed", async () => {
    const { lasso } = await lassoWithTicket();
    const html = await (await lasso.page("/")).text();
    expect(html).toContain("Show done and Abandoned");
    expect(html).toContain("/api/tickets?all=1");
    expect(html).toContain(".ticket.ended");
  });
});
