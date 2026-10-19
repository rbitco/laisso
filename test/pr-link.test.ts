import { describe, it, expect, afterEach } from "vitest";
import { startLassoWithRepos, runCli, makeHome, freePort, waitFor, type Lasso, type TrackerReply } from "./harness.ts";
import type { IntakeResult, PrView, TicketDetail } from "../src/api/views.ts";
import { parsePrRef } from "../src/review/github.ts";

// `lasso pr link | unlink | list` (LASSO-164): the CLI against a running server, gh played by the shim.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

// One human Stage: nothing launches on the Ticks a link kicks.
const PIPELINE = `stages:
  - name: work
    human: true
    prompt: Do the work.
`;

const PR = "https://github.com/owner/app/pull/7";

/** gh's answer to the lookup of one PR. */
const lookup = (url: string, title: string, fields: Record<string, unknown> = {}): TrackerReply => ({
  tool: "gh",
  match: ["pr view", url, "--json"],
  stdout: JSON.stringify({ number: Number(url.split("/").at(-1)), url, title, state: "OPEN", headRefName: "feat", baseRefName: "main", author: { login: "alice" }, ...fields }),
});

/**
 * A running Lasso with one repo and a Ticket per prompt. With `github` the repo's origin then reads as
 * github.com/owner/app; without, it stays the local one, so an end of life never reaches for GitHub.
 */
async function lassoWithTickets(prompts: string[], github = true) {
  const started = await startLassoWithRepos({ app: { pipeline: "solo" } }, {}, { solo: PIPELINE });
  running.push(started.lasso);
  const tickets: IntakeResult[] = [];
  for (const input of prompts) tickets.push(await started.lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input, repo: "app", pipeline: "solo" }) }));
  // After intake, which needs the real origin.
  if (github) started.repos.app!.git(["remote", "set-url", "origin", "https://github.com/owner/app.git"]);
  await started.lasso.tracker.reply(lookup(PR, "Add dark mode"));
  return { ...started, tickets };
}

const listOf = (lasso: Lasso, id: string) => lasso.api<PrView[]>(`/api/tickets/${id}/prs`);
const pull = (lasso: Lasso, id: string, trigger: string, body: object = {}) => lasso.api<TicketDetail>(`/api/tickets/${id}/${trigger}`, { method: "POST", body: JSON.stringify(body) });
const prLinkTicks = (lasso: Lasso) => lasso.stdout().split("\n").filter((line) => line.includes("trigger=pr-link")).length;

describe("a PR reference", () => {
  const home = { owner: "owner", name: "app" };

  it("resolves a URL, owner/repo#N, #N and N to one canonical URL", () => {
    for (const input of [PR, `${PR}/files`, "https://github.com/owner/app/pull/7#discussion_r1", "owner/app#7", "#7", "7", " 7 "]) {
      expect(parsePrRef(input, home)).toEqual({ owner: "owner", repo: "app", number: 7, url: PR });
    }
    expect(parsePrRef("acme/lib#12", home)).toMatchObject({ url: "https://github.com/acme/lib/pull/12" });
  });

  it("needs the Ticket's GitHub repo for the bare forms, and says what it can't read", () => {
    expect(parsePrRef("#7", null)).toEqual({ problem: "#7 needs a repo: the Ticket's repo has no GitHub origin, so give owner/repo#N or the URL" });
    expect(parsePrRef("owner/app#7", null)).toMatchObject({ url: PR });
    expect(parsePrRef("https://github.com/owner/app/issues/7", home)).toEqual({ problem: "https://github.com/owner/app/issues/7 is not a PR: give its URL, owner/repo#N, #N or N" });
    expect(parsePrRef("seven", home)).toMatchObject({ problem: expect.stringContaining("is not a PR") });
  });
});

