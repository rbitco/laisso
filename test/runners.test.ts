import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { startLassoWithRepos, startLasso, makeHome, makeRepo, waitFor, claudeFixture, runnerFixture, type Lasso, type LassoConfig } from "./harness.ts";
import type { ProfileConfig } from "../src/server/config.ts";
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

const HEADLESS = (profile: string) => `profile: ${profile}
stages:
  - name: implement
    prompt: Do the work.
    skills: [implement]
    artifact: commits-on-branch
`;

const HUMAN = (profile: string) => `profile: ${profile}
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

/** A runner-only profile named for each Runner, as the startup migration would write. */
const PROFILES: Record<string, ProfileConfig> = { claude: { runner: "claude" }, codex: { runner: "codex" }, pi: { runner: "pi" } };

async function lassoWith(pipelines: Record<string, string>, env?: Record<string, string>, extra: LassoConfig = { profiles: PROFILES }) {
  const repos = Object.fromEntries(Object.keys(pipelines).map((name) => [name, { pipeline: name }]));
  const started = await startLassoWithRepos(repos, extra, pipelines, env);
  running.push(started.lasso);
  return started.lasso;
}

const intake = (lasso: Lasso, repo: string) =>
  lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo, pipeline: repo }) });

describe("Runner selection", () => {
  it("runs a Stage through its profile's Runner, and the rest through the Pipeline's profile", async () => {
    const lasso = await lassoWith({
      mixed: `profile: claude
stages:
  - name: implement
    prompt: Do the work.
    skills: [implement]
    profile: pi
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

