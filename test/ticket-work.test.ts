import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startLassoWithRepos, waitFor, type Lasso } from "./harness.ts";
import { setScenes, type Scene } from "./scenes.ts";
import { TicketWork, TICK_PATIENCE_MS } from "../src/server/ticket-work.ts";
import type { Logger } from "../src/server/log.ts";
import type { TickChange } from "../src/server/tick.ts";
import type { IntakeResult, TicketDetail } from "../src/api/views.ts";

// LASSO-203: one Ticket's hung command must never hold up the others, nor the next tick.

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const change = (ticket: string): TickChange[] => [{ ticket, summary: `${ticket} done` }];
const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TicketWork", () => {
  it("waits a tick 5 seconds on one Ticket's work by default", () => {
    expect(TICK_PATIENCE_MS).toBe(5_000);
  });

  it("returns the work that finished in time and leaves the slow Ticket to finish on its own", async () => {
    let late = 0;
    const work = new TicketWork({ step: "test", limit: Infinity, log: quiet, patienceMs: 100, late: () => late++ });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const started = Date.now();
    const changes = await work.run(["a", "b"], async (t) => {
      if (t === "a") await held;
      return change(t);
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(changes).toEqual(change("b"));
    expect(work.busy("a")).toBe(true);
    expect(work.busy("b")).toBe(false);

    // The next tick skips the Ticket still busy and runs the rest.
    const ran: string[] = [];
    expect(await work.run(["a", "b"], async (t) => (ran.push(t), change(t)))).toEqual(change("b"));
    expect(ran).toEqual(["b"]);

    release();
    await work.settle();
    expect(work.busy("a")).toBe(false);
    expect(late).toBe(1);
  });

  it("calls late only when the late work changed something", async () => {
    let late = 0;
    const work = new TicketWork({ step: "test", limit: Infinity, log: quiet, patienceMs: 20, late: () => late++ });
    await work.run(["a"], async () => (await after(100), []));
    await work.settle();
    expect(late).toBe(0);
  });

  it("runs at most `limit` Tickets' work at once, in Ticket order", async () => {
    const work = new TicketWork({ step: "test", limit: 2, log: quiet });
    let now = 0;
    let most = 0;
    const order: string[] = [];
    const changes = await work.run(["a", "b", "c", "d"], async (t) => {
      order.push(t);
      most = Math.max(most, ++now);
      await after(20);
      now--;
      return change(t);
    });
    expect(most).toBe(2);
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(changes).toEqual(["a", "b", "c", "d"].flatMap(change));
  });

  it("logs a Ticket's failure and carries on with the rest", async () => {
    const errors: unknown[] = [];
    const log = { ...quiet, error: (...args: unknown[]) => errors.push(args) } as unknown as Logger;
    const work = new TicketWork({ step: "test", limit: 1, log });
    const changes = await work.run(["a", "b"], async (t) => {
      if (t === "a") throw new Error("boom");
      return change(t);
    });
    expect(changes).toEqual(change("b"));
    expect(errors).toEqual([["tick.ticket_failed", { step: "test", ticket: "a", error: "boom" }]]);
  });
});

describe("a hung gh on one Ticket's PR", () => {
  const running: Lasso[] = [];
  afterEach(async () => {
    while (running.length) await running.pop()!.destroy();
  });

  const PIPELINE = `stages:
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
`;
  const green = (number: number): Scene => ({ tag: `green-${number}`, number, checks: [{ id: number, name: "test", status: "completed", conclusion: "success", at: "2026-09-27T10:00:00Z" }] });
  const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });

  it("holds up neither the other Ticket's poll nor the next tick, and is followed up once it answers", async () => {
    const { lasso } = await startLassoWithRepos({ app: { pipeline: "loop" } }, {}, { loop: PIPELINE });
    running.push(lasso);
    const intake = (input: string) => lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input, repo: "app", pipeline: "loop" }) });
    const stuck = await intake("Add dark mode");
    const other = await intake("Fix the login form");
    await setScenes(lasso, [[stuck.branch, green(7)], [other.branch, green(8)]]);
    // The stuck Ticket's PR lookup answers only after 8 seconds, well inside gh's 30-second timeout.
    await lasso.tracker.reply({ tool: "gh", match: ["pr view", stuck.branch], stdout: JSON.stringify({ number: 7, url: "https://github.com/owner/app/pull/7", state: "OPEN" }), sleepMs: 8_000, once: true }, true);

    let started = Date.now();
    expect((await checkNow(lasso)).changes).toEqual([{ ticket: other.id, summary: "PR #8 found" }]);
    expect(Date.now() - started).toBeLessThan(7_500);

    // The next tick runs at once, leaving the stuck Ticket alone.
    started = Date.now();
    expect((await checkNow(lasso)).changes).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000);
    const log = () => readFileSync(path.join(lasso.home, "lasso.log"), "utf8");
    expect(log()).toContain(`tick.ticket_busy step=review ticket=${stuck.id}`);

    // Once gh answers, the late poll's change is logged and a tick follows it up.
    const detail = await waitFor(async () => {
      const d = await lasso.api<TicketDetail>(`/api/tickets/${stuck.id}`);
      return d.prs.length ? d : null;
    }, "the stuck Ticket's PR to be found", 15_000);
    expect(detail.prs.map((p) => p.url)).toEqual(["https://github.com/owner/app/pull/7"]);
    await waitFor(async () => (log().includes("trigger=late-work") ? true : null), "the follow-up tick");
    expect(log()).toMatch(/tick\.late_work step=review .*PR #7 found/);
  }, 40_000);
});
