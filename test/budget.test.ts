import { describe, it, expect, afterEach } from "vitest";
import { startLaissoWithRepos, waitFor, claudeFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, TicketView, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: the Budget from the config, Pipeline and Ticket layers through
// auto-retry, the pre-start refusals and the six exits, watched through the
// API. The fake claude with no script exits at once with nothing on stdout,
// which Laisso reads as interrupted.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`;

const commit = [["git", "commit", "-q", "--allow-empty", "-m", "work"]];

async function laissoWithTicket(config: LaissoConfig = {}, pipeline = PIPELINE) {
  const started = await startLaissoWithRepos({ app: { pipeline: "two" } }, config, { two: pipeline });
  running.push(started.laisso);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "two" }) });
  return { ...started, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (laisso: Laisso, id: string, lever: string, body: object = {}) =>
  laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const flagged = (laisso: Laisso, id: string) => waitFor(async () => { const d = await detailOf(laisso, id); return d.flag ? d : null; }, "the Flag");
const notified = (laisso: Laisso, count: number) =>
  waitFor(async () => { const n = await laisso.notifications(); return n.length >= count ? n : null; }, `${count} notifications`);
const launched = (laisso: Laisso, count: number) =>
  waitFor(async () => { const c = await laisso.runner.calls(); return c.length >= count ? c : null; }, `${count} Runner launches`);

describe("attempts", () => {
  it("retries an interrupted run once per remaining attempt, then Flags budget.attempts with the Outcome, once", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    expect(ticket.budget).toMatchObject({
      rounds: { used: 0, limit: 5, source: "global" },
      attempts: { used: 0, limit: 2, source: "global" },
      wallTime: { used: 0, limit: 30 * 60 * 1000, source: "global", limitText: "30m" },
      spend: { used: 0, limit: 25, source: "global" },
      ticket: { rounds: null, attempts: null, wallTime: null, spend: null },
    });
    await checkNow(laisso);
    const d = await flagged(laisso, ticket.id);
    expect(d.flag).toMatchObject({ reason: "budget.attempts", detail: "implement: 2 of 2 attempts used" });
    expect(d.sessions.map((s) => [s.ordinal, s.outcome, s.startedBy])).toEqual([[2, "interrupted", "auto"], [1, "interrupted", "auto"]]);
    expect(d.budget.attempts).toEqual({ used: 2, limit: 2, source: "global" });
    expect(d.triggers.map((x) => x.action)).toEqual(["retry", "resume", "takeover", "extend", "done", "skip", "abandon"]);
    expect((await notified(laisso, 1)).map((n) => n.body)).toEqual(["budget.attempts: implement: 2 of 2 attempts used"]);

    // Retry and Resume are refused at the limit; nothing changes.
    await expect(pull(laisso, ticket.id, "retry")).rejects.toThrow("implement: 2 of 2 attempts used; Extend the Budget first");
    await expect(pull(laisso, ticket.id, "resume")).rejects.toThrow("implement: 2 of 2 attempts used; Extend the Budget first");
    expect((await detailOf(laisso, ticket.id)).flag).not.toBeNull();

    // Extend validates, then raises the Ticket layer; a budget.* Flag clears and the Stage starts again at once.
    await expect(pull(laisso, ticket.id, "extend", { attempts: -1 })).rejects.toThrow("attempts must be a whole number");
    await expect(pull(laisso, ticket.id, "extend", { wallTime: "45min" })).rejects.toThrow(/wallTime .*45min.* is not a duration/);
    await expect(pull(laisso, ticket.id, "extend", {})).rejects.toThrow("nothing to extend");
    await expect(pull(laisso, ticket.id, "extend", 7 as unknown as object)).rejects.toThrow("nothing to extend");
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: commit, files: { "NOTES.md": "notes\n" } });
    const extended = await pull(laisso, ticket.id, "extend", { attempts: 3, wallTime: "2m" });
    expect(extended.flag).toBeNull();
    expect(extended.budget.attempts).toEqual({ used: 3, limit: 3, source: "ticket" });
    expect(extended.budget.wallTime).toMatchObject({ limit: 120_000, source: "ticket", limitText: "2m" });
    expect(extended.budget.ticket).toEqual({ rounds: null, attempts: 3, wallTime: "2m", spend: null, routes: null });
    expect(extended.session).toMatchObject({ stage: "implement", ordinal: 3, startedBy: "auto" });
    // implement's end kicks the tick, so notes runs straight after; its attempts count from zero.
    const done = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    expect(done.sessions.map((s) => [s.stage, s.ordinal])).toEqual([["notes", 1], ["implement", 3], ["implement", 2], ["implement", 1]]);
    expect(done.budget.spend.used).toBeCloseTo(0.587317, 5);
    const calls = await launched(laisso, 3);
    expect(calls[2]!.argv).toContain("--session-id");
    expect(calls[2]!.argv).toContain("--max-budget-usd");
    expect(await laisso.notifications()).toHaveLength(1);
  });

  it("Retry starts a fresh Session of the Stage a failed run Flagged, started by the human", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    const d = await flagged(laisso, ticket.id);
    expect(d.flag!.reason).toBe("outcome.failed");
    expect(d.sessions).toHaveLength(1);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: commit });
    const retried = await pull(laisso, ticket.id, "retry");
    expect(retried.flag).toBeNull();
    expect(retried.session).toMatchObject({ stage: "implement", ordinal: 2, startedBy: "human", running: true });
    expect(retried.session!.runnerSessionId).toBeNull();
    await expect(pull(laisso, ticket.id, "retry")).rejects.toThrow("is not Flagged");
    await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.stage.name === "notes" ? d : null; }, "implement to finish");
  });

  it("Resume re-enters the first Session of the Stage by its id, on a fresh row each time", async () => {
    const { laisso, ticket } = await laissoWithTicket({ budget: { attempts: 3 } });
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    const first = (await flagged(laisso, ticket.id)).session!;
    const second = (await pull(laisso, ticket.id, "resume")).session!;
    expect(second).toMatchObject({ ordinal: 2, startedBy: "human", runnerSessionId: first.id });
    expect(second.id).not.toBe(first.id);
    await flagged(laisso, ticket.id);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: commit });
    const third = (await pull(laisso, ticket.id, "resume")).session!;
    expect(third).toMatchObject({ ordinal: 3, runnerSessionId: first.id });
    const calls = await launched(laisso, 3);
    for (const call of calls.slice(1)) {
      expect(call.argv).not.toContain("--session-id");
      expect(call.argv[call.argv.indexOf("--resume") + 1]).toBe(first.id);
    }
    expect(calls[2]!.env.LAISSO_SESSION).toBe(third.id);
    await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.stage.name === "notes" ? d : null; }, "implement to finish");
  });

  it("refuses the next Session before it starts when the Ticket layer leaves no attempts", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await pull(laisso, ticket.id, "extend", { attempts: 0 });
    const tick = await checkNow(laisso);
    expect(tick.changes).toEqual([{ ticket: ticket.id, summary: "Flagged: implement: 0 of 0 attempts used" }]);
    const d = await detailOf(laisso, ticket.id);
    expect(d.flag).toMatchObject({ reason: "budget.attempts", detail: "implement: 0 of 0 attempts used" });
    expect(d.sessions).toEqual([]);
    expect(d.triggers.map((x) => x.action)).toEqual(["retry", "extend", "done", "skip", "abandon"]);
    await expect(pull(laisso, ticket.id, "resume")).rejects.toThrow("no Session of implement to resume; Retry starts a fresh one");

    // Clearing the Ticket layer makes the next Session affordable: a budget.* Flag clears and the tick starts it.
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: commit });
    const cleared = await pull(laisso, ticket.id, "extend", { attempts: null });
    expect(cleared.flag).toBeNull();
    expect(cleared.budget.attempts).toMatchObject({ limit: 2, source: "global" });
    expect(cleared.session).toMatchObject({ ordinal: 1, startedBy: "auto" });
  });
});