describe("Agent Profiles", () => {
  const profiles: Record<string, ProfileConfig> = {
    claude: { runner: "claude" },
    "claude-opus": { runner: "claude", model: "opus", args: ["--verbose"] },
    "codex-fast": { runner: "codex", model: "gpt-5-codex", skills_dir: "/opt/skills" },
    "pi-gpt": { runner: "pi", model: "openai/gpt-5", args: ["--thinking", "high"] },
  };
  const TWO = (pipelineProfile: string | null, stageProfile: string | null) => `${pipelineProfile ? `profile: ${pipelineProfile}\n` : ""}stages:
  - name: implement
    prompt: Do the work.
    skills: [implement]
${stageProfile ? `    profile: ${stageProfile}\n` : ""}    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`;
  const everyRunner = { stdoutByRunner: { claude: claudeFixture("success.json"), codex: runnerFixture("codex", "success.jsonl"), pi: runnerFixture("pi", "success.jsonl") }, commands: commit, files: { "NOTES.md": "notes\n" } };
  /** Rewrite config.yaml by hand, as a person editing it would. */
  const editConfig = async (lasso: Lasso, edit: (text: string) => string) => {
    const file = path.join(lasso.home, "config.yaml");
    await writeFile(file, edit(await readFile(file, "utf8")));
  };

  it("launches a Stage's profile with its model and args, else the Pipeline's, else default_profile, and the Session shows which", async () => {
    const lasso = await lassoWith({ staged: TWO("codex-fast", "pi-gpt"), plain: TWO(null, null) }, undefined, { profiles, default_profile: "claude-opus" });
    const staged = await intake(lasso, "staged");
    await lasso.runner.script(everyRunner);
    await checkNow(lasso);
    const s = await finished(lasso, staged.id);

    const [pi, codex] = await lasso.runner.calls();
    expect(pi!.argv.slice(0, 11)).toEqual(["pi", "-p", "--mode", "json", "--session-id", s.sessions.find((x) => x.stage === "implement")!.id, "-a", "--model", "openai/gpt-5", "--thinking", "high"]);
    expect(codex!.argv.slice(0, 11)).toEqual(["codex", "-a", "never", "exec", "--json", "-C", staged.worktree, "-s", "workspace-write", "-m", "gpt-5-codex"]);
    expect(s.sessions.find((x) => x.stage === "implement")!.profile).toEqual({ name: "pi-gpt", runner: "pi", model: "openai/gpt-5", effort: null, permission: null, args: ["--thinking", "high"] });
    expect(s.sessions.find((x) => x.stage === "notes")!.profile).toEqual({ name: "codex-fast", runner: "codex", model: "gpt-5-codex", effort: null, permission: null, args: [] });

    const plain = await intake(lasso, "plain");
    await checkNow(lasso);
    const p = await finished(lasso, plain.id);
    const claude = (await lasso.runner.calls()).slice(2);
    expect(claude.map((c) => c.argv[0])).toEqual(["claude", "claude"]);
    for (const call of claude) expect(call.argv.slice(-3)).toEqual(["--model", "opus", "--verbose"]);
    expect(p.session!.profile).toEqual({ name: "claude-opus", runner: "claude", model: "opus", effort: null, permission: null, args: ["--verbose"] });
  });

  it("gives Codex its skills from skills_dir as link-form mentions", async () => {
    const lasso = await lassoWith({ codex: HEADLESS("codex-fast") }, undefined, { profiles });
    const ticket = await intake(lasso, "codex");
    await lasso.runner.script({ stdout: runnerFixture("codex", "success.jsonl"), commands: commit });
    await checkNow(lasso);
    await finished(lasso, ticket.id);
    const [call] = await lasso.runner.calls();
    expect(call!.argv.at(-1)!.startsWith("[$implement](/opt/skills/implement/SKILL.md)\n")).toBe(true);
  });

  it("reads a profile edit in config.yaml at the next Session, with no restart or new Version", async () => {
    const lasso = await lassoWith({ work: HEADLESS("claude-opus") }, undefined, { profiles });
    const first = await intake(lasso, "work");
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: commit });
    await checkNow(lasso);
    await finished(lasso, first.id);

    await editConfig(lasso, (text) => text.replace("model: opus", "model: sonnet").replace("- --verbose", "- --debug"));
    const second = await intake(lasso, "work");
    await checkNow(lasso);
    const d = await finished(lasso, second.id);
    const [before, after] = await lasso.runner.calls();
    expect(before!.argv.slice(-3)).toEqual(["--model", "opus", "--verbose"]);
    expect(after!.argv.slice(-3)).toEqual(["--model", "sonnet", "--debug"]);
    expect(d.session!.profile).toEqual({ name: "claude-opus", runner: "claude", model: "sonnet", effort: null, permission: null, args: ["--debug"] });
    // The Pipeline file never changed, so both Tickets run Version 1.
    expect([(await detailOf(lasso, first.id)).pipelineVersion, d.pipelineVersion]).toEqual([1, 1]);
  });

  it("hands a profile's effort and permission to each Runner's flags, and the Session shows them", async () => {
    const tuned: Record<string, ProfileConfig> = {
      "claude-max": { runner: "claude", effort: "max", permission: "full" },
      "codex-auto": { runner: "codex", model: "gpt-5-codex", effort: "xhigh", permission: "auto" },
      "claude-edits": { runner: "claude", effort: "low", permission: "edits" },
    };
    const lasso = await lassoWith({ staged: TWO("codex-auto", "claude-max"), talk: HUMAN("claude-edits") }, undefined, { profiles: tuned });
    const staged = await intake(lasso, "staged");
    await lasso.runner.script(everyRunner);
    await checkNow(lasso);
    const s = await finished(lasso, staged.id);

    const [claude, codex] = await lasso.runner.calls();
    expect(claude!.argv.slice(6, 10)).toEqual(["--permission-mode", "bypassPermissions", "--permission-prompts", "none"]);
    expect(claude!.argv.slice(-2)).toEqual(["--effort", "max"]);
    expect(codex!.argv.slice(0, 11)).toEqual(["codex", "exec", "--json", "-C", staged.worktree, "--approve-for-me", "-m", "gpt-5-codex", "-c", "model_reasoning_effort=xhigh", codex!.argv[10]]);
    expect(s.sessions.find((x) => x.stage === "implement")!.profile).toEqual({ name: "claude-max", runner: "claude", model: null, effort: "max", permission: "full", args: [] });
    expect(s.sessions.find((x) => x.stage === "notes")!.profile).toEqual({ name: "codex-auto", runner: "codex", model: "gpt-5-codex", effort: "xhigh", permission: "auto", args: [] });

    const talk = await intake(lasso, "talk");
    const opened = await openTerminal(lasso, talk.id);
    expect(opened.session!.profile).toMatchObject({ name: "claude-edits", effort: "low", permission: "edits" });
    const [terminal] = await lasso.terminals();
    expect(readFileSync(terminal!.launcher!, "utf8")).toContain(`exec 'claude' '--session-id' '${opened.session!.id}' '--permission-mode' 'acceptEdits' '--name' 'Lasso: ${talk.id.slice(-8)} grill' '--effort' 'low' '/grilling`);
  });

  it("merges the human: block into a human Session and the headless: block into a headless one, on open and on resume", async () => {
    const split: Record<string, ProfileConfig> = {
      split: { runner: "claude", model: "opus", args: ["--verbose"], human: { permission: "auto", model: "sonnet", args: ["--debug", "--chrome"] }, headless: { effort: "high", args: ["--strict"] } },
    };
    const lasso = await lassoWith({ work: HEADLESS("split"), talk: HUMAN("split") }, undefined, { profiles: split });
    const work = await intake(lasso, "work");
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: commit });
    await checkNow(lasso);
    const w = await finished(lasso, work.id);
    const [headless] = await lasso.runner.calls();
    // The human block's auto does not reach headless Sessions: they keep the shared model and the headless baseline.
    expect(headless!.argv.slice(6, 10)).toEqual(["--permission-mode", "auto", "--permission-prompts", "none"]);
    expect(headless!.argv.slice(-6)).toEqual(["--model", "opus", "--effort", "high", "--verbose", "--strict"]);
    expect(w.session!.profile).toEqual({ name: "split", runner: "claude", model: "opus", effort: "high", permission: null, args: ["--verbose", "--strict"] });

    const talk = await intake(lasso, "talk");
    const opened = await openTerminal(lasso, talk.id);
    const id = opened.session!.id;
    expect(opened.session!.profile).toEqual({ name: "split", runner: "claude", model: "sonnet", effort: null, permission: "auto", args: ["--verbose", "--debug", "--chrome"] });
    const [first] = await lasso.terminals();
    expect(readFileSync(first!.launcher!, "utf8")).toContain(`exec 'claude' '--session-id' '${id}' '--permission-mode' 'auto' '--name' 'Lasso: ${talk.id.slice(-8)} grill' '--model' 'sonnet' '--verbose' '--debug' '--chrome' '/grilling`);

    // Opening again re-enters the held Session, still under the human block.
    const again = await openTerminal(lasso, talk.id);
    expect(again.session!.id).toBe(id);
    const calls = await lasso.terminals();
    expect(readFileSync(calls[1]!.launcher!, "utf8")).toContain(`exec 'claude' '--resume' '${id}' '--permission-mode' 'auto' '--model' 'sonnet' '--verbose' '--debug' '--chrome'\n`);
  });

  it("keeps each mode's baseline for a field neither the profile nor its block sets", async () => {
    const blank: Record<string, ProfileConfig> = { blank: { runner: "claude", headless: { model: "haiku" }, human: { model: "haiku" } } };
    const lasso = await lassoWith({ work: HEADLESS("blank"), talk: HUMAN("blank") }, undefined, { profiles: blank });
    const work = await intake(lasso, "work");
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: commit });
    await checkNow(lasso);
    const w = await finished(lasso, work.id);
    const [headless] = await lasso.runner.calls();
    expect(headless!.argv.slice(6, 10)).toEqual(["--permission-mode", "auto", "--permission-prompts", "none"]);
    expect(headless!.argv).not.toContain("--effort");
    expect(headless!.argv.slice(-2)).toEqual(["--model", "haiku"]);
    expect(w.session!.profile).toEqual({ name: "blank", runner: "claude", model: "haiku", effort: null, permission: null, args: [] });

    const talk = await intake(lasso, "talk");
    const opened = await openTerminal(lasso, talk.id);
    const [terminal] = await lasso.terminals();
    expect(readFileSync(terminal!.launcher!, "utf8")).toContain(`exec 'claude' '--session-id' '${opened.session!.id}' '--permission-mode' 'acceptEdits' '--name' 'Lasso: ${talk.id.slice(-8)} grill' '--model' 'haiku' '/grilling`);
  });

  it("refuses Intake into a Pipeline whose profile config.yaml lacks, or when there is no profile at all", async () => {
    const lasso = await lassoWith({ ghost: HEADLESS("ghost"), bare: TWO(null, null) }, undefined, { profiles, default_profile: null });
    await expect(intake(lasso, "ghost")).rejects.toThrow(/Pipeline ghost: no profile named ghost in config\.yaml, which Pipeline ghost names/);
    await expect(intake(lasso, "bare")).rejects.toThrow(/Pipeline bare: Stage implement names no profile, nor does Pipeline bare, and config\.yaml has no default_profile/);
    expect(await lasso.runner.calls()).toEqual([]);
  });

  it("Flags a live Ticket whose profile was deleted when its Stage next runs, naming the profile and where", async () => {
    const lasso = await lassoWith({ work: TWO(null, "claude-opus"), talk: HUMAN("claude-opus") }, undefined, { profiles });
    const ticket = await intake(lasso, "work");
    const talk = await intake(lasso, "talk");
    await editConfig(lasso, (text) => text.replace(/ {2}claude-opus:\n(?: {4}.*\n)+/, ""));
    expect(await readFile(path.join(lasso.home, "config.yaml"), "utf8")).not.toContain("claude-opus");

    await checkNow(lasso);
    const d = await waitFor(async () => { const t = await detailOf(lasso, ticket.id); return t.flag ? t : null; }, "the Ticket to be Flagged");
    expect(d.flag).toMatchObject({ reason: "profile.missing", detail: "no profile named claude-opus in config.yaml, which Stage implement names" });
    expect(d.sessions).toEqual([]);

    await expect(openTerminal(lasso, talk.id)).rejects.toThrow(/no profile named claude-opus in config\.yaml, which Pipeline talk names/);
    expect((await detailOf(lasso, talk.id)).flag).toMatchObject({ reason: "profile.missing" });
    expect(await lasso.runner.calls()).toEqual([]);
    expect(await lasso.terminals()).toEqual([]);
  });
});

