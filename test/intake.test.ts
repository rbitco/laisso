import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startLaissoWithRepos, runCli, type Laisso, type LaissoConfig, type TempRepo, type TrackerReply } from "./harness.ts";
import type { Detection } from "../src/intake/detect.ts";
import type { TicketView, TicketDetail, IntakeResult, PrView } from "../src/api/views.ts";

const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const FAST_PIPELINE = `stages:
  - name: implement
    prompt: just do it
    artifact: commits-on-branch
`;

async function laissoWithRepos(names: string[], extra: LaissoConfig = {}, pipelines: Record<string, string> = {}) {
  const specs = Object.fromEntries(names.map((name) => [name, { pipeline: pipelines[name] }]));
  const files: Record<string, string> = Object.values(pipelines).includes("fast") ? { fast: FAST_PIPELINE } : {};
  const started = await startLaissoWithRepos(specs, extra, files);
  running.push(started.laisso);
  return started;
}

describe("intake of a prompt Ticket", () => {
  it("detects a prompt and suggests the only repo", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const d = await laisso.api<Detection>("/api/intake/detect", { method: "POST", body: JSON.stringify({ input: "Add dark mode to settings" }) });
    expect(d.kind).toBe("prompt");
    expect(d.reference).toBeNull();
    expect(d.repo).toEqual({ suggestion: "app", choices: ["app"] });
    expect(d.pipeline).toEqual({ suggestion: "default", choices: ["default", "pr-review"], byRepo: { app: "default" } });
  });

  it("offers a picker with no suggestion when several repos exist", async () => {
    const { laisso } = await laissoWithRepos(["app", "web"]);
    const d = await laisso.api<Detection>("/api/intake/detect", { method: "POST", body: JSON.stringify({ input: "Fix the footer" }) });
    expect(d.repo.suggestion).toBeNull();
    expect(d.repo.choices).toEqual(["app", "web"]);
  });

  it("suggests the Pipeline of the chosen repo", async () => {
    const { laisso } = await laissoWithRepos(["app", "web"], {}, { web: "fast" });
    const body = (repo?: string) => JSON.stringify({ input: "Fix the footer", repo });
    const open = await laisso.api<Detection>("/api/intake/detect", { method: "POST", body: body() });
    expect(open.pipeline.byRepo).toEqual({ app: "default", web: "fast" });
    expect(open.pipeline.choices).toEqual(["default", "fast", "pr-review"]);
    const web = await laisso.api<Detection>("/api/intake/detect", { method: "POST", body: body("web") });
    expect(web.pipeline.suggestion).toBe("fast");
  });

  it("admits the Ticket with a worktree and branch from origin's default branch", async () => {
    const { laisso, repos } = await laissoWithRepos(["app"], { branch_prefix: "matt" });
    const t = await laisso.api<IntakeResult>("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ input: "Add dark mode to the settings page", repo: "app", pipeline: "default" }),
    });
    expect(t.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(t.title).toBe("Add dark mode to the settings page");
    expect(t.reference).toBeNull();
    expect(t.branch).toBe(`matt/${t.id.slice(-8)}-add-dark-mode`);
    expect(t.shortId).toBe(t.id.slice(-8));
    expect(t.worktree).toBe(path.join(laisso.home, "tickets", t.id, "worktree"));
    expect(existsSync(path.join(t.worktree, "README.md"))).toBe(true);
    expect(repos.app.git(["rev-parse", "--abbrev-ref", "HEAD"], t.worktree)).toBe(t.branch);
    expect(repos.app.git(["rev-parse", "HEAD"], t.worktree)).toBe(repos.app.git(["rev-parse", "origin/main"]));
    expect(t.stage).toMatchObject({ name: "grill", human: true, index: 0, total: 9 });
    expect(t.display).toEqual({ state: "needs_you", label: "Needs you", why: "not started" });
    expect(t.url).toBe(`${laisso.url}/#${t.id}`);

    const ledger = await laisso.api<TicketView[]>("/api/tickets");
    expect(ledger.map((x) => x.id)).toEqual([t.id]);
    const detail = await laisso.api<TicketDetail>(`/api/tickets/${t.id}`);
    expect(detail.branch).toBe(t.branch);
    expect(detail.stages.map((s) => s.label)).toEqual(["grill", "In Progress", "plan", "implement", "document", "code-review", "In Review", "review", "Done"]);
  });

  it("uses no prefix when branch_prefix is empty", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const t = await laisso.api<IntakeResult>("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ input: "Rename everything!!", repo: "app", pipeline: "default" }),
    });
    expect(t.branch).toBe(`${t.id.slice(-8)}-rename`);
  });

  it("refuses an unknown repo or Pipeline with the reason", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const bad = await laisso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "x", repo: "nope", pipeline: "default" }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("repo nope is not in config.yaml");
    const badPipe = await laisso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "x", repo: "app", pipeline: "ghost" }) });
    expect(badPipe.status).toBe(400);
    expect((await badPipe.json()).error).toContain("Pipeline ghost");
  });
});