describe("spend and Rounds", () => {
  it("Flags budget.cost before the next Stage once the Ticket's spend reaches the ceiling", async () => {
    const { laisso, ticket } = await laissoWithTicket({ budget: { spend: 0.25 } });
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: commit });
    await checkNow(laisso);
    // implement's end kicks the tick, which finds the spend over the ceiling before notes starts.
    const d = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.flag ? d : null; }, "the Flag");
    expect(d.stage.name).toBe("notes");
    expect(d.budget.spend).toEqual({ used: 0.2936585, limit: 0.25, source: "global" });
    expect(d.flag).toMatchObject({ reason: "budget.cost", detail: "spend $0.29 of $0.25 used" });
    expect(d.sessions).toHaveLength(1);

    await laisso.runner.script({ stdout: claudeFixture("success.json"), files: { "NOTES.md": "notes\n" } });
    const extended = await pull(laisso, ticket.id, "extend", { spend: 1 });
    expect(extended.flag).toBeNull();
    expect(extended.budget.spend).toEqual({ used: 0.2936585, limit: 1, source: "ticket" });
    expect(extended.session).toMatchObject({ stage: "notes", running: true });
    const done = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    expect(done.budget.spend.used).toBeCloseTo(0.587317, 5);
  });

  // Rounds against the Budget are exercised in review.test.ts, where a repeating Stage has Feedback to open one.

  it("does not count a Session cut off by shutdown as an attempt", async () => {
    const { laisso, ticket } = await laissoWithTicket({ budget: { attempts: 1 } });
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    await laisso.stop();
    const { startLaisso } = await import("./harness.ts");
    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    const d = await waitFor(async () => { const x = await detailOf(again, ticket.id); return x.session?.ordinal === 2 ? x : null; }, "the startup tick to start run 2");
    expect(d.flag).toBeNull();
    expect(d.session).toMatchObject({ ordinal: 2, running: true });
    expect(d.budget.attempts).toEqual({ used: 1, limit: 1, source: "global" });
  });
});

