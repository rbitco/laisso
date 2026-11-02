import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startLaissoWithRepos, waitFor, claudeFixture, runnerFixture, type Laisso } from "./harness.ts";
import { PR_URL, setScene, sceneFile, swapTo, marker, type Scene } from "./scenes.ts";
import type { ProfileConfig } from "../src/server/config.ts";
import type { TicketDetail, TicketView, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";
import { Store } from "../src/store/store.ts";
import { Tickets, overridesOf } from "../src/store/tickets.ts";

// Seam one: a human's per-Ticket profile override (LASSO-75) through the API,
// with the fake Runner recording each launch's argv.
const running: Laisso[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const PROFILES: Record<string, ProfileConfig> = {
  "claude-opus": { runner: "claude", model: "opus" },
  "claude-fable": { runner: "claude", model: "fable", effort: "max", permission: "full" },
  "codex-gpt": { runner: "codex", model: "gpt-5-codex" },
  doomed: { runner: "claude", model: "sonnet" },
};

const TWO = `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`;

const HUMAN = `stages:
  - name: grill
    prompt: Interview me about the Ticket.
    human: true
    artifact: file SPEC.md
`;

const LOOP = `stages:
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
`;

const commit = [["git", "commit", "-q", "--allow-empty", "-m", "work"]];

async function laissoWithTicket(pipeline = TWO) {
  const started = await startLaissoWithRepos({ app: { pipeline: "work" } }, { profiles: PROFILES, default_profile: "claude-opus" }, { work: pipeline });
  running.push(started.laisso);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "work" }) });
  return { laisso: started.laisso, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (laisso: Laisso, id: string, lever: string, body: object = {}) => laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const override = (laisso: Laisso, id: string, stage: string, profile: string | null) =>
  laisso.api<TicketDetail>(`/api/tickets/${id}/stages/${stage}/profile`, profile === null ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ profile }) });
const flagged = (laisso: Laisso, id: string) => waitFor(async () => { const d = await detailOf(laisso, id); return d.flag ? d : null; }, "the Flag");
const launched = (laisso: Laisso, count: number) => waitFor(async () => { const c = await laisso.runner.calls(); return c.length >= count ? c : null; }, `${count} Runner launches`);
/** The value after a flag in a launch's argv, or undefined when the flag is absent. */
const flagValue = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const modelOf = (argv: string[]) => flagValue(argv, "--model");