describe("laisso add", () => {
  it("shows the detection, asks y/N, and prints id, name, and URL", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const r = await runCli(["add", "Add dark mode"], { ...laisso, stdin: "y\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("prompt");
    expect(r.stdout).toContain("repo: app");
    expect(r.stdout).toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(r.stdout).toContain("Add dark mode");
    expect(r.stdout).toContain(`${laisso.url}/#`);
  });

  it("--pipeline overrides the repo's default", async () => {
    const { laisso } = await laissoWithRepos(["app"], {}, { app: "default" });
    await writeFile(path.join(laisso.home, "pipelines", "fast.yaml"), FAST_PIPELINE);
    const r = await runCli(["add", "Ship it", "--yes", "--pipeline", "fast", "--json"], laisso);
    expect(r.code).toBe(0);
    const ticket = JSON.parse(r.stdout) as IntakeResult;
    expect(ticket.pipeline).toBe("fast");
    expect(ticket.stage).toMatchObject({ name: "implement", human: false, total: 1 });
    expect(ticket.display.state).toBe("ready");
  });

  it("--json still asks unless --yes is given", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const r = await runCli(["add", "Add dark mode", "--json"], { ...laisso, stdin: "n\n" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(await laisso.api<unknown[]>("/api/tickets")).toEqual([]);
  });

  it("does nothing when the answer is no", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const r = await runCli(["add", "Add dark mode"], { ...laisso, stdin: "n\n" });
    expect(r.code).toBe(1);
    expect(await laisso.api<unknown[]>("/api/tickets")).toEqual([]);
  });

  it("--yes accepts a suggestion but never a picker", async () => {
    const { laisso } = await laissoWithRepos(["app", "web"]);
    const ambiguous = await runCli(["add", "Fix footer", "--yes"], laisso);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("repo is ambiguous");
    const explicit = await runCli(["add", "Fix footer", "--yes", "--repo", "web"], laisso);
    expect(explicit.code).toBe(0);
    const json = await runCli(["status", "--json"], laisso);
    expect(JSON.parse(json.stdout).tickets[0].repo).toBe("web");
  });

  it("laisso status prints the ledger and a Ticket's detail", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    await runCli(["add", "Add dark mode", "--yes"], laisso);
    const ledger = await runCli(["status"], laisso);
    expect(ledger.stdout).toContain("Needs you");
    expect(ledger.stdout).toContain("Add dark mode");
    const id = JSON.parse((await runCli(["status", "--json"], laisso)).stdout).tickets[0].id;
    const detail = await runCli(["status", id], laisso);
    expect(detail.stdout).toContain("grill");
    expect(detail.stdout).toContain("worktree");
    expect(detail.stdout).toContain("prs:       none");
    expect(detail.stdout).toMatch(/budget:\s+rounds 0\/5 · attempts 0\/2 · wall 0s\/30m · spend \$0\.00\/\$25/);
    const asJson = JSON.parse((await runCli(["status", id, "--json"], laisso)).stdout) as TicketDetail;
    expect(asJson.id).toBe(id);
    expect(asJson.stages).toHaveLength(9);
  });
});

