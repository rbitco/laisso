import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { startLassoWithRepos, startLasso, runCli, waitFor, claudeFixture, type Lasso } from "./harness.ts";
import type { TicketDetail, IntakeResult, SessionView } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: a headless Stage from check-now through the fake claude Runner to
// advance or Flag, watched through the API the dashboard and CLI use.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `runner: claude
stages:
  - name: implement
    prompt: Do the work.
    skills: [implement]
    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`;

async function lassoWithTicket(pipeline = PIPELINE) {
  const started = await startLassoWithRepos({ app: { pipeline: "two" } }, {}, { two: pipeline });
  running.push(started.lasso);
  const ticket = await started.lasso.api<IntakeResult>("/api/tickets", {
    method: "POST",
    body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "two" }),
  });
  return { ...started, ticket };
}

const launched = (lasso: Lasso) => waitFor(async () => { const calls = await lasso.runner.calls(); return calls.length ? calls : null; }, "the Runner to launch");
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const settled = (lasso: Lasso, id: string) => waitFor(async () => {
  const d = await detailOf(lasso, id);
  return d.session && !d.session.running ? d : null;
}, "the Session to end");

describe("a headless Stage", () => {
  it("starts a fresh Session on check-now, tees stdout live, and Stop ends it as interrupted", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ stdout: '{"type":"system","subtype":"init","session_id":"ignored"}', hang: true });

    const tick = await checkNow(lasso);
    expect(tick.changes).toEqual([{ ticket: ticket.id, summary: "started implement" }]);

    const d = await detailOf(lasso, ticket.id);
    expect(d.display).toEqual({ state: "running", label: "Running", why: "implement, run 1" });
    expect(d.session).toMatchObject({ stage: "implement", ordinal: 1, mode: "headless", startedBy: "auto", running: true, outcome: null, endedAt: null, limitsHonoured: ["remainingSpendUsd"] });
    expect(d.sessions).toHaveLength(1);
    const session = d.session!;
    expect(session.stdoutPath).toBe(`${lasso.home}/tickets/${ticket.id}/sessions/${session.id}.stdout`);

    const [call] = await launched(lasso);
    expect(realpathSync(call!.cwd)).toBe(realpathSync(ticket.worktree));
    expect(call!.argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(call!.argv[2]).toContain("Add dark mode");
    expect(call!.argv[2]).toContain("/implement");
    expect(call!.argv).toContain("--session-id");
    expect(call!.argv[call!.argv.indexOf("--session-id") + 1]).toBe(session.id);
    expect(call!.argv).toContain("--max-budget-usd");
    expect(call!.env).toMatchObject({ LASSO_TICKET: ticket.id, LASSO_STAGE: "implement", LASSO_SESSION: session.id, LASSO_BRANCH: ticket.branch });

    const tail = await waitFor(async () => {
      const t = await lasso.api<{ text: string; offset: number; ended: boolean }>(`/api/tickets/${ticket.id}/sessions/${session.id}/stdout`);
      return t.text ? t : null;
    }, "stdout to arrive");
    expect(tail.text).toContain('"subtype":"init"');
    expect(tail.ended).toBe(false);
    const more = await lasso.api<{ text: string; offset: number }>(`/api/tickets/${ticket.id}/sessions/${session.id}/stdout?offset=${tail.offset}`);
    expect(more.text).toBe("");

    // A second check-now leaves the running Session alone.
    expect((await checkNow(lasso)).changes).toEqual([]);

    const stopped = await lasso.api<SessionView>(`/api/tickets/${ticket.id}/sessions/${session.id}/stop`, { method: "POST" });
    expect(stopped).toMatchObject({ id: session.id, running: false, outcome: "interrupted", endedBy: "human", endedReason: "stop", finalMessage: "killed: stop" });
    expect(() => process.kill(call!.pid, 0)).toThrow();

    const after = await detailOf(lasso, ticket.id);
    expect(after.display.state).toBe("flagged");
    expect(after.flag).toMatchObject({ reason: "outcome.interrupted" });
    expect(readFileSync(session.stdoutPath!, "utf8")).toContain('"subtype":"init"');
    await expect(lasso.api(`/api/tickets/${ticket.id}/sessions/${session.id}/stop`, { method: "POST" })).rejects.toThrow("is not running");
  });

  it("advances on succeeded with the artifact present, and finishes the Ticket after the last Stage", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], stdout: claudeFixture("success.json") });
    await checkNow(lasso);

    const first = await settled(lasso, ticket.id);
    expect(first.session).toMatchObject({ stage: "implement", outcome: "succeeded", endedBy: "outcome", endedReason: null, finalMessage: "OK", costUsd: 0.2936585 });
    expect(first.session!.usage).toMatchObject({ output_tokens: 4 });
    expect(first.session!.transcriptPath).toMatch(/3e728ae2-8d99-42f3-a7ba-6066de05d169\.jsonl$/);
    expect(first.stage.name).toBe("notes");
    expect(first.display).toMatchObject({ state: "ready", why: "notes starts on the next tick" });

    await lasso.runner.script({ files: { "NOTES.md": "notes\n" }, stdout: claudeFixture("success.json") });
    await checkNow(lasso);
    const done = await waitFor(async () => {
      const d = await detailOf(lasso, ticket.id);
      return d.state === "done" ? d : null;
    }, "the Ticket to be done");
    expect(done.display.state).toBe("done");
    expect(existsSync(`${ticket.worktree}/NOTES.md`)).toBe(true);

    // The timeline is newest first, one Session per Stage run.
    expect(done.sessions.map((s) => [s.stage, s.ordinal, s.outcome])).toEqual([["notes", 1, "succeeded"], ["implement", 1, "succeeded"]]);
    expect(await lasso.api<unknown[]>("/api/tickets")).toEqual([]);

    const cli = await runCli(["status", ticket.id], lasso);
    expect(cli.stdout).toContain("sessions:");
    expect(cli.stdout).toMatch(/notes.*succeeded/);
    expect(cli.stdout).toMatch(/implement.*succeeded.*\$0\.29/);
  });

  it("Flags artifact.missing when the Runner succeeds without the artifact", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(lasso);
    const d = await settled(lasso, ticket.id);
    expect(d.session!.outcome).toBe("succeeded");
    expect(d.stage.name).toBe("implement");
    expect(d.display.state).toBe("flagged");
    expect(d.flag).toEqual({ reason: "artifact.missing", detail: "commits-on-branch: no commits on the branch beyond origin/main", at: expect.any(String) });
  });

  it("Flags outcome.failed with the Runner's message", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(lasso);
    const d = await settled(lasso, ticket.id);
    expect(d.session).toMatchObject({ outcome: "failed", costUsd: 0 });
    expect(d.flag).toMatchObject({ reason: "outcome.failed", detail: expect.stringContaining("There's an issue with the selected model") });
  });

  it("Flags outcome.exhausted when the Runner hits max turns", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ stdout: claudeFixture("max-turns.json"), exit: 1 });
    await checkNow(lasso);
    const d = await settled(lasso, ticket.id);
    expect(d.flag).toMatchObject({ reason: "outcome.exhausted", detail: "Reached maximum number of turns (1)" });
  });

  it("refuses a Pipeline whose wall time is not a duration", async () => {
    const { lasso } = await lassoWithTicket();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${lasso.home}/pipelines/bad.yaml`, PIPELINE.replace("artifact: commits-on-branch", "artifact: commits-on-branch\n    budget: { wallTime: 45min }"));
    const res = await lasso.api<Response>("/api/tickets", { method: "POST", raw: true, body: JSON.stringify({ input: "Another", repo: "app", pipeline: "bad" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Pipeline bad stage 1: budget.wallTime "45min" is not a duration like 30m, 90s, or 1h30m' });
  });

  it("kills a Session past the Stage's wall time and Flags budget.wall_time", async () => {
    const { lasso, ticket } = await lassoWithTicket(PIPELINE.replace("artifact: commits-on-branch", "artifact: commits-on-branch\n    budget: { wallTime: 1s }"));
    await lasso.runner.script({ hang: true });
    await checkNow(lasso);
    const d = await settled(lasso, ticket.id);
    expect(d.session).toMatchObject({ outcome: "interrupted", endedBy: "outcome", endedReason: "wall_time" });
    expect(d.session!.durationMs).toBeGreaterThanOrEqual(900);
    expect(d.flag).toMatchObject({ reason: "budget.wall_time" });
    const [call] = await lasso.runner.calls();
    expect(() => process.kill(call!.pid, 0)).toThrow();
  });

  it("records a Session cut off by shutdown as interrupted and leaves the Ticket to run again", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ hang: true });
    await checkNow(lasso);
    const [call] = await lasso.runner.calls();
    expect(await lasso.stop()).toBe(0);
    expect(() => process.kill(call!.pid, 0)).toThrow();

    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    const d = await detailOf(again, ticket.id);
    expect(d.flag).toBeNull();
    const shut = d.sessions.find((s) => s.endedReason === "shutdown");
    expect(shut).toMatchObject({ ordinal: 1, outcome: "interrupted", endedBy: "outcome" });
    // The startup tick started run 2.
    expect(d.session).toMatchObject({ ordinal: 2, running: true });
  });

  it("reconciles a Session left running by a Lasso that died: kills the Runner and records shutdown", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await lasso.runner.script({ hang: true });
    await checkNow(lasso);
    const [call] = await launched(lasso);
    lasso.child.kill("SIGKILL");
    await new Promise((r) => lasso.child.once("exit", r));
    expect(() => process.kill(call!.pid, 0)).not.toThrow();

    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    const d = await detailOf(again, ticket.id);
    const orphan = d.sessions.find((s) => s.ordinal === 1);
    expect(orphan).toMatchObject({ running: false, outcome: "interrupted", endedBy: "outcome", endedReason: "shutdown" });
    await waitFor(async () => { try { process.kill(call!.pid, 0); return null; } catch { return true; } }, "the orphaned Runner to die");
    expect(d.flag).toBeNull();
  });
});
