import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrLinks } from "../src/store/links.ts";
import { Tickets } from "../src/store/tickets.ts";
import { startLaissoWithRepos, waitFor, claudeFixture, type Laisso, type LaissoConfig, type RepoSpec } from "./harness.ts";
import type { TicketDetail, IntakeResult, TicketView } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: a Ticket's end of life (ADR 0007), watched through the API, the
// temp origin, and the gh/acli shim.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
`;

const PR_URL = "https://github.com/owner/app/pull/7";
const WIP = "wip: abandoned in Laisso";

async function laissoWith(spec: RepoSpec, extra: LaissoConfig = {}) {
  const started = await startLaissoWithRepos({ app: { ...spec, pipeline: "one" } }, extra, { one: PIPELINE });
  running.push(started.laisso);
  return started;
}

async function laissoWithTicket(extra: LaissoConfig = {}) {
  const started = await laissoWith({}, extra);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "one" }) });
  return { ...started, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (laisso: Laisso, id: string, trigger: string) => laisso.api<TicketDetail>(`/api/tickets/${id}/${trigger}`, { method: "POST", body: "{}" });
const ghCalls = async (laisso: Laisso) => (await laisso.tracker.calls()).filter((c) => c.tool === "gh").map((c) => c.args.join(" "));
const noPr = (laisso: Laisso) => laisso.tracker.reply({ tool: "gh", match: ["pr view"], code: 1, stderr: "no pull requests found for branch\n" });

/** Run the one Stage to its end: a commit on the branch and a succeeded Outcome. */
async function finish(laisso: Laisso, id: string): Promise<TicketDetail> {
  await laisso.runner.script({ commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], stdout: claudeFixture("success.json") });
  await checkNow(laisso);
  return finished(laisso, id);
}

/** Done is written before the worktree goes, so both are waited for. */
async function finished(laisso: Laisso, id: string): Promise<TicketDetail> {
  const done = await waitFor(async () => { const d = await detailOf(laisso, id); return d.state === "done" ? d : null; }, "the Ticket to be done");
  await waitFor(async () => (existsSync(done.worktree) ? null : true), "the worktree to go");
  return done;
}

describe("end of life", () => {
  it("done removes the worktree and the local branch, and keeps the Ticket directory and rows", async () => {
    const { laisso, repos, ticket } = await laissoWithTicket();
    const done = await finish(laisso, ticket.id);
    expect(existsSync(ticket.worktree)).toBe(false);
    expect(repos.app.git(["worktree", "list"])).not.toContain(ticket.worktree);
    expect(repos.app.git(["branch", "--list", ticket.branch])).toBe("");
    // The directory outlives the worktree so the Session's stdout stays readable (ADR 0007).
    const dir = path.dirname(ticket.worktree);
    expect(existsSync(path.join(dir, "sessions"))).toBe(true);
    expect(done.sessions).toHaveLength(1);
    expect((await laisso.api<{ text: string; ended: boolean }>(`/api/tickets/${ticket.id}/sessions/${done.sessions[0]!.id}/stdout?offset=0`)).ended).toBe(true);
    // At the default retention the next tick leaves the directory alone.
    expect((await checkNow(laisso)).changes).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(await laisso.api<TicketView[]>("/api/tickets")).toEqual([]);
    expect((await laisso.api<TicketView[]>("/api/tickets?all=1")).map((t) => [t.id, t.display.state])).toEqual([[ticket.id, "done"]]);
  });

  it("Abandon commits and pushes uncommitted work, removes the worktree, keeps the branch, and closes the open PR with a marked comment", async () => {
    const { laisso, repos, ticket } = await laissoWithTicket();
    await laisso.tracker.reply({ tool: "gh", match: ["pr view", ticket.branch], stdout: JSON.stringify({ number: 7, url: PR_URL, state: "OPEN" }) });
    await laisso.tracker.reply({ tool: "gh", match: ["pr close"], stdout: "" });
    // The Runner pushes a commit, leaves a file uncommitted, and hangs.
    await laisso.runner.script({ files: { "notes.txt": "draft\n" }, commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"], ["git", "push", "-q", "-u", "origin", "HEAD"]], hang: true });
    await checkNow(laisso);
    await waitFor(async () => (repos.app.git(["ls-remote", "--heads", "origin", ticket.branch]) ? true : null), "the Runner to push");

    const abandoned = await pull(laisso, ticket.id, "abandon");
    expect(abandoned).toMatchObject({ state: "abandoned" });
    expect(abandoned.session).toMatchObject({ running: false, outcome: "interrupted", endedReason: "abandon" });
    expect(existsSync(ticket.worktree)).toBe(false);
    expect(repos.app.git(["worktree", "list"])).not.toContain(ticket.worktree);
    expect(repos.app.git(["log", "-1", "--format=%s", ticket.branch])).toBe(WIP);
    expect(repos.app.git(["show", "--stat", "--format=", ticket.branch])).toContain("notes.txt");
    expect(repos.app.git(["ls-remote", "--heads", "origin", ticket.branch])).toContain(repos.app.git(["rev-parse", ticket.branch]));
    const gh = await ghCalls(laisso);
    expect(gh).toHaveLength(2);
    expect(gh[0]).toBe(`pr view ${ticket.branch} --json number,url,state`);
    expect(gh[1]).toContain(`pr close ${PR_URL} --comment `);
    expect(gh[1]).toContain(`<!-- laisso:${ticket.id}:abandoned -->`);
  });

  it("Abandon with no PR and no remote branch commits the work locally and closes nothing", async () => {
    const { laisso, repos, ticket } = await laissoWithTicket();
    await noPr(laisso);
    await laisso.runner.script({ files: { "notes.txt": "draft\n" }, hang: true });
    await checkNow(laisso);
    await waitFor(async () => (existsSync(path.join(ticket.worktree, "notes.txt")) ? true : null), "the Runner to write");

    await pull(laisso, ticket.id, "abandon");
    expect(existsSync(ticket.worktree)).toBe(false);
    expect(repos.app.git(["log", "-1", "--format=%s", ticket.branch])).toBe(WIP);
    expect(repos.app.git(["ls-remote", "--heads", "origin", ticket.branch])).toBe("");
    expect(await ghCalls(laisso)).toEqual([`pr view ${ticket.branch} --json number,url,state`]);
    // A clean worktree gets no WIP commit: the second Ticket's branch is what its Runner left.
    const clean = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Rename", repo: "app", pipeline: "one" }) });
    await laisso.runner.script({ commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], hang: true });
    await checkNow(laisso);
    await waitFor(async () => (repos.app.git(["log", "-1", "--format=%s", clean.branch]) === "work" ? true : null), "the Runner to commit");
    await pull(laisso, clean.id, "abandon");
    expect(repos.app.git(["log", "-1", "--format=%s", clean.branch])).toBe("work");
  });

  it("Abandon closes only the ticked open Owned PRs, each naming its own head branch, and leaves the rest for another Ticket", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const url = (n: number, repo = "owner/app") => `https://github.com/${repo}/pull/${n}`;
    // Two ticked open Owned PRs, one unticked, one merged, and a Referenced PR from another repo, all on the request but the unticked one.
    const links: Array<[number, string, string, string, string]> = [
      [7, url(7), "owned", "OPEN", "split-schema"],
      [8, url(8), "owned", "OPEN", "split-feature"],
      [12, url(12), "owned", "OPEN", "split-extra"],
      [9, url(9), "owned", "MERGED", "split-done"],
      [10, url(10, "them/lib"), "referenced", "OPEN", "their-branch"],
    ];
    const db = new DatabaseSync(path.join(laisso.home, "laisso.db"));
    const insert = db.prepare(`INSERT INTO ticket_prs (ticket, url, role, source, added_at, title, head, base, state) VALUES (?, ?, ?, 'human', ?, ?, ?, 'main', ?)`);
    links.forEach(([n, u, role, state, head], i) => insert.run(ticket.id, u, role, `2026-10-19T10:00:0${i}Z`, `PR ${n}`, head, state));
    db.close();
    for (const [n, u] of links) await laisso.tracker.reply({ tool: "gh", match: ["pr view", u], stdout: JSON.stringify({ number: n, url: u, state: "OPEN" }) });
    await laisso.tracker.reply({ tool: "gh", match: ["pr close"], stdout: "" });

    const close = [url(7), url(8), url(9), url(10, "them/lib"), url(99)];
    const abandoned = await laisso.api<TicketDetail>(`/api/tickets/${ticket.id}/abandon`, { method: "POST", body: JSON.stringify({ close }) });
    expect(abandoned.state).toBe("abandoned");
    const gh = await ghCalls(laisso);
    expect(gh.map((c) => c.split(" --comment ")[0])).toEqual([`pr view ${url(7)} --json number,url,state`, `pr close ${url(7)}`, `pr view ${url(8)} --json number,url,state`, `pr close ${url(8)}`]);
    expect(gh[1]).toContain("The branch `split-schema` is kept.");
    expect(gh[3]).toContain("The branch `split-feature` is kept.");
    for (const c of [gh[1], gh[3]]) expect(c).toContain(`<!-- laisso:${ticket.id}:abandoned -->`);

    // The unticked PR is free for another Ticket to own.
    const next = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Finish the split", repo: "app", pipeline: "one" }) });
    const store = new DatabaseSync(path.join(laisso.home, "laisso.db"));
    try {
      const prLinks = new PrLinks(store);
      expect(prLinks.link(new Tickets(store).get(next.id)!, url(12), "owned", "human")).toEqual({ link: expect.objectContaining({ role: "owned", url: url(12) }) });
    } finally {
      store.close();
    }
  });

  it("re-intake of an Abandoned reference makes a new Ticket on the kept branch", async () => {
    const { laisso, repos } = await laissoWith({ tracker: "jira", project: "APP" });
    await laisso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "summary,description"], stdout: JSON.stringify({ key: "APP-12", fields: { summary: "Add dark mode", description: "Body." } }) });
    await laisso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: JSON.stringify({ key: "APP-12", fields: { labels: [] } }), once: true });
    await laisso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: JSON.stringify({ key: "APP-12", fields: { labels: ["laisso:implement"] } }) });
    await laisso.tracker.reply({ tool: "acli", match: ["workitem search"], stdout: "[]" });
    await laisso.tracker.reply({ tool: "acli", match: ["workitem edit"], stdout: "✓ ok\n" });
    await noPr(laisso);
    const first = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "APP-12" }) });
    expect(first.branchExisted).toBe(false);
    await laisso.runner.script({ commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], hang: true });
    await checkNow(laisso);
    await waitFor(async () => (repos.app.git(["log", "-1", "--format=%s", first.branch]) === "work" ? true : null), "the Runner to commit");
    await pull(laisso, first.id, "abandon");
    // The tracker's status is untouched; only Laisso's labels go.
    const acli = (await laisso.tracker.calls()).filter((c) => c.tool === "acli").map((c) => c.args.join(" "));
    expect(acli.filter((a) => a.includes("transition"))).toEqual([]);
    expect(acli.at(-1)).toBe("jira workitem edit --key APP-12 --remove-labels laisso:implement --yes");

    const second = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "APP-12" }) });
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ branch: first.branch, branchExisted: true, state: "active" });
    expect(repos.app.git(["log", "-1", "--format=%s"], second.worktree)).toBe("work");
    expect((await laisso.api<TicketView[]>("/api/tickets?all=1")).map((t) => [t.id, t.state])).toEqual([[second.id, "active"], [first.id, "abandoned"]]);
  });

  it("sweeps a done Ticket's directory after retention days and keeps its rows", async () => {
    const { laisso, ticket } = await laissoWithTicket({ retention: 0 });
    const done = await finish(laisso, ticket.id);
    const dir = path.dirname(ticket.worktree);
    // The last Session's end kicks the tick, and its sweep finds retention already reached.
    await waitFor(async () => (existsSync(dir) ? null : true), "the directory to be swept");
    expect(laisso.stdout()).toMatch(/ticket\.swept ticket=\S+ state=done days=0/);
    const after = await detailOf(laisso, ticket.id);
    expect(after).toMatchObject({ state: "done", display: { state: "done" } });
    expect(after.sessions.map((s) => s.id)).toEqual(done.sessions.map((s) => s.id));
    expect(await laisso.api(`/api/tickets/${ticket.id}/sessions/${done.sessions[0]!.id}/stdout?offset=0`)).toEqual({ text: "", offset: 0, ended: true });
    expect((await checkNow(laisso)).changes).toEqual([]);
  });

  it("keeps a worktree whose WIP commit failed, still closes the PR, and sweeps it through git at retention", async () => {
    // Retention drops to 0 only once the checks below are done: the killed Session's end kicks a tick that would sweep.
    const { laisso, repos, ticket } = await laissoWithTicket({ retention: 1 });
    await laisso.tracker.reply({ tool: "gh", match: ["pr view"], stdout: JSON.stringify({ number: 7, url: PR_URL, state: "OPEN" }) + "\n" });
    await laisso.tracker.reply({ tool: "gh", match: ["pr close"], stdout: "" });
    await laisso.runner.script({ files: { "notes.txt": "draft\n" }, hang: true });
    await checkNow(laisso);
    await waitFor(async () => (existsSync(path.join(ticket.worktree, "notes.txt")) ? true : null), "the Runner to write");
    // Signing with no key makes the WIP commit fail; the uncommitted work is not discarded.
    repos.app.git(["config", "commit.gpgsign", "true"]);
    repos.app.git(["config", "user.signingkey", "0000000000000000"]);

    const abandoned = await pull(laisso, ticket.id, "abandon");
    expect(abandoned.state).toBe("abandoned");
    expect(existsSync(path.join(ticket.worktree, "notes.txt"))).toBe(true);
    expect(repos.app.git(["log", "-1", "--format=%s", ticket.branch])).not.toBe(WIP);
    expect((await ghCalls(laisso)).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["pr view", "pr close"]);
    const log = readFileSync(path.join(laisso.home, "laisso.log"), "utf8");
    expect(log).toContain("ticket.teardown_failed ticket=" + ticket.id + " step=wip");

    // At retention the sweep removes the worktree through git, so nothing dangles, then the directory.
    await laisso.api("/api/config", { method: "PATCH", body: JSON.stringify({ retention: 0 }) });
    expect((await checkNow(laisso)).changes).toEqual([{ ticket: ticket.id, summary: "directory swept, 0 days after abandoned" }]);
    expect(existsSync(path.dirname(ticket.worktree))).toBe(false);
    expect(repos.app.git(["worktree", "list"])).not.toContain(ticket.worktree);
    expect(repos.app.git(["branch", "--list", ticket.branch])).toContain(ticket.branch);
  });
});