// A Ticket's name (LASSO-108): what a human calls it, shown in place of the reference or short id until cleared.
describe("naming a Ticket", () => {
  const rename = (laisso: Laisso, id: string, name: unknown) => laisso.api<Response>(`/api/tickets/${id}/name`, { method: "PUT", body: JSON.stringify({ name }), raw: true });

  it("takes a name at intake, trimmed onto one line, and shows it in place of the short id", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const t = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Review PR 412 for the payment flow", repo: "app", name: "  PR review:\n payments " }) });
    expect(t).toMatchObject({ name: "PR review: payments", label: "PR review: payments", title: "Review PR 412 for the payment flow", reference: null });
    expect(t.branch).toContain(t.shortId);
    const status = await runCli(["status"], laisso);
    expect(status.stdout).toContain("PR review: payments");
    expect(status.stdout).not.toContain(t.shortId);
  });

  it("renames, clears, and refuses a name past 80 characters", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const t = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Fix the footer", repo: "app" }) });
    expect(t).toMatchObject({ name: null, label: t.shortId });

    const named = (await (await rename(laisso, t.id, "Footer fix")).json()) as TicketDetail;
    expect(named).toMatchObject({ name: "Footer fix", label: "Footer fix" });
    const listed = await laisso.api<TicketView[]>("/api/tickets");
    expect(listed.find((x) => x.id === t.id)!.label).toBe("Footer fix");

    const tooLong = await rename(laisso, t.id, "x".repeat(81));
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toBe("name is 81 characters; keep it to 80");

    const cleared = (await (await rename(laisso, t.id, "   ")).json()) as TicketDetail;
    expect(cleared).toMatchObject({ name: null, label: t.shortId });
  });
});

