import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { startLassoWithRepos, startLasso, waitFor, claudeFixture, type Lasso, type LassoConfig } from "./harness.ts";
import type { TicketDetail, TicketView, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: the concurrency cap and the queue behind it, watched through the
// API. The fake claude hangs so Sessions hold their slots until stopped.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const HEADLESS = `runner: claude
stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
`;
const HUMAN = `runner: claude
stages:
  - name: grill
    prompt: Interview me.
    human: true
    artifact: file SPEC.md
`;

async function lassoWith(config: LassoConfig, pipelines: Record<string, string> = { work: HEADLESS }) {
  const repos = Object.fromEntries(Object.keys(pipelines).map((name) => [name, { pipeline: name }]));
  const started = await startLassoWithRepos(repos, config, pipelines);
  running.push(started.lasso);
  return started.lasso;
}

const intake = (lasso: Lasso, repo: string, title: string) =>
  lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: title, repo, pipeline: repo }) });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const ledger = (lasso: Lasso) => lasso.api<TicketView[]>("/api/tickets");
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const stop = async (lasso: Lasso, id: string) => {
  const d = await detailOf(lasso, id);
  await lasso.api(`/api/tickets/${id}/sessions/${d.session!.id}/stop`, { method: "POST" });
};
const summaries = (changes: TickChange[]) => changes.map((c) => c.summary);

describe("the concurrency cap", () => {
  it("starts runnable Tickets oldest first up to the cap, queues the rest with a position, and fills a slot once a Session ends", async () => {
    const lasso = await lassoWith({ concurrency: 2 });
    await lasso.runner.script({ hang: true });
    const a = await intake(lasso, "work", "A");
    const b = await intake(lasso, "work", "B");
    const c = await intake(lasso, "work", "C");
    expect(c.display).toMatchObject({ state: "ready", why: "implement starts on the next tick" });
    expect(c.queue).toBeNull();

    expect(summaries((await checkNow(lasso)).changes)).toEqual(["started implement", "started implement"]);
    const queued = await detailOf(lasso, c.id);
    expect(queued.display).toEqual({ state: "queued", label: "Queued", why: "1 in line; implement starts when a slot frees" });
    expect(queued.queue).toBe(1);
    expect(queued.sessions).toEqual([]);
    expect(queued.triggers.map((x) => x.action)).toEqual(["abandon"]);
    expect((await detailOf(lasso, a.id)).display.state).toBe("running");
    expect((await detailOf(lasso, b.id)).display.state).toBe("running");

    // A fourth queues behind the third; the Ledger shows Running before Queued, and Queued by position.
    const d = await intake(lasso, "work", "D");
    expect(summaries((await checkNow(lasso)).changes)).toEqual([]);
    expect((await detailOf(lasso, d.id)).queue).toBe(2);
    expect((await ledger(lasso)).map((t) => [t.title, t.display.state, t.queue])).toEqual([
      ["B", "running", null],
      ["A", "running", null],
      ["C", "queued", 1],
      ["D", "queued", 2],
    ]);

    // Stopping A frees a slot: the tick its end kicks starts C, the oldest in line, and D moves up.
    await stop(lasso, a.id);
    await waitFor(async () => ((await detailOf(lasso, c.id)).display.state === "running" ? true : null), "C to start");
    expect((await detailOf(lasso, d.id)).display).toMatchObject({ state: "queued", why: "1 in line; implement starts when a slot frees" });
    expect((await detailOf(lasso, a.id)).display.state).toBe("flagged");
    // A may have been stopped before its fake claude booted; B and C record their launch either way.
    const calls = await waitFor(async () => { const calls = await lasso.runner.calls(); return calls.length >= 2 ? calls : null; }, "B and C to launch");
    expect(calls.map((call) => call.env.LASSO_TICKET)).toEqual(expect.arrayContaining([b.id, c.id]));
  });

  it("does not count a terminal Session as a slot", async () => {
    const lasso = await lassoWith({ concurrency: 1 }, { work: HEADLESS, talk: HUMAN });
    await lasso.runner.script({ hang: true });
    const talk = await intake(lasso, "talk", "Talk");
    const opened = await lasso.api<TicketDetail>(`/api/tickets/${talk.id}/terminal`, { method: "POST" });
    expect(opened.session).toMatchObject({ mode: "terminal", running: true });
    const work = await intake(lasso, "work", "Work");
    expect(summaries((await checkNow(lasso)).changes)).toEqual(["started implement"]);
    expect((await detailOf(lasso, work.id)).display.state).toBe("running");
    expect((await detailOf(lasso, talk.id)).display.state).toBe("needs_you");
  });

  it("reads a changed cap from config.yaml on the next tick", async () => {
    const lasso = await lassoWith({ concurrency: 1 });
    await lasso.runner.script({ hang: true });
    await intake(lasso, "work", "A");
    const b = await intake(lasso, "work", "B");
    expect(summaries((await checkNow(lasso)).changes)).toEqual(["started implement"]);
    expect((await detailOf(lasso, b.id)).queue).toBe(1);

    const file = path.join(lasso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^concurrency: 1$/m, "concurrency: 2"));
    expect(summaries((await checkNow(lasso)).changes)).toEqual(["started implement"]);
    expect((await detailOf(lasso, b.id)).display.state).toBe("running");

    // A cap that cannot be read, or a file that has gone, keeps the last one rather than stopping the tick.
    await writeFile(file, "repos: [\n");
    await intake(lasso, "work", "C");
    expect(summaries((await checkNow(lasso)).changes)).toEqual([]);
    await rm(file);
    expect(summaries((await checkNow(lasso)).changes)).toEqual([]);
    await writeFile(file, "concurrency: 0\n");
    expect(summaries((await checkNow(lasso)).changes)).toEqual([]);
    expect(lasso.stdout().match(/config\.reload_failed/g)?.length).toBe(3);
  });

  it("sends an automatic retry to the back of the line when the cap has dropped below the running count", async () => {
    const lasso = await lassoWith({ concurrency: 2 });
    // No stdout: each Session ends interrupted, which Lasso retries while attempts remain.
    await lasso.runner.script({ delayMs: 1200 });
    const a = await intake(lasso, "work", "A");
    const b = await intake(lasso, "work", "B");
    expect(summaries((await checkNow(lasso)).changes)).toEqual(["started implement", "started implement"]);
    const file = path.join(lasso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^concurrency: 2$/m, "concurrency: 1"));

    // One retry takes the freed slot; the other finds the cap full and queues instead of exceeding it.
    const both = await waitFor(async () => {
      const [da, db] = await Promise.all([detailOf(lasso, a.id), detailOf(lasso, b.id)]);
      return da.sessions.length + db.sessions.length === 3 ? [da, db] : null;
    }, "one retry to start");
    await checkNow(lasso);
    const states = (await ledger(lasso)).map((t) => [t.display.state, t.queue]).sort();
    expect(states).toEqual([["queued", 1], ["running", null]]);
    expect(both.every((d) => d.display.state !== "flagged")).toBe(true);
    expect(lasso.stdout()).toMatch(/session\.retry_queued/);
  });

  it("keeps a Ticket to one Session and lets a finished Session's successor start in the same tick's queue order", async () => {
    const lasso = await lassoWith({ concurrency: 1 }, { work: HEADLESS + "  - name: notes\n    prompt: Write NOTES.md.\n    artifact: file NOTES.md\n" });
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], files: { "NOTES.md": "n\n" } });
    const a = await intake(lasso, "work", "A");
    const b = await intake(lasso, "work", "B");
    await checkNow(lasso);
    const done = async (id: string) => (await detailOf(lasso, id)).state === "done";
    await waitFor(async () => ((await done(a.id)) && (await done(b.id)) ? true : null), "A and B to finish");
    // Each end kicks the tick. A's next Stage became runnable after B did: B goes first, then A's notes ahead of B's.
    const calls = await lasso.runner.calls();
    const name = (id: string) => (id === a.id ? "A" : "B");
    expect(calls.map((call) => [name(call.env.LASSO_TICKET!), call.env.LASSO_STAGE])).toEqual([["A", "implement"], ["B", "implement"], ["A", "notes"], ["B", "notes"]]);
  });

  it("records every running Session as shutdown on Ctrl-C; the startup tick fills the slots, the one in line first", async () => {
    const lasso = await lassoWith({ concurrency: 2 });
    await lasso.runner.script({ hang: true });
    const a = await intake(lasso, "work", "A");
    const b = await intake(lasso, "work", "B");
    const c = await intake(lasso, "work", "C");
    await checkNow(lasso);
    expect((await ledger(lasso)).map((t) => [t.id, t.display.state]).sort()).toEqual([[a.id, "running"], [b.id, "running"], [c.id, "queued"]]);
    expect(await lasso.stop()).toBe(0);

    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    // The health check answers before the startup tick is through, so wait for its work to show.
    // C waited in line longest and goes first; the interrupted A and B rejoin the line behind it, A first.
    const states = await waitFor(async () => {
      const rows = (await ledger(again)).map((t) => [t.id, t.display.state, t.display.why]).sort();
      return rows.filter((r) => r[1] === "running").length === 2 ? rows : null;
    }, "the startup tick to fill both slots");
    expect(states).toEqual([[a.id, "running", "implement, run 2"], [b.id, "queued", "1 in line; implement starts when a slot frees"], [c.id, "running", "implement, run 1"]]);
    for (const t of [a, b]) {
      const d = await detailOf(again, t.id);
      expect(d.sessions.find((s) => s.ordinal === 1)).toMatchObject({ running: false, outcome: "interrupted", endedBy: "outcome", endedReason: "shutdown" });
      expect(d.budget.attempts.used).toBe(t === a ? 1 : 0);
      expect(d.flag).toBeNull();
    }
  });
});
