import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startLassoWithRepos, restartOnFakesOnly, runCli, waitFor, type Lasso, type RepoSpec, type LassoConfig } from "./harness.ts";
import type { Detection } from "../src/intake/detect.ts";
import type { TicketView, IntakeResult } from "../src/api/views.ts";

const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const ADF_BODY = {
  type: "doc",
  version: 1,
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "What to build" }] },
    { type: "paragraph", content: [{ type: "text", text: "A toggle in " }, { type: "text", text: "settings", marks: [{ type: "code" }] }, { type: "text", text: "." }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "remember the choice" }] }] }] },
  ],
};

const jiraView = (key: string, summary: string, description: unknown = ADF_BODY) => JSON.stringify({ key, fields: { summary, description } });
const ghView = (title: string, body: string) => JSON.stringify({ title, body });

async function lassoWith(repos: Record<string, RepoSpec>, extra: LassoConfig = {}) {
  const started = await startLassoWithRepos(repos, extra);
  running.push(started.lasso);
  return started;
}

const detect = (lasso: Lasso, input: string, repo?: string) => lasso.api<Detection>("/api/intake/detect", { method: "POST", body: JSON.stringify({ input, repo }) });
const admit = (lasso: Lasso, input: string, repo?: string, pipeline?: string) =>
  lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input, repo, pipeline }) });