describe("a per-Ticket profile override", () => {
  it("runs the Stage's next Session under it, and every retry after, until cleared; other Stages keep the Pipeline's", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const set = await override(laisso, ticket.id, "implement", "claude-fable");
    expect(set.stage.override).toBe("claude-fable");
    expect(set.profiles.map((p) => [p.stage, p.profile, p.from, p.overridden])).toEqual([["implement", "claude-fable", "override", true], ["notes", "claude-opus", "default", false]]);
    expect(set.profiles[0]).toMatchObject({ headless: { runner: "claude", model: "fable", effort: "max", permission: "full" }, human: { model: "fable" }, problem: null });

    // No script: each run is interrupted, so Laisso retries once on its own; both run under the override.
    await checkNow(laisso);
    const d = await flagged(laisso, ticket.id);
    expect(d.flag!.reason).toBe("budget.attempts");
    const [first, second] = await launched(laisso, 2);
    for (const call of [first!, second!]) expect([modelOf(call.argv), flagValue(call.argv, "--effort"), flagValue(call.argv, "--permission-mode")]).toEqual(["fable", "max", "bypassPermissions"]);
    expect(d.sessions.map((s) => s.profile!.name)).toEqual(["claude-fable", "claude-fable"]);

    // A human Retry still runs under it.
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await pull(laisso, ticket.id, "extend", { attempts: 4 });
    await flagged(laisso, ticket.id);
    await pull(laisso, ticket.id, "retry");
    await flagged(laisso, ticket.id);
    expect((await launched(laisso, 4)).slice(2).map((c) => modelOf(c.argv))).toEqual(["fable", "fable"]);

    // Cleared, the Stage goes back to the Pipeline's choice; notes never had one.
    const cleared = await override(laisso, ticket.id, "implement", null);
    expect(cleared.stage.override).toBeNull();
    expect(cleared.profiles[0]).toMatchObject({ profile: "claude-opus", from: "default", overridden: false });
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: commit, files: { "NOTES.md": "notes\n" } });
    await pull(laisso, ticket.id, "extend", { attempts: 5 });
    await pull(laisso, ticket.id, "retry");
    const done = await waitFor(async () => { const t = await detailOf(laisso, ticket.id); return t.state === "done" ? t : null; }, "the Ticket to be done");
    const calls = await launched(laisso, 6);
    expect(calls.slice(4).map((c) => modelOf(c.argv))).toEqual(["opus", "opus"]);
    expect(done.sessions.map((s) => [s.stage, s.profile!.name])).toEqual([["notes", "claude-opus"], ["implement", "claude-opus"], ["implement", "claude-fable"], ["implement", "claude-fable"], ["implement", "claude-fable"], ["implement", "claude-fable"]]);
  });

  it("leaves a running Session as it started and applies from the next one", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    const started = await waitFor(async () => { const t = await detailOf(laisso, ticket.id); return t.session?.running ? t.session : null; }, "the Session to start");
    await launched(laisso, 1);
    const during = await override(laisso, ticket.id, "implement", "claude-fable");
    expect(during.session).toMatchObject({ id: started.id, running: true, profile: { name: "claude-opus", model: "opus" } });
    await laisso.api(`/api/tickets/${ticket.id}/sessions/${started.id}/stop`, { method: "POST" });
    await flagged(laisso, ticket.id);
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    const retried = await pull(laisso, ticket.id, "retry");
    expect(retried.session!.profile).toMatchObject({ name: "claude-fable", model: "fable" });
    const [first, second] = await launched(laisso, 2);
    expect([modelOf(first!.argv), modelOf(second!.argv)]).toEqual(["opus", "fable"]);
  });

  it("keeps applying to later Review Rounds until cleared", async () => {
    const { laisso, ticket } = await laissoWithTicket(LOOP);
    await override(laisso, ticket.id, "review", "claude-fable");
    const T = (minute: number) => `2026-09-27T10:${String(minute).padStart(2, "0")}:00Z`;
    const checks = [{ id: 1, name: "test", status: "completed", conclusion: "success", at: T(0) }];
    let comments: NonNullable<Scene["comments"]> = [];
    /** Round n: a new comment arrives, and the Runner replies with the Round's marker. */
    const round = async (n: number) => {
      comments = [...comments, { id: 300 + n, author: "bob", body: `Fix ${n}.`, at: T(n * 10) }];
      await setScene(laisso, ticket.branch, { tag: `asked-${n}`, checks, comments });
      const replied = [...comments, { id: 400 + n, author: "laisso-bot", body: `Fixed.\n${marker(ticket.id, n)}`, at: T(n * 10 + 1) }];
      const file = await sceneFile(laisso, ticket.branch, `replied-${n}`, { tag: `replied-${n}`, checks, comments: replied });
      await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, file) });
      await checkNow(laisso);
      comments = replied;
      return waitFor(async () => { const t = await detailOf(laisso, ticket.id); return t.sessions.length >= n && t.sessions.every((s) => !s.running) && t.display.state === "quiet" ? t : null; }, `Round ${n} to end`);
    };
    await round(1);
    await round(2);
    await override(laisso, ticket.id, "review", null);
    const d = await round(3);
    expect(d.prs.map((p) => [p.role, p.source, p.url])).toEqual([["owned", "branch", PR_URL]]);
    expect(d.sessions.map((s) => [s.round, s.profile!.name])).toEqual([[3, "claude-opus"], [2, "claude-fable"], [1, "claude-fable"]]);
    expect((await launched(laisso, 3)).map((c) => modelOf(c.argv))).toEqual(["fable", "fable", "opus"]);
  });

  it("refuses a profile the repo lacks, a Stage the Version lacks, an action Stage, and an ended Ticket", async () => {
    const { laisso, ticket } = await laissoWithTicket(`stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
  - action: tracker.transition
    status: In Review
`);
    await expect(override(laisso, ticket.id, "implement", "claude-ghost")).rejects.toThrow("no profile named claude-ghost in config.yaml for repo app");
    await expect(laisso.api(`/api/tickets/${ticket.id}/stages/implement/profile`, { method: "PUT", body: "{}" })).rejects.toThrow("name the profile to use");
    await expect(override(laisso, ticket.id, "plan", "claude-fable")).rejects.toThrow("Pipeline work v1 has no Stage named plan");
    const action = (await detailOf(laisso, ticket.id)).stages[1]!.name;
    await expect(override(laisso, ticket.id, action, "claude-fable")).rejects.toThrow(`${action} is an action Stage; it runs no profile`);
    await expect(override(laisso, "nope", "implement", "claude-fable")).rejects.toThrow(/no Ticket matches nope/);
    expect((await detailOf(laisso, ticket.id)).profiles.map((p) => p.overridden)).toEqual([false]);
    await pull(laisso, ticket.id, "abandon");
    await expect(override(laisso, ticket.id, "implement", "claude-fable")).rejects.toThrow("is abandoned");
  });

  it("Flags the Ticket when the override names a profile since deleted, saying the override named it", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await override(laisso, ticket.id, "implement", "doomed");
    const file = path.join(laisso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/ {2}doomed:\n(?: {4}.*\n)+/, ""));
    const problem = "no profile named doomed in config.yaml, which the Ticket's override for Stage implement names";
    expect((await detailOf(laisso, ticket.id)).profiles[0]).toMatchObject({ profile: "doomed", from: "override", overridden: true, headless: null, problem });
    await checkNow(laisso);
    const d = await flagged(laisso, ticket.id);
    expect(d.flag).toMatchObject({ reason: "profile.missing", detail: problem });
    expect(d.sessions).toEqual([]);
    expect(await laisso.runner.calls()).toEqual([]);
  });
});