describe("A repo's own Agent Profiles", () => {
  // app overrides claude-opus, defaults to its own solo and alone defines it; web has only the global profiles.
  const globals: Record<string, ProfileConfig> = {
    "claude-opus": { runner: "claude", model: "opus", effort: "high", args: ["--global-only"] },
    "claude-sonnet": { runner: "claude", model: "sonnet" },
  };
  const appProfiles: Record<string, ProfileConfig> = {
    "claude-opus": { runner: "claude", model: "fable" },
    solo: { runner: "claude", model: "haiku", args: ["--solo"] },
  };
  const ONE = (profile: string | null) => `${profile ? `profile: ${profile}\n` : ""}stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
`;
  async function twoRepos(pipelines: Record<string, string>, app: { default_profile?: string } = {}) {
    const started = await startLassoWithRepos(
      { app: { pipeline: "work", profiles: appProfiles, ...app }, web: { pipeline: "work" } },
      { profiles: globals, default_profile: "claude-sonnet" },
      pipelines,
    );
    running.push(started.lasso);
    await started.lasso.runner.script({ stdout: claudeFixture("success.json"), commands: commit });
    return started.lasso;
  }
  const intakeInto = (lasso: Lasso, repo: string, pipeline: string) =>
    lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo, pipeline }) });
  /** Intake into each repo in turn, run each Ticket to done, and hand back each one's Session profile and argv. */
  async function runEach(lasso: Lasso, pipeline: string, repos: string[]) {
    const out = [];
    for (const repo of repos) {
      const ticket = await intakeInto(lasso, repo, pipeline);
      await checkNow(lasso);
      const d = await finished(lasso, ticket.id);
      out.push({ profile: d.session!.profile, argv: (await lasso.runner.calls()).at(-1)!.argv });
    }
    return out;
  }

  it("replaces the global profile of the same name whole, for that repo's Sessions only", async () => {
    const lasso = await twoRepos({ work: ONE("claude-opus") });
    const [app, web] = await runEach(lasso, "work", ["app", "web"]);
    // The global effort and args do not leak into app's override.
    expect(app!.argv.slice(-2)).toEqual(["--model", "fable"]);
    expect(app!.argv).not.toContain("--effort");
    expect(app!.argv).not.toContain("--global-only");
    expect(app!.profile).toEqual({ name: "claude-opus", runner: "claude", model: "fable", effort: null, permission: null, args: [] });
    expect(web!.argv.slice(-5)).toEqual(["--model", "opus", "--effort", "high", "--global-only"]);
    expect(web!.profile).toEqual({ name: "claude-opus", runner: "claude", model: "opus", effort: "high", permission: null, args: ["--global-only"] });
  });

  it("takes the repo's default_profile ahead of the global one for that repo's Tickets", async () => {
    const lasso = await twoRepos({ work: ONE(null) }, { default_profile: "solo" });
    const [app, web] = await runEach(lasso, "work", ["app", "web"]);
    expect(app!.argv.slice(-3)).toEqual(["--model", "haiku", "--solo"]);
    expect(app!.profile).toMatchObject({ name: "solo", model: "haiku" });
    expect(web!.argv.slice(-2)).toEqual(["--model", "sonnet"]);
    expect(web!.profile).toMatchObject({ name: "claude-sonnet", model: "sonnet" });
  });

  it("may exist only in the repo: saving accepts it, Intake takes it for that repo and refuses it for another", async () => {
    const lasso = await twoRepos({ work: ONE(null) });
    const save = (text: string) => lasso.api<Response>("/api/pipelines/solo", { method: "PUT", raw: true, body: JSON.stringify({ text }) });
    expect((await save(ONE("solo"))).status).toBe(200);
    const ghost = await save(ONE("ghost"));
    expect((await ghost.json()).error).toMatch(/Pipeline solo: no profile named ghost in config\.yaml/);

    const [app] = await runEach(lasso, "solo", ["app"]);
    expect(app!.argv.slice(-3)).toEqual(["--model", "haiku", "--solo"]);
    await expect(intakeInto(lasso, "web", "solo")).rejects.toThrow(/Pipeline solo: no profile named solo in config\.yaml, which Pipeline solo names/);
  });

  it("reads a repo profile edit at the next Session, and Flags when the repo's default_profile names one gone", async () => {
    const lasso = await twoRepos({ work: ONE(null) }, { default_profile: "solo" });
    const file = path.join(lasso.home, "config.yaml");
    const edit = async (change: (text: string) => string) => writeFile(file, change(await readFile(file, "utf8")));
    await edit((text) => text.replace("model: haiku", "model: opus"));
    const [first] = await runEach(lasso, "work", ["app"]);
    expect(first!.argv.slice(-3)).toEqual(["--model", "opus", "--solo"]);

    const ticket = await intakeInto(lasso, "app", "work");
    await edit((text) => text.replace(/ {6}solo:\n(?: {8}.*\n)+/, ""));
    expect(await readFile(file, "utf8")).not.toMatch(/^ {6}solo:/m);
    await checkNow(lasso);
    const d = await waitFor(async () => { const t = await detailOf(lasso, ticket.id); return t.flag ? t : null; }, "the Ticket to be Flagged");
    expect(d.flag).toMatchObject({ reason: "profile.missing", detail: "no profile named solo in config.yaml, which repo app's default_profile names" });
  });
});