// `laisso add <prompt> --pr <pr>` (LASSO-168): a Ticket that reviews a teammate's PR, linked as Referenced at Intake.
describe("laisso add --pr", () => {
  /** gh's answer to the lookup of one PR. */
  const lookup = (url: string, title: string, head: string): TrackerReply => ({
    tool: "gh",
    match: ["pr view", url, "--json"],
    stdout: JSON.stringify({ number: Number(url.split("/").at(-1)), url, title, state: "OPEN", headRefName: head, baseRefName: "main", author: { login: "alice" } }),
  });

  /**
   * A teammate's PR #number on the repo's origin: a commit on its own branch that origin also keeps as
   * refs/pull/N/head, as GitHub does. Returns the head commit.
   */
  const openPr = async (repo: TempRepo, number: number, head: string): Promise<string> => {
    repo.git(["checkout", "-q", "-b", head]);
    await writeFile(path.join(repo.path, `pr-${number}.txt`), `${head}\n`);
    repo.git(["add", "."]);
    repo.git(["commit", "-q", "-m", head]);
    const sha = repo.git(["rev-parse", "HEAD"]);
    repo.git(["push", "-q", "origin", `${head}:refs/pull/${number}/head`]);
    repo.git(["checkout", "-q", "main"]);
    return sha;
  };

  /** The repo's origin reads as github.com/owner/<name>, while git still fetches from the local bare origin. */
  const onGitHub = (repo: TempRepo, name: string) => {
    const url = `https://github.com/owner/${name}.git`;
    repo.git(["remote", "set-url", "origin", url]);
    repo.git(["config", `url.${repo.origin}.insteadOf`, url]);
  };

  async function reviewSetup() {
    const started = await laissoWithRepos(["app", "web"]);
    const { laisso, repos } = started;
    onGitHub(repos.app!, "app");
    const head = await openPr(repos.app!, 7, "alice/dark-mode");
    await laisso.tracker.reply(lookup("https://github.com/owner/app/pull/7", "Add dark mode", "alice/dark-mode"));
    await laisso.tracker.reply(lookup("https://github.com/acme/lib/pull/12", "Expose the hook", "hook"));
    return { ...started, head };
  }

  const linksOf = (laisso: Laisso, id: string) => laisso.api<PrView[]>(`/api/tickets/${id}/prs`);

  it("creates the Ticket in the PR's repo with one Referenced link, its branch at the PR's head and tracking nothing", async () => {
    const { laisso, repos, head } = await reviewSetup();
    const r = await runCli(["add", "review", "--pr", "owner/app#7", "--yes", "--json"], laisso);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("repo: app");
    expect(r.stderr).toContain("referenced PR #7: Add dark mode (open)");
    const ticket = JSON.parse(r.stdout) as IntakeResult;
    expect(ticket.repo).toBe("app");

    expect(await linksOf(laisso, ticket.id)).toEqual([
      { url: "https://github.com/owner/app/pull/7", number: 7, title: "Add dark mode", role: "referenced", source: "human", state: "OPEN", head: "alice/dark-mode", base: "main", author: "alice", feedback: 0, checks: "none" },
    ]);
    const git = (args: string[]) => repos.app!.git(args, ticket.worktree);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe(ticket.branch);
    expect(git(["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(path.join(ticket.worktree, "pr-7.txt"))).toBe(true);
    // Nothing upstream: a push names Laisso's branch, never the teammate's.
    expect(() => git(["rev-parse", "--abbrev-ref", "@{upstream}"])).toThrow();
  });

  it("links every PR given, in order, starting the branch at the first one in the Ticket's repo", async () => {
    const { laisso, repos, head } = await reviewSetup();
    const r = await runCli(["add", "review both", "--pr", "acme/lib#12", "--pr", "https://github.com/owner/app/pull/7", "--pr", "#7", "--repo", "app", "--yes", "--json"], laisso);
    expect(r.code).toBe(0);
    const ticket = JSON.parse(r.stdout) as IntakeResult;
    expect((await linksOf(laisso, ticket.id)).map((p) => [p.number, p.role, p.source])).toEqual([[12, "referenced", "human"], [7, "referenced", "human"]]);
    expect(repos.app!.git(["rev-parse", "HEAD"], ticket.worktree)).toBe(head);
  });

  it("starts at the default branch when no Referenced PR is in the Ticket's repo", async () => {
    const { laisso, repos } = await reviewSetup();
    const r = await runCli(["add", "review the hook", "--pr", "acme/lib#12", "--repo", "web", "--yes", "--json"], laisso);
    expect(r.code).toBe(0);
    const ticket = JSON.parse(r.stdout) as IntakeResult;
    expect(ticket.repo).toBe("web");
    expect((await linksOf(laisso, ticket.id)).map((p) => p.url)).toEqual(["https://github.com/acme/lib/pull/12"]);
    expect(repos.web!.git(["rev-parse", "HEAD"], ticket.worktree)).toBe(repos.web!.git(["rev-parse", "origin/main"]));
  });

  it("refuses a first PR no configured repo's origin matches, or one gh can't find, and makes nothing", async () => {
    const { laisso } = await reviewSetup();
    const unmatched = await runCli(["add", "review", "--pr", "acme/lib#12", "--yes"], laisso);
    expect(unmatched).toMatchObject({ code: 1, stderr: "no repo in config.yaml has its origin at github.com/acme/lib: pass --repo\n" });
    const bare = await runCli(["add", "review", "--pr", "#7", "--yes"], laisso);
    expect(bare).toMatchObject({ code: 1, stderr: "--pr #7 needs a repo: give owner/repo#N or the URL, or pass --repo\n" });
    await laisso.tracker.reply({ tool: "gh", match: ["pr view", "https://github.com/owner/app/pull/99"], code: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 99.\n" });
    const missing = await laisso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "review", prs: ["owner/app#99"] }) });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("owner/app#99: GraphQL: Could not resolve to a PullRequest with the number of 99.");
    expect(await laisso.api<unknown[]>("/api/tickets")).toEqual([]);
  });

  it("runs the pr-review Pipeline only when asked for it", async () => {
    const { laisso } = await reviewSetup();
    const chosen = JSON.parse((await runCli(["add", "review", "--pr", "owner/app#7", "--pipeline", "pr-review", "--yes", "--json"], laisso)).stdout) as IntakeResult;
    expect(chosen.pipeline).toBe("pr-review");
    expect(chosen.stage).toMatchObject({ name: "review-pr", human: false, total: 1 });
    const unchosen = JSON.parse((await runCli(["add", "review again", "--pr", "owner/app#7", "--yes", "--json"], laisso)).stdout) as IntakeResult;
    expect(unchosen.pipeline).toBe("default");
  });

  it("leaves add without --repo and --pr as it was: no PR looked up, none linked", async () => {
    const { laisso } = await laissoWithRepos(["app"]);
    const r = await runCli(["add", "Add dark mode", "--yes", "--json"], laisso);
    expect(r.code).toBe(0);
    const ticket = JSON.parse(r.stdout) as IntakeResult;
    expect(ticket.repo).toBe("app");
    expect(await linksOf(laisso, ticket.id)).toEqual([]);
    expect(await laisso.tracker.calls()).not.toContainEqual(expect.objectContaining({ args: expect.arrayContaining(["pr", "view"]) }));
  });
});