describe("retry with a profile", () => {
  it("sets the override and starts a fresh Session under it", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    await flagged(laisso, ticket.id);

    // A profile the repo lacks is refused before anything changes.
    await expect(pull(laisso, ticket.id, "retry", { profile: "claude-ghost" })).rejects.toThrow("no profile named claude-ghost");
    expect(await detailOf(laisso, ticket.id)).toMatchObject({ flag: { reason: "outcome.failed" }, stage: { override: null } });

    const retried = await pull(laisso, ticket.id, "retry", { profile: "codex-gpt" });
    expect(retried.flag).toBeNull();
    expect(retried.stage.override).toBe("codex-gpt");
    expect(retried.session).toMatchObject({ ordinal: 2, startedBy: "human", runner: "codex", profile: { name: "codex-gpt", model: "gpt-5-codex" } });
    const [, codex] = await launched(laisso, 2);
    expect(codex!.argv.slice(0, 3)).toEqual(["codex", "-a", "never"]);
    expect(codex!.argv).not.toContain("resume");
    expect(flagValue(codex!.argv, "-m")).toBe("gpt-5-codex");
  });
});

describe("Resume under an override", () => {
  it("passes the new model, effort and permission on the same Runner", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    const first = (await flagged(laisso, ticket.id)).session!;
    const set = await override(laisso, ticket.id, "implement", "claude-fable");
    expect(set.triggers.find((x) => x.action === "resume")).toEqual({ action: "resume", label: "Resume implement" });
    const resumed = (await pull(laisso, ticket.id, "resume")).session!;
    expect(resumed).toMatchObject({ ordinal: 2, runnerSessionId: first.id, profile: { name: "claude-fable", model: "fable", effort: "max", permission: "full" } });
    const [, call] = await launched(laisso, 2);
    expect(flagValue(call!.argv, "--resume")).toBe(first.id);
    expect([modelOf(call!.argv), flagValue(call!.argv, "--effort"), flagValue(call!.argv, "--permission-mode")]).toEqual(["fable", "max", "bypassPermissions"]);
  });

  it("is unavailable on another Runner, with the reason on the Ticket and the refusal, and Retry starts afresh", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    await flagged(laisso, ticket.id);
    const reason = "implement last ran on claude and codex-gpt runs codex; Resume stays on one Runner, so Retry starts afresh";
    const set = await override(laisso, ticket.id, "implement", "codex-gpt");
    expect(set.triggers.find((x) => x.action === "resume")).toEqual({ action: "resume", label: "Resume implement", unavailable: reason });
    await expect(pull(laisso, ticket.id, "resume")).rejects.toThrow(reason);
    expect((await detailOf(laisso, ticket.id)).flag).not.toBeNull();
    expect(await laisso.runner.calls()).toHaveLength(1);

    // A config edit that moves the profile the Stage runs to another Runner is refused the same way.
    await override(laisso, ticket.id, "implement", null);
    const file = path.join(laisso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/( {2}claude-opus:\n {4}runner: )claude/, "$1pi"));
    await expect(pull(laisso, ticket.id, "resume")).rejects.toThrow("implement last ran on claude and claude-opus runs pi");

    await laisso.runner.script({ stdout: runnerFixture("pi", "success.jsonl"), commands: commit });
    const retried = await pull(laisso, ticket.id, "retry");
    expect(retried.session).toMatchObject({ ordinal: 2, runner: "pi", runnerSessionId: null });
  });

  it("ends a held terminal on another Runner when Open terminal is pressed, and opens a fresh one", async () => {
    const { laisso, ticket } = await laissoWithTicket(HUMAN);
    const opened = await pull(laisso, ticket.id, "terminal");
    const held = opened.session!;
    await override(laisso, ticket.id, "grill", "codex-gpt");

    const again = await pull(laisso, ticket.id, "terminal");
    expect(again.session!.id).not.toBe(held.id);
    expect(again.session).toMatchObject({ runner: "codex", running: true, profile: { name: "codex-gpt" } });
    expect(again.sessions.find((s) => s.id === held.id)).toMatchObject({ running: false, endedBy: "human", runner: "claude" });
    const launchers = await laisso.terminals();
    const text = readFileSync(launchers[1]!.launcher!, "utf8");
    expect(text).toContain("grill now runs codex-gpt on codex, not claude; starting afresh.");
    expect(text).not.toContain("resume");
  });
});