describe("lasso pr", () => {
  it("fails with 'lasso is not running' when the server is down", async () => {
    const { home, pathDir } = await makeHome();
    const port = await freePort();
    const result = await runCli(["pr", "list", "APP-1"], { home, pathDir, port });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("lasso is not running");
  });

  it("links every form of a PR as one Owned link, printing its title and state, and lists it", async () => {
    const { lasso, tickets: [ticket] } = await lassoWithTickets(["Add dark mode"]);
    const env = { LASSO_TICKET: ticket!.id };
    const linked = await runCli(["pr", "link", "#7"], { ...lasso, env });
    expect(linked).toMatchObject({ code: 0, stdout: `linked #7 as owned: Add dark mode (open)\n${PR}\n` });
    for (const form of [PR, "owner/app#7", "7"]) expect((await runCli(["pr", "link", form, ticket!.id], lasso)).code).toBe(0);

    expect(await listOf(lasso, ticket!.id)).toEqual([
      { url: PR, number: 7, title: "Add dark mode", role: "owned", source: "human", state: "OPEN", head: "feat", base: "main", author: "alice", feedback: 0, checks: "none" },
    ]);
    expect((await runCli(["pr", "list"], { ...lasso, env })).stdout).toBe("owned  human  open  #7  Add dark mode\n");
    expect(JSON.parse((await runCli(["pr", "list", ticket!.id, "--json"], lasso)).stdout)).toEqual(await listOf(lasso, ticket!.id));
    // The Ticket view carries it too.
    expect((await lasso.api<TicketDetail>(`/api/tickets/${ticket!.id}`)).prs.map((p) => [p.role, p.url])).toEqual([["owned", PR]]);
  });

  it("errors without a Ticket argument or $LASSO_TICKET", async () => {
    const { lasso } = await lassoWithTickets([]);
    const result = await runCli(["pr", "link", "#7"], lasso);
    expect(result).toMatchObject({ code: 1, stderr: "no Ticket: name one, or run inside a Session, where $LASSO_TICKET names it\n" });
    expect(await lasso.tracker.calls()).not.toContainEqual(expect.objectContaining({ args: expect.arrayContaining(["pr", "view"]) }));
  });

  it("records the source as agent when LASSO_SESSION is set, and human otherwise", async () => {
    const { lasso, tickets: [ticket] } = await lassoWithTickets(["Add dark mode"]);
    await lasso.tracker.reply(lookup("https://github.com/owner/app/pull/8", "Migrate the schema"));
    await runCli(["pr", "link", "#7", ticket!.id], { ...lasso, env: { LASSO_SESSION: "3e728ae2-8d99-42f3-a7ba-6066de05d169" } });
    await runCli(["pr", "link", "#8", ticket!.id], lasso);
    expect((await listOf(lasso, ticket!.id)).map((p) => [p.number, p.source])).toEqual([[7, "agent"], [8, "human"]]);
  });

  it("fails a PR gh can't find with gh's reason", async () => {
    const { lasso, tickets: [ticket] } = await lassoWithTickets(["Add dark mode"]);
    await lasso.tracker.reply({ tool: "gh", match: ["pr view", "https://github.com/owner/app/pull/99"], code: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)\n" });
    const result = await runCli(["pr", "link", "99", ticket!.id], lasso);
    expect(result).toMatchObject({ code: 1, stderr: "owner/app#99: GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)\n" });
    expect(await listOf(lasso, ticket!.id)).toEqual([]);
  });

  it("holds an Owned PR to the Ticket's repo; a Referenced one may be anywhere", async () => {
    const { lasso, tickets: [ticket] } = await lassoWithTickets(["Add dark mode"]);
    const other = "https://github.com/acme/lib/pull/12";
    await lasso.tracker.reply(lookup(other, "Expose the hook"));
    const owned = await runCli(["pr", "link", "acme/lib#12", ticket!.id], lasso);
    expect(owned).toMatchObject({ code: 1, stderr: expect.stringContaining("an Owned PR must be in owner/app, the repo of") });
    expect(owned.stderr).toContain("link it with --referenced");
    expect(await runCli(["pr", "link", "acme/lib#12", ticket!.id, "--referenced"], lasso)).toMatchObject({ code: 0, stdout: `linked #12 as referenced: Expose the hook (open)\n${other}\n` });
  });

  it("keeps Owned exclusive among active Tickets, naming the owner, and switches a role on a second link", async () => {
    const { lasso, tickets: [a, b] } = await lassoWithTickets(["Add dark mode", "Add light mode"]);
    await runCli(["pr", "link", "#7", a!.id], lasso);
    const refused = await runCli(["pr", "link", "#7", b!.id], lasso);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`${a!.label} owns this PR; link it with --referenced\n`);
    expect((await runCli(["pr", "link", "#7", b!.id, "--referenced"], lasso)).code).toBe(0);

    // A hands the PR over: referencing it on A frees it, and B's second link takes it as Owned.
    expect((await runCli(["pr", "link", "#7", a!.id, "--referenced"], lasso)).code).toBe(0);
    expect((await runCli(["pr", "link", "#7", b!.id], lasso)).code).toBe(0);
    expect((await listOf(lasso, a!.id)).map((p) => p.role)).toEqual(["referenced"]);
    expect((await listOf(lasso, b!.id)).map((p) => p.role)).toEqual(["owned"]);
  });

  it("unlinks to a tombstone that an explicit link clears, each kicking a Tick on an active Ticket", async () => {
    const { lasso, tickets: [ticket] } = await lassoWithTickets(["Add dark mode"]);
    const before = prLinkTicks(lasso);
    await runCli(["pr", "link", "#7", ticket!.id], lasso);
    await waitFor(async () => prLinkTicks(lasso) > before, "a Tick after the link");

    const unlinked = await runCli(["pr", "unlink", "OWNER/APP#7", ticket!.id], lasso);
    expect(unlinked).toMatchObject({ code: 0, stdout: `unlinked #7: Add dark mode\n${PR}\n` });
    expect(await listOf(lasso, ticket!.id)).toEqual([]);
    await waitFor(async () => prLinkTicks(lasso) > before + 1, "a Tick after the unlink");
    expect(await runCli(["pr", "unlink", "#7", ticket!.id], lasso)).toMatchObject({ code: 1, stderr: `owner/app#7 is not linked to ${ticket!.label}\n` });

    await runCli(["pr", "link", "#7", ticket!.id, "--referenced"], lasso);
    expect((await listOf(lasso, ticket!.id)).map((p) => [p.role, p.url])).toEqual([["referenced", PR]]);
  });

  it("records a link on a done Ticket without a Tick, and refuses one on an Abandoned Ticket", async () => {
    const { lasso, tickets: [done, abandoned] } = await lassoWithTickets(["Add dark mode", "Add light mode"], false);
    expect((await pull(lasso, done!.id, "done", { override: true })).state).toBe("done");
    await pull(lasso, abandoned!.id, "abandon");
    const before = prLinkTicks(lasso);

    expect((await runCli(["pr", "link", PR, done!.id], lasso)).code).toBe(0);
    expect((await listOf(lasso, done!.id)).map((p) => p.url)).toEqual([PR]);
    const refused = await runCli(["pr", "link", PR, abandoned!.id, "--referenced"], lasso);
    expect(refused).toMatchObject({ code: 1, stderr: `${abandoned!.label} is Abandoned\n` });
    await new Promise((r) => setTimeout(r, 200));
    expect(prLinkTicks(lasso)).toBe(before);
  });
});