describe("the shipped profiles", () => {
  const pull = (lasso: Lasso, id: string, trigger: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/${trigger}`, { method: "POST", body: "{}" });

  /** A home as a fresh install leaves it, with one repo added to the written config.yaml by hand. */
  async function freshHome() {
    const { home, pathDir } = await makeHome();
    await rm(path.join(home, "config.yaml"));
    const first = await startLasso({ home, pathDir });
    running.push(first);
    await first.stop();
    const repo = await makeRepo(path.join(home, "..", "repos"), "app");
    const file = path.join(home, "config.yaml");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("repos: {}\n", `repos:\n  app:\n    tracker: jira\n    project: APP\n    path: ${repo.path}\n`).replace("tick: 60 ", "tick: 3600 "));
    const lasso = await startLasso({ home, pathDir, port: first.port });
    running.push(lasso);
    return lasso;
  }

  it("launches a fresh home's default Pipeline with Fable for Grill, Plan and Code Review, Opus for Implement, and Sonnet for Document, all in auto", async () => {
    const lasso = await freshHome();
    const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "default" }) });

    // Grill is a human Session: Claude in auto, not the acceptEdits baseline.
    const opened = await openTerminal(lasso, ticket.id);
    expect(opened.session!.profile).toEqual({ name: "claude-fable", runner: "claude", model: "fable", effort: null, permission: "auto", args: [] });
    const [terminal] = await lasso.terminals();
    expect(readFileSync(terminal!.launcher!, "utf8")).toContain(`exec 'claude' '--session-id' '${opened.session!.id}' '--permission-mode' 'auto' '--name' 'Lasso: ${ticket.id.slice(-8)} grill' '--model' 'fable' '/grilling`);

    // Each later Stage is reached by skipping the one before once it Flags: a prompt Ticket has no issue to transition,
    // and the fake claude exits with nothing, so each headless Stage runs out of attempts.
    const flaggedAt = (stage: string) => waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.stage.name === stage && d.flag && !d.session?.running ? d : null; }, `${stage} to be Flagged`);
    const skipTo = async (stage: string) => {
      const skipped = await pull(lasso, ticket.id, "skip");
      // Grill does not advance on its own: the next Stage waits on Start.
      if (skipped.triggers.some((t) => t.action === "start")) await pull(lasso, ticket.id, "start");
      await checkNow(lasso);
      return flaggedAt(stage);
    };
    await skipTo("transition-in-progress");
    for (const stage of ["plan", "implement", "document", "code-review"]) await skipTo(stage);

    const calls = await lasso.runner.calls();
    expect(calls.map((c) => c.argv[c.argv.indexOf("--model") + 1])).toEqual(["fable", "fable", "opus", "opus", "sonnet", "sonnet", "fable", "fable"]);
    for (const call of calls) expect(call.argv.slice(6, 10)).toEqual(["--permission-mode", "auto", "--permission-prompts", "none"]);
    const sessions = (await detailOf(lasso, ticket.id)).sessions;
    expect(sessions.find((s) => s.stage === "implement")!.profile).toEqual({ name: "claude-opus", runner: "claude", model: "opus", effort: null, permission: "auto", args: [] });
    expect(sessions.find((s) => s.stage === "document")!.profile).toMatchObject({ name: "claude-sonnet", model: "sonnet" });
  });
});