describe("overrides across a Version upgrade", () => {
  it("keep only those whose Stage the new Version has", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "laisso-overrides-"));
    dirs.push(dir);
    const store = new Store(path.join(dir, "laisso.db"));
    try {
      const tickets = new Tickets(store.db);
      tickets.insert({ id: "01T", repo: "app", reference: null, origin: "prompt", prompt: "p", title: "t", body: null, pipeline: "work", pipeline_version: 1, stage: "implement", branch: "b", worktree: "w" });
      tickets.setOverride("01T", "implement", "claude-fable");
      tickets.setOverride("01T", "notes", "codex-gpt");
      expect(overridesOf(tickets.get("01T")!)).toEqual({ implement: "claude-fable", notes: "codex-gpt" });
      // Version 2 renames notes to document: implement's override survives, notes's is dropped.
      const kept = tickets.keepOverrides("01T", ["implement", "document"]);
      expect(overridesOf(kept)).toEqual({ implement: "claude-fable" });
      expect(overridesOf(tickets.keepOverrides("01T", ["plan"]))).toEqual({});
      expect(tickets.get("01T")!.profile_overrides).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("the Ledger view of an override", () => {
  it("carries the current Stage's override only", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await override(laisso, ticket.id, "notes", "claude-fable");
    const list = () => laisso.api<TicketView[]>("/api/tickets");
    expect((await list())[0]!.stage).toMatchObject({ name: "implement", override: null });
    await override(laisso, ticket.id, "implement", "codex-gpt");
    expect((await list())[0]!.stage).toMatchObject({ name: "implement", override: "codex-gpt" });
  });
});
