import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { startLassoWithRepos, waitFor, claudeFixture, runnerFixture, type Lasso } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: each Runner through the same Lasso-owned spawning, with the fake
// codex and pi on PATH replaying recorded output, and a human Stage opened and
// resumed on each Runner's own idea of a session id.
const running: Lasso[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const HEADLESS = (runner: string) => `runner: ${runner}
stages:
  - name: implement
    prompt: Do the work.
    skills: [implement]
    artifact: commits-on-branch
`;

const HUMAN = (runner: string) => `runner: ${runner}
stages:
  - name: grill
    prompt: Interview me about the Ticket.
    skills: [grilling]
    human: true
    artifact: file SPEC.md
`;

const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const openTerminal = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/terminal`, { method: "POST", body: "{}" });
const settled = (lasso: Lasso, id: string) => waitFor(async () => {
  const d = await detailOf(lasso, id);
  return d.session && !d.session.running ? d : null;
}, "the Session to end");
/** Done follows the last Session's end, so it is waited for separately. */
const finished = (lasso: Lasso, id: string) => waitFor(async () => { const d = await detailOf(lasso, id); return d.state === "done" ? d : null; }, "the Ticket to be done");
const commit = [["git", "commit", "-q", "--allow-empty", "-m", "work"]];

async function lassoWith(pipelines: Record<string, string>, env?: Record<string, string>) {
  const repos = Object.fromEntries(Object.keys(pipelines).map((name) => [name, { pipeline: name }]));
  const started = await startLassoWithRepos(repos, {}, pipelines, env);
  running.push(started.lasso);
  return started.lasso;
}

const intake = (lasso: Lasso, repo: string) =>
  lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo, pipeline: repo }) });

describe("Runner selection", () => {
  it("runs a Stage through the Runner it names, and the rest through the Pipeline default", async () => {
    const lasso = await lassoWith({
      mixed: `runner: claude
stages:
  - name: implement
    prompt: Do the work.
    skills: [implement]
    runner: pi
    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`,
    });
    const ticket = await intake(lasso, "mixed");

    // One script serves both Stages: implement's end kicks the tick, so notes follows without a check-now.
    await lasso.runner.script({ stdoutByRunner: { pi: runnerFixture("pi", "success.jsonl"), claude: claudeFixture("success.json") }, commands: commit, files: { "NOTES.md": "notes\n" } });
    expect((await checkNow(lasso)).changes).toEqual([{ ticket: ticket.id, summary: "started implement" }]);
    const d = await finished(lasso, ticket.id);
    const implement = d.sessions.find((s) => s.stage === "implement")!;
    expect(implement).toMatchObject({ outcome: "succeeded", finalMessage: "OK", limitsHonoured: [] });
    expect(implement.transcriptPath).toMatch(/\/\.pi\/agent\/sessions\/--.*--\/2026-09-27T06-09-58-627Z_7d3f2c10-5b1e-4a8c-9e2f-1234567890ab\.jsonl$/);
    const calls = await lasso.runner.calls();
    expect(calls.map((c) => c.argv[0])).toEqual(["pi", "claude"]);
    const [pi, claude] = calls;
    expect(pi!.argv.slice(0, 7)).toEqual(["pi", "-p", "--mode", "json", "--session-id", implement.id, "-a"]);
    expect(pi!.argv.at(-1)!.startsWith("/skill:implement\n\nYou are working Lasso Ticket")).toBe(true);
    expect(pi!.env.LASSO_SESSION).toBe(implement.id);
    expect(claude!.argv.slice(0, 2)).toEqual(["claude", "-p"]);
  });

  it("runs a Codex Stage through codex exec --json and keeps the thread id Codex assigned", async () => {
    const lasso = await lassoWith({ codex: HEADLESS("codex") });
    const ticket = await intake(lasso, "codex");
    await lasso.runner.script({ stdout: runnerFixture("codex", "success.jsonl"), commands: commit });
    await checkNow(lasso);
    const d = await finished(lasso, ticket.id);
    expect(d.session).toMatchObject({ outcome: "succeeded", finalMessage: "OK", transcriptPath: null, costUsd: null, runnerSessionId: "01a0e18c-51ac-7eb2-a6c9-cea33285e2d4" });
    const [call] = await lasso.runner.calls();
    expect(call!.argv.slice(0, 9)).toEqual(["codex", "-a", "never", "exec", "--json", "-C", ticket.worktree, "-s", "workspace-write"]);
    expect(call!.argv.at(-1)).toMatch(/^\[\$implement\]\(\/.*\/implement\/SKILL\.md\)\n\nYou are working Lasso Ticket/);
    // The worktree is gone once the Ticket is done, so its real path is resolved through the home directory.
    expect(call!.cwd).toBe(path.join(realpathSync(lasso.home), path.relative(lasso.home, ticket.worktree)));
  });

  it("reads exit 143 as interrupted for every Runner, whatever it printed first", async () => {
    const lasso = await lassoWith({ claude: HEADLESS("claude"), codex: HEADLESS("codex"), pi: HEADLESS("pi") });
    const tickets = { claude: await intake(lasso, "claude"), codex: await intake(lasso, "codex"), pi: await intake(lasso, "pi") };
    await lasso.runner.script({
      stdoutByRunner: { claude: claudeFixture("success.json"), codex: runnerFixture("codex", "success.jsonl"), pi: runnerFixture("pi", "success.jsonl") },
      commands: commit,
      exit: 143,
    });
    expect((await checkNow(lasso)).changes).toHaveLength(3);
    for (const [runner, ticket] of Object.entries(tickets)) {
      const d = await settled(lasso, ticket.id);
      expect(d.session, runner).toMatchObject({ outcome: "interrupted", endedBy: "outcome", endedReason: null });
      expect(d.flag, runner).toMatchObject({ reason: "budget.attempts", detail: "implement: 2 of 2 attempts used; OK" });
    }
    // Interrupted is retryable, so each Runner ran once per attempt.
    const calls = await lasso.runner.calls();
    expect(calls.map((c) => c.argv[0]).sort()).toEqual(["claude", "claude", "codex", "codex", "pi", "pi"]);
  });
});

describe("a human Stage on another Runner", () => {
  it("opens Pi on the Lasso-chosen session id and resumes it on that id", async () => {
    const lasso = await lassoWith({ pi: HUMAN("pi") });
    const ticket = await intake(lasso, "pi");
    const opened = await openTerminal(lasso, ticket.id);
    const id = opened.session!.id;
    expect(opened.session!.transcriptPath).toMatch(/\/\.pi\/agent\/sessions\/--.*--$/);
    const [first] = await lasso.terminals();
    const launcher = readFileSync(first!.launcher!, "utf8");
    expect(launcher).toContain(`exec 'pi' '--session-id' '${id}' '-n' 'Lasso: ${ticket.id.slice(-8)} grill' '-a' '/skill:grilling`);

    const again = await openTerminal(lasso, ticket.id);
    expect(again.session!.id).toBe(id);
    const calls = await lasso.terminals();
    expect(readFileSync(calls[1]!.launcher!, "utf8")).toContain(`exec 'pi' '--session-id' '${id}' '-a'\n`);
  });

  it("opens Codex in the worktree and resumes by the thread id found in its thread table", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "lasso-codex-"));
    dirs.push(codexHome);
    const lasso = await lassoWith({ codex: HUMAN("codex") }, { CODEX_HOME: codexHome });
    const ticket = await intake(lasso, "codex");
    const opened = await openTerminal(lasso, ticket.id);
    expect(opened.session!.transcriptPath).toBeNull();
    const [first] = await lasso.terminals();
    const launched = readFileSync(first!.launcher!, "utf8");
    expect(launched).toContain(`exec 'codex' '-s' 'workspace-write' '[$grilling](`);
    // The window runs under the same Codex home Lasso will read the thread from.
    expect(launched).toContain(`export CODEX_HOME=${JSON.stringify(codexHome).replace(/"/g, "'")}`);

    // Codex has recorded no thread yet (the human closed the window before it started): open again starts afresh, and says so.
    await openTerminal(lasso, ticket.id);
    let calls = await lasso.terminals();
    const fresh = readFileSync(calls[1]!.launcher!, "utf8");
    expect(fresh).toContain(`exec 'codex' '-s' 'workspace-write'`);
    expect(fresh).toContain(`echo 'Lasso found no codex session for grill since the last window opened; starting afresh.'`);
    expect(readFileSync(path.join(lasso.home, "lasso.log"), "utf8")).toContain("session.resume_lost");

    // Now Codex has a thread for the worktree (recorded by its physical path) since the launch: open again resumes it.
    const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER, created_at_ms INTEGER)`);
    db.prepare(`INSERT INTO threads (id, cwd, created_at_ms) VALUES (?, ?, ?)`).run("01a0e17d-746e-7123-93ce-e3f3b05e8375", realpathSync(ticket.worktree), Date.now());
    db.close();
    const resumed = await openTerminal(lasso, ticket.id);
    expect(resumed.session!.id).toBe(opened.session!.id);
    expect(resumed.session!.runnerSessionId).toBe("01a0e17d-746e-7123-93ce-e3f3b05e8375");
    expect(resumed.sessions).toHaveLength(1);
    calls = await lasso.terminals();
    expect(readFileSync(calls[2]!.launcher!, "utf8")).toContain(`exec 'codex' 'resume' '01a0e17d-746e-7123-93ce-e3f3b05e8375' '-s' 'workspace-write'\n`);

    // The found id is kept on the row: the next open re-enters it without the thread table.
    await rm(path.join(codexHome, "state_5.sqlite"));
    await openTerminal(lasso, ticket.id);
    calls = await lasso.terminals();
    expect(readFileSync(calls[3]!.launcher!, "utf8")).toContain(`exec 'codex' 'resume' '01a0e17d-746e-7123-93ce-e3f3b05e8375'`);
  });
});
