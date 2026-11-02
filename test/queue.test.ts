import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { startLaissoWithRepos, startLaisso, waitFor, claudeFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, TicketView, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: the concurrency cap and the queue behind it, watched through the
// API. The fake claude hangs so Sessions hold their slots until stopped.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const HEADLESS = `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
`;
const HUMAN = `stages:
  - name: grill
    prompt: Interview me.
    human: true
    artifact: file SPEC.md
`;

async function laissoWith(config: LaissoConfig, pipelines: Record<string, string> = { work: HEADLESS }) {
  const repos = Object.fromEntries(Object.keys(pipelines).map((name) => [name, { pipeline: name }]));
  const started = await startLaissoWithRepos(repos, config, pipelines);
  running.push(started.laisso);
  return started.laisso;
}

const intake = (laisso: Laisso, repo: string, title: string) =>
  laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: title, repo, pipeline: repo }) });
const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const ledger = (laisso: Laisso) => laisso.api<TicketView[]>("/api/tickets");
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const stop = async (laisso: Laisso, id: string) => {
  const d = await detailOf(laisso, id);
  await laisso.api(`/api/tickets/${id}/sessions/${d.session!.id}/stop`, { method: "POST" });
};
const summaries = (changes: TickChange[]) => changes.map((c) => c.summary);

describe("the concurrency cap", () => {
  it("starts runnable Tickets oldest first up to the cap, queues the rest with a position, and fills a slot once a Session ends", async () => {
    const laisso = await laissoWith({ concurrency: 2 });
    await laisso.runner.script({ hang: true });
    const a = await intake(laisso, "work", "A");
    const b = await intake(laisso, "work", "B");
    const c = await intake(laisso, "work", "C");
    expect(c.display).toMatchObject({ state: "ready", why: "implement starts on the next tick" });
    expect(c.queue).toBeNull();

    expect(summaries((await checkNow(laisso)).changes)).toEqual(["started implement", "started implement"]);
    const queued = await detailOf(laisso, c.id);
    expect(queued.display).toEqual({ state: "queued", label: "Queued", why: "1 in line; implement starts when a slot frees" });
    expect(queued.queue).toBe(1);
    expect(queued.sessions).toEqual([]);
    // Queued, implement has not started: it may be skipped (LASSO-159).
    expect(queued.triggers.map((x) => x.action)).toEqual(["skip", "abandon"]);
    expect((await detailOf(laisso, a.id)).display.state).toBe("running");
    expect((await detailOf(laisso, b.id)).display.state).toBe("running");

    // A fourth queues behind the third; the Ledger shows Running before Queued, and Queued by position.
    const d = await intake(laisso, "work", "D");
    expect(summaries((await checkNow(laisso)).changes)).toEqual([]);
    expect((await detailOf(laisso, d.id)).queue).toBe(2);
    expect((await ledger(laisso)).map((t) => [t.title, t.display.state, t.queue])).toEqual([
      ["B", "running", null],
      ["A", "running", null],
      ["C", "queued", 1],
      ["D", "queued", 2],
    ]);

    // Stopping A frees a slot: the tick its end kicks starts C, the oldest in line, and D moves up.
    await stop(laisso, a.id);
    await waitFor(async () => ((await detailOf(laisso, c.id)).display.state === "running" ? true : null), "C to start");
    expect((await detailOf(laisso, d.id)).display).toMatchObject({ state: "queued", why: "1 in line; implement starts when a slot frees" });
    expect((await detailOf(laisso, a.id)).display.state).toBe("flagged");
    // A may have been stopped before its fake claude booted; B and C record their launch either way.
    const launched = async () => (await laisso.runner.calls()).map((call) => call.env.LAISSO_TICKET);
    await waitFor(async () => { const ids = await launched(); return ids.includes(b.id) && ids.includes(c.id) ? true : null; }, "B and C to launch");
  });

  it("does not count a terminal Session as a slot", async () => {
    const laisso = await laissoWith({ concurrency: 1 }, { work: HEADLESS, talk: HUMAN });
    await laisso.runner.script({ hang: true });
    const talk = await intake(laisso, "talk", "Talk");
    const opened = await laisso.api<TicketDetail>(`/api/tickets/${talk.id}/terminal`, { method: "POST" });
    expect(opened.session).toMatchObject({ mode: "terminal", running: true });
    const work = await intake(laisso, "work", "Work");
    expect(summaries((await checkNow(laisso)).changes)).toEqual(["started implement"]);
    expect((await detailOf(laisso, work.id)).display.state).toBe("running");
    expect((await detailOf(laisso, talk.id)).display.state).toBe("needs_you");
  });

  it("reads a changed cap from config.yaml on the next tick", async () => {
    const laisso = await laissoWith({ concurrency: 1 });
    await laisso.runner.script({ hang: true });
    await intake(laisso, "work", "A");
    const b = await intake(laisso, "work", "B");
    expect(summaries((await checkNow(laisso)).changes)).toEqual(["started implement"]);
    expect((await detailOf(laisso, b.id)).queue).toBe(1);

    const file = path.join(laisso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^concurrency: 1$/m, "concurrency: 2"));
    expect(summaries((await checkNow(laisso)).changes)).toEqual(["started implement"]);
    expect((await detailOf(laisso, b.id)).display.state).toBe("running");

    // A cap that cannot be read, or a file that has gone, keeps the last one rather than stopping the tick.
    await writeFile(file, "repos: [\n");
    await intake(laisso, "work", "C");
    expect(summaries((await checkNow(laisso)).changes)).toEqual([]);
    await rm(file);
    expect(summaries((await checkNow(laisso)).changes)).toEqual([]);
    await writeFile(file, "concurrency: 0\n");
    expect(summaries((await checkNow(laisso)).changes)).toEqual([]);
    expect(laisso.stdout().match(/config\.reload_failed/g)?.length).toBe(3);
  });

  it("sends an automatic retry to the back of the line when the cap has dropped below the running count", async () => {
    const laisso = await laissoWith({ concurrency: 2 });
    // No stdout: each Session ends interrupted, which Laisso retries while attempts remain.
    await laisso.runner.script({ delayMs: 1200 });
    const a = await intake(laisso, "work", "A");
    const b = await intake(laisso, "work", "B");
    expect(summaries((await checkNow(laisso)).changes)).toEqual(["started implement", "started implement"]);
    const file = path.join(laisso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^concurrency: 2$/m, "concurrency: 1"));

    // One retry takes the freed slot; the other finds the cap full and queues instead of exceeding it.
    const both = await waitFor(async () => {
      const [da, db] = await Promise.all([detailOf(laisso, a.id), detailOf(laisso, b.id)]);
      return da.sessions.length + db.sessions.length === 3 ? [da, db] : null;
    }, "one retry to start");
    await checkNow(laisso);
    const states = (await ledger(laisso)).map((t) => [t.display.state, t.queue]).sort();
    expect(states).toEqual([["queued", 1], ["running", null]]);
    expect(both.every((d) => d.display.state !== "flagged")).toBe(true);
    expect(laisso.stdout()).toMatch(/session\.retry_queued/);
  });

  it("keeps a Ticket to one Session and lets a finished Session's successor start in the same tick's queue order", async () => {
    const laisso = await laissoWith({ concurrency: 1 }, { work: HEADLESS + "  - name: notes\n    prompt: Write NOTES.md.\n    artifact: file NOTES.md\n" });
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], files: { "NOTES.md": "n\n" } });
    const a = await intake(laisso, "work", "A");
    const b = await intake(laisso, "work", "B");
    await checkNow(laisso);
    const done = async (id: string) => (await detailOf(laisso, id)).state === "done";
    await waitFor(async () => ((await done(a.id)) && (await done(b.id)) ? true : null), "A and B to finish");
    // Each end kicks the tick. A's next Stage became runnable after B did: B goes first, then A's notes ahead of B's.
    const calls = await laisso.runner.calls();
    const name = (id: string) => (id === a.id ? "A" : "B");
    expect(calls.map((call) => [name(call.env.LAISSO_TICKET!), call.env.LAISSO_STAGE])).toEqual([["A", "implement"], ["B", "implement"], ["A", "notes"], ["B", "notes"]]);
  });

  it("records every running Session as shutdown on Ctrl-C; the startup tick fills the slots, the one in line first", async () => {
    const laisso = await laissoWith({ concurrency: 2 });
    await laisso.runner.script({ hang: true });
    const a = await intake(laisso, "work", "A");
    const b = await intake(laisso, "work", "B");
    const c = await intake(laisso, "work", "C");
    await checkNow(laisso);
    expect((await ledger(laisso)).map((t) => [t.id, t.display.state]).sort()).toEqual([[a.id, "running"], [b.id, "running"], [c.id, "queued"]]);
    expect(await laisso.stop()).toBe(0);

    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
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
