import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startLassoWithRepos, runCli, type Lasso, type LassoConfig } from "./harness.ts";
import type { Detection } from "../src/intake/detect.ts";
import type { TicketView, TicketDetail, IntakeResult } from "../src/api/views.ts";

const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const FAST_PIPELINE = `runner: claude
stages:
  - name: implement
    prompt: just do it
    artifact: commits-on-branch
`;

async function lassoWithRepos(names: string[], extra: LassoConfig = {}, pipelines: Record<string, string> = {}) {
  const specs = Object.fromEntries(names.map((name) => [name, { pipeline: pipelines[name] }]));
  const files: Record<string, string> = Object.values(pipelines).includes("fast") ? { fast: FAST_PIPELINE } : {};
  const started = await startLassoWithRepos(specs, extra, files);
  running.push(started.lasso);
  return started;
}

describe("intake of a prompt Ticket", () => {
  it("detects a prompt and suggests the only repo", async () => {
    const { lasso } = await lassoWithRepos(["app"]);
    const d = await lasso.api<Detection>("/api/intake/detect", { method: "POST", body: JSON.stringify({ input: "Add dark mode to settings" }) });
    expect(d.kind).toBe("prompt");
    expect(d.reference).toBeNull();
    expect(d.repo).toEqual({ suggestion: "app", choices: ["app"] });
    expect(d.pipeline).toEqual({ suggestion: "default", choices: ["default"], byRepo: { app: "default" } });
  });

  it("offers a picker with no suggestion when several repos exist", async () => {
    const { lasso } = await lassoWithRepos(["app", "web"]);
    const d = await lasso.api<Detection>("/api/intake/detect", { method: "POST", body: JSON.stringify({ input: "Fix the footer" }) });
    expect(d.repo.suggestion).toBeNull();
    expect(d.repo.choices).toEqual(["app", "web"]);
  });

  it("suggests the Pipeline of the chosen repo", async () => {
    const { lasso } = await lassoWithRepos(["app", "web"], {}, { web: "fast" });
    const body = (repo?: string) => JSON.stringify({ input: "Fix the footer", repo });
    const open = await lasso.api<Detection>("/api/intake/detect", { method: "POST", body: body() });
    expect(open.pipeline.byRepo).toEqual({ app: "default", web: "fast" });
    expect(open.pipeline.choices).toEqual(["default", "fast"]);
    const web = await lasso.api<Detection>("/api/intake/detect", { method: "POST", body: body("web") });
    expect(web.pipeline.suggestion).toBe("fast");
  });

  it("admits the Ticket with a worktree and branch from origin's default branch", async () => {
    const { lasso, repos } = await lassoWithRepos(["app"], { branch_prefix: "matt" });
    const t = await lasso.api<IntakeResult>("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ input: "Add dark mode to the settings page", repo: "app", pipeline: "default" }),
    });
    expect(t.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(t.title).toBe("Add dark mode to the settings page");
    expect(t.reference).toBeNull();
    expect(t.branch).toBe(`matt/${t.id.slice(-8)}-add-dark-mode`);
    expect(t.shortId).toBe(t.id.slice(-8));
    expect(t.worktree).toBe(path.join(lasso.home, "tickets", t.id, "worktree"));
    expect(existsSync(path.join(t.worktree, "README.md"))).toBe(true);
    expect(repos.app.git(["rev-parse", "--abbrev-ref", "HEAD"], t.worktree)).toBe(t.branch);
    expect(repos.app.git(["rev-parse", "HEAD"], t.worktree)).toBe(repos.app.git(["rev-parse", "origin/main"]));
    expect(t.stage).toMatchObject({ name: "grill", human: true, index: 0, total: 9 });
    expect(t.display).toEqual({ state: "needs_you", label: "Needs you", why: "not started" });
    expect(t.url).toBe(`${lasso.url}/#${t.id}`);

    const ledger = await lasso.api<TicketView[]>("/api/tickets");
    expect(ledger.map((x) => x.id)).toEqual([t.id]);
    const detail = await lasso.api<TicketDetail>(`/api/tickets/${t.id}`);
    expect(detail.branch).toBe(t.branch);
    expect(detail.stages.map((s) => s.label)).toEqual(["grill", "In Progress", "plan", "implement", "document", "code-review", "In Review", "review", "Done"]);
  });

  it("uses no prefix when branch_prefix is empty", async () => {
    const { lasso } = await lassoWithRepos(["app"]);
    const t = await lasso.api<IntakeResult>("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ input: "Rename everything!!", repo: "app", pipeline: "default" }),
    });
    expect(t.branch).toBe(`${t.id.slice(-8)}-rename`);
  });

  it("refuses an unknown repo or Pipeline with the reason", async () => {
    const { lasso } = await lassoWithRepos(["app"]);
    const bad = await lasso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "x", repo: "nope", pipeline: "default" }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("repo nope is not in config.yaml");
    const badPipe = await lasso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "x", repo: "app", pipeline: "ghost" }) });
    expect(badPipe.status).toBe(400);
    expect((await badPipe.json()).error).toContain("Pipeline ghost");
  });
});