describe("detection of a tracker reference", () => {
  it("names the kind, suggests the repo from the project, and pulls the title through acli", async () => {
    const { lasso } = await lassoWith({ app: { tracker: "jira", project: "APP" }, web: { tracker: "github", project: "acme/web" } });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12"], stdout: jiraView("APP-12", "Add dark mode to the settings page") });
    const d = await detect(lasso, "APP-12");
    expect(d).toMatchObject({ kind: "jira", reference: "APP-12", title: "Add dark mode to the settings page" });
    expect(d.repo).toEqual({ suggestion: "app", choices: ["app"] });
    expect(d.branch).toEqual({ name: "APP-12-add-dark-mode", exists: false });
    expect(d.notes).toEqual([]);
    expect(await lasso.tracker.calls()).toEqual([
      { tool: "acli", args: ["jira", "workitem", "view", "APP-12", "--fields", "summary,description", "--json"] },
    ]);
  });

  it("accepts a GitHub issue URL or owner/repo#n and asks gh for the issue", async () => {
    const { lasso } = await lassoWith({ web: { tracker: "github", project: "acme/web" } });
    await lasso.tracker.reply({ tool: "gh", match: ["issue view 7", "--repo acme/web"], stdout: ghView("Fix the footer links", "They 404.") });
    const byUrl = await detect(lasso, "https://github.com/acme/web/issues/7");
    expect(byUrl).toMatchObject({ kind: "github", reference: "acme/web#7", title: "Fix the footer links", branch: { name: "acme-web-7-fix-the-footer", exists: false } });
    const short = await detect(lasso, "acme/web#7");
    expect(short.reference).toBe("acme/web#7");
    expect((await lasso.tracker.calls())[0]).toEqual({ tool: "gh", args: ["issue", "view", "7", "--repo", "acme/web", "--json", "title,body"] });
  });

  it("anything else stays a prompt and never touches a tracker", async () => {
    const { lasso } = await lassoWith({ app: { tracker: "jira", project: "APP" } });
    for (const input of ["app-12", "APP 12", "Fix APP-12 properly", "github.com/acme/web/7"]) {
      expect((await detect(lasso, input)).kind).toBe("prompt");
    }
    expect(await lasso.tracker.calls()).toEqual([]);
  });

  it("reports the tracker's reason when the issue cannot be fetched", async () => {
    const { lasso } = await lassoWith({ app: { tracker: "jira", project: "APP" }, web: { tracker: "github", project: "acme/web" } });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-404"], stderr: "✗ Error: Issue does not exist or you do not have permission to see it.\n", code: 1 });
    const res = await lasso.api<Response>("/api/intake/detect", { method: "POST", raw: true, body: JSON.stringify({ input: "APP-404" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("APP-404: Error: Issue does not exist or you do not have permission to see it.");
    await lasso.tracker.reply({ tool: "gh", match: ["issue view 404"], stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 404. (repository.issue)\n", code: 1 });
    const gh = await lasso.api<Response>("/api/intake/detect", { method: "POST", raw: true, body: JSON.stringify({ input: "acme/web#404" }) });
    expect(gh.status).toBe(400);
    expect((await gh.json()).error).toBe("acme/web#404: GraphQL: Could not resolve to an issue or pull request with the number of 404. (repository.issue)");
  });

  it("names a tracker CLI missing from PATH, with the reference and repo that needed it, and points at lasso doctor", async () => {
    const { lasso: first } = await lassoWith({ app: { tracker: "jira", project: "APP" }, web: { tracker: "github", project: "acme/web" } });
    const lasso = await restartOnFakesOnly(first);
    running.push(lasso);
    await rm(path.join(lasso.pathDir, "acli"));
    await rm(path.join(lasso.pathDir, "gh"));
    const error = async (route: string, body: object) => {
      const res = await lasso.api<Response>(route, { method: "POST", raw: true, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      return (await res.json()).error;
    };
    expect(await error("/api/intake/detect", { input: "APP-12" })).toBe("acli not found on PATH (APP-12 in repo app); run lasso doctor");
    expect(await error("/api/tickets", { input: "acme/web#7", repo: "web" })).toBe("gh not found on PATH (acme/web#7 in repo web); run lasso doctor");
  });
});

describe("admitting a reference Ticket", () => {
  it("stores the title and body, names the branch from the key, and leaves transition statuses to the Action", async () => {
    const { lasso, repos } = await lassoWith({ app: { tracker: "jira", project: "APP" } }, { branch_prefix: "matt" });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12"], stdout: jiraView("APP-12", "Add dark mode to the settings page") });
    const t = await admit(lasso, "APP-12");
    expect(t).toMatchObject({ reference: "APP-12", origin: "tracker", title: "Add dark mode to the settings page", repo: "app", branch: "matt/APP-12-add-dark-mode", branchExisted: false });
    expect(t.stage).toMatchObject({ name: "grill", human: true });
    expect(existsSync(path.join(t.worktree, "README.md"))).toBe(true);
    expect(repos.app.git(["rev-parse", "--abbrev-ref", "HEAD"], t.worktree)).toBe("matt/APP-12-add-dark-mode");

    const ledger = await runCli(["status"], lasso);
    expect(ledger.stdout).toContain("APP-12");
    const detail = JSON.parse((await runCli(["status", "APP-12", "--json"], lasso)).stdout) as { body: string };
    expect(detail.body).toBe("## What to build\n\nA toggle in `settings`.\n\n- remember the choice");

    // Whether a status is on the board is found out when the Action runs, not at Intake (ADR 0010).
    expect((await lasso.tracker.calls()).filter((c) => c.args.includes("search"))).toEqual([]);
  });

  it("keeps a GitHub issue's body", async () => {
    const { lasso } = await lassoWith({ web: { tracker: "github", project: "acme/web", pipeline: "gh" } });
    await writeFile(path.join(lasso.home, "pipelines", "gh.yaml"), "stages:\n  - name: implement\n    prompt: do it\n  - action: tracker.transition\n    with: { status: Closed }\n");
    await lasso.tracker.reply({ tool: "gh", match: ["issue view 7"], stdout: ghView("Fix the footer links", "They 404.") });
    const t = await admit(lasso, "acme/web#7");
    expect(t).toMatchObject({ reference: "acme/web#7", branch: "acme-web-7-fix-the-footer", pipeline: "gh" });
    const detail = JSON.parse((await runCli(["status", t.id, "--json"], lasso)).stdout) as { body: string };
    expect(detail.body).toBe("They 404.");
    // The issue fetch, then the label mirror in the background (which the shim has no answer for here, so it goes pending).
    await waitFor(async () => (JSON.parse((await runCli(["status", t.id, "--json"], lasso)).stdout).mirrorPending ? true : null), "the push to go pending");
    expect((await lasso.tracker.calls()).map((c) => c.args.slice(0, 2).join(" "))).toEqual(["issue view", "issue view", "issue edit"]);
  });

  it("refuses a reference whose tracker is not the repo's", async () => {
    const { lasso } = await lassoWith({ app: { tracker: "jira", project: "APP" }, web: { tracker: "github", project: "acme/web" } });
    const res = await lasso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "APP-12", repo: "web" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("repo web is tracked on github, not jira");
    const at = await lasso.api<Response>("/api/intake/detect", { method: "POST", raw: true, body: JSON.stringify({ input: "acme/web#7", repo: "app" }) });
    expect((await at.json()).error).toBe("repo app is tracked on jira, not github");
    expect(await lasso.tracker.calls()).toEqual([]);
  });

  it("checks out an existing branch and says so at confirmation", async () => {
    const { lasso, repos } = await lassoWith({ app: { tracker: "jira", project: "APP" } });
    repos.app.git(["branch", "APP-12-add-dark-mode"]);
    repos.app.git(["push", "-q", "origin", "APP-12-add-dark-mode"]);
    repos.app.git(["branch", "-D", "APP-12-add-dark-mode"]);
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12"], stdout: jiraView("APP-12", "Add dark mode to the settings page") });
    const d = await detect(lasso, "APP-12");
    expect(d.branch).toEqual({ name: "APP-12-add-dark-mode", exists: true });
    expect(d.notes).toEqual(["existing branch APP-12-add-dark-mode will be checked out"]);
    const cli = await runCli(["add", "APP-12", "--yes"], lasso);
    expect(cli.stdout).toContain("existing branch APP-12-add-dark-mode will be checked out");
    const [t] = await lasso.api<TicketView[]>("/api/tickets");
    expect(repos.app.git(["rev-parse", "--abbrev-ref", "HEAD"], t!.worktree)).toBe("APP-12-add-dark-mode");
    expect(repos.app.git(["rev-parse", "--abbrev-ref", "@{upstream}"], t!.worktree)).toBe("origin/APP-12-add-dark-mode");
  });

  it("refuses a reference that already has an active Ticket", async () => {
    const { lasso } = await lassoWith({ app: { tracker: "jira", project: "APP" } });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12"], stdout: jiraView("APP-12", "Add dark mode") });
    const first = await admit(lasso, "APP-12");
    const again = await lasso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "APP-12" }) });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe(`APP-12 already has an active Ticket (${first.id})`);
    const detectAgain = await lasso.api<Response>("/api/intake/detect", { method: "POST", raw: true, body: JSON.stringify({ input: "APP-12" }) });
    expect(detectAgain.status).toBe(400);
  });

  it("refuses a Pipeline still giving a transition its status the old way, pointing at with", async () => {
    const { lasso } = await lassoWith({ app: { tracker: "jira", project: "APP", pipeline: "odd" } });
    // Startup migration rewrote the files there were; this one is a hand edit made after.
    await writeFile(path.join(lasso.home, "pipelines", "odd.yaml"), "stages:\n  - name: implement\n    prompt: do it\n  - action: tracker.transition\n    status: Shipped\n");
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12"], stdout: jiraView("APP-12", "Add dark mode") });
    const res = await lasso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "APP-12" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Pipeline odd stage 2: status is now a param; write with: { status: Shipped }");
    expect(await lasso.api<unknown[]>("/api/tickets")).toEqual([]);
  });

  it("refuses an unknown artifact or action with the reason", async () => {
    const { lasso } = await lassoWith({ app: { tracker: "jira", project: "APP" } });
    await writeFile(path.join(lasso.home, "pipelines", "bad-artifact.yaml"), "stages:\n  - name: implement\n    prompt: do it\n    artifact: pr-approved\n");
    await writeFile(path.join(lasso.home, "pipelines", "bad-action.yaml"), "stages:\n  - action: tracker.assign\n");
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12"], stdout: jiraView("APP-12", "Add dark mode") });
    for (const [pipeline, reason] of [["bad-artifact", "pr-approved"], ["bad-action", "tracker.assign"]]) {
      const res = await lasso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "APP-12", pipeline }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(reason);
    }
    expect(await readdir(path.join(lasso.home, "tickets")).catch(() => [])).toEqual([]);
  });
});

describe("lasso add with a reference", () => {
  it("shows kind, title, repo, and branch, then prints the reference in the ledger", async () => {
    const { lasso } = await lassoWith({ app: { tracker: "jira", project: "APP" } });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12"], stdout: jiraView("APP-12", "Add dark mode to the settings page", null) });
    const r = await runCli(["add", "APP-12"], { ...lasso, stdin: "y\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("jira APP-12: Add dark mode to the settings page");
    expect(r.stdout).toContain("repo: app");
    expect(r.stdout).toContain("branch: APP-12-add-dark-mode");
    const ledger = await runCli(["status"], lasso);
    expect(ledger.stdout).toMatch(/Needs you\s+APP-12\s+app\s+grill/);
    // The first Stage is human, so the Ticket needs you from the start.
    const posts = await waitFor(async () => { const n = await lasso.notifications(); return n.length ? n : null; }, "the notification");
    const [ticket] = await lasso.api<Array<{ id: string }>>("/api/tickets");
    expect(posts).toEqual([{ title: "APP-12 Add dark mode to the settings page", body: "grill needs you", url: `${lasso.url}/#${ticket!.id}` }]);
  });
});