describe("the other exits", () => {
  it("Mark done on a Flagged Ticket checks the artifact with override, then advances", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    const d = await flagged(laisso, ticket.id);
    expect(d.flag!.reason).toBe("outcome.failed");
    const res = await laisso.api<Response>(`/api/tickets/${ticket.id}/done`, { method: "POST", raw: true, body: "{}" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ artifact: "commits-on-branch", override: true });
    const done = await pull(laisso, ticket.id, "done", { override: true });
    expect(done.flag).toBeNull();
    expect(done.stage.name).toBe("notes");
    expect(done.display.state).toBe("ready");
  });

  it("Skip on a Flagged Ticket drops the Stage and advances", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("failed.jsonl"), exit: 1 });
    await checkNow(laisso);
    await flagged(laisso, ticket.id);
    const skipped = await pull(laisso, ticket.id, "skip");
    expect(skipped.flag).toBeNull();
    expect(skipped.stage.name).toBe("notes");
    expect(skipped.stages.map((s) => s.skippedAt === null)).toEqual([false, true]);
    expect(skipped.triggers.map((x) => x.action)).toEqual(["skip", "abandon"]);
  });

  it("Abandon ends the Ticket, kills its running Session, and hides it from the Ledger", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    const [call] = await launched(laisso, 1);
    const abandoned = await pull(laisso, ticket.id, "abandon");
    expect(abandoned).toMatchObject({ state: "abandoned", flag: null, triggers: [] });
    expect(abandoned.display).toEqual({ state: "abandoned", label: "Abandoned", why: "abandoned" });
    expect(abandoned.session).toMatchObject({ running: false, outcome: "interrupted", endedBy: "human", endedReason: "abandon" });
    expect(() => process.kill(call!.pid, 0)).toThrow();
    expect(await laisso.api<TicketView[]>("/api/tickets")).toEqual([]);
    expect((await laisso.api<TicketView[]>("/api/tickets?all=1")).map((t) => t.state)).toEqual(["abandoned"]);
    await expect(pull(laisso, ticket.id, "abandon")).rejects.toThrow("is already abandoned");
    await expect(pull(laisso, ticket.id, "retry")).rejects.toThrow("is abandoned");
  });
});