describe("lasso add", () => {
  it("shows the detection, asks y/N, and prints id, name, and URL", async () => {
    const { lasso } = await lassoWithRepos(["app"]);
    const r = await runCli(["add", "Add dark mode"], { ...lasso, stdin: "y\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("prompt");
    expect(r.stdout).toContain("repo: app");
    expect(r.stdout).toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(r.stdout).toContain("Add dark mode");
    expect(r.stdout).toContain(`${lasso.url}/#`);
  });

  it("--pipeline overrides the repo's default", async () => {
    const { lasso } = await lassoWithRepos(["app"], {}, { app: "default" });
    await writeFile(path.join(lasso.home, "pipelines", "fast.yaml"), FAST_PIPELINE);
    const r = await runCli(["add", "Ship it", "--yes", "--pipeline", "fast", "--json"], lasso);
    expect(r.code).toBe(0);
    const ticket = JSON.parse(r.stdout) as IntakeResult;
    expect(ticket.pipeline).toBe("fast");
    expect(ticket.stage).toMatchObject({ name: "implement", human: false, total: 1 });
    expect(ticket.display.state).toBe("ready");
  });

  it("--json still asks unless --yes is given", async () => {
    const { lasso } = await lassoWithRepos(["app"]);
    const r = await runCli(["add", "Add dark mode", "--json"], { ...lasso, stdin: "n\n" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(await lasso.api<unknown[]>("/api/tickets")).toEqual([]);
  });

  it("does nothing when the answer is no", async () => {
    const { lasso } = await lassoWithRepos(["app"]);
    const r = await runCli(["add", "Add dark mode"], { ...lasso, stdin: "n\n" });
    expect(r.code).toBe(1);
    expect(await lasso.api<unknown[]>("/api/tickets")).toEqual([]);
  });

  it("--yes accepts a suggestion but never a picker", async () => {
    const { lasso } = await lassoWithRepos(["app", "web"]);
    const ambiguous = await runCli(["add", "Fix footer", "--yes"], lasso);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("repo is ambiguous");
    const explicit = await runCli(["add", "Fix footer", "--yes", "--repo", "web"], lasso);
    expect(explicit.code).toBe(0);
    const json = await runCli(["status", "--json"], lasso);
    expect(JSON.parse(json.stdout).tickets[0].repo).toBe("web");
  });

  it("lasso status prints the ledger and a Ticket's detail", async () => {
    const { lasso } = await lassoWithRepos(["app"]);
    await runCli(["add", "Add dark mode", "--yes"], lasso);
    const ledger = await runCli(["status"], lasso);
    expect(ledger.stdout).toContain("Needs you");
    expect(ledger.stdout).toContain("Add dark mode");
    const id = JSON.parse((await runCli(["status", "--json"], lasso)).stdout).tickets[0].id;
    const detail = await runCli(["status", id], lasso);
    expect(detail.stdout).toContain("grill");
    expect(detail.stdout).toContain("worktree");
    expect(detail.stdout).toMatch(/budget:\s+rounds 0\/5 · attempts 0\/2 · wall 0s\/30m · spend \$0\.00\/\$25/);
    const asJson = JSON.parse((await runCli(["status", id, "--json"], lasso)).stdout) as TicketDetail;
    expect(asJson.id).toBe(id);
    expect(asJson.stages).toHaveLength(9);
  });
});
