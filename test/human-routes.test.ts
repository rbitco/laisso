import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLassoWithRepos, waitFor, claudeFixture, type Lasso } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";

// Routes from and to human Stages (LASSO-198): Mark done on a human or taken-over Stage is a menu of "Done, walk
// forward", "Done via <route> -> <target>" and Send to Stage; a Route chosen there is a human's and never counts,
// skips the artifact check, and still holds before it when a hold says so. A Route that lands on a human Stage names
// itself in the notification and reaches the terminal's prompt. Fakes on PATH stand in for the Runner, Terminal.app
// and notifications.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

// review is a human Stage that can send the work back (fix, Budget 0: no agent, Action or check may take it, a human
// still may) or on past polish (ahead, which holds before it is taken).
const PIPELINE = `stages:
  - name: implement
    prompt: Do the work.
  - name: review
    prompt: Review it by hand.
    human: true
    artifact: file NOTES.md
    routes:
      fix: { to: implement, append: Fix what review found., budget: 0 }
      ahead: { to: ship, advance: false }
  - name: polish
    prompt: Polish.
    human: true
  - name: ship
    prompt: Ship it.
    human: true
`;

async function lassoWith(pipeline = PIPELINE) {
  const { lasso } = await startLassoWithRepos({ app: { pipeline: "work" } }, {}, { work: pipeline });
  running.push(lasso);
  await lasso.runner.script({ stdout: claudeFixture("success.json") });
  return lasso;
}

const json = (body: unknown) => JSON.stringify(body);
const add = (lasso: Lasso) => lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input: "Add dark mode", repo: "app", pipeline: "work" }) });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const pull = (lasso: Lasso, id: string, lever: string, body: object = {}) => lasso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: json(body) });
const refusal = async (lasso: Lasso, id: string, body: object) => {
  const res = await lasso.api<Response>(`/api/tickets/${id}/done`, { method: "POST", body: json(body), raw: true });
  return { status: res.status, body: await res.json() };
};
/** Tick until the Ticket rests at the Stage, with nothing running. */
const restsAt = (lasso: Lasso, id: string, stage: string) =>
  waitFor(async () => {
    await lasso.api("/api/check-now", { method: "POST" });
    const d = await detailOf(lasso, id);
    return d.stage.name === stage && !d.sessions.some((s) => s.running) ? d : null;
  }, `the Ticket to rest at ${stage}`, 20_000);
const bodies = async (lasso: Lasso) => (await lasso.notifications()).map((n) => n.body);

function visitsOf(lasso: Lasso, ticket: string) {
  const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
  try {
    return db.prepare(`SELECT stage, arrived_by, route, chosen_by, text, note, picked_route, picked_by FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as Array<Record<string, string | null>>;
  } finally {
    db.close();
  }
}

describe("the Mark done menu on a human Stage", () => {
  it("lists the Stage's Routes, and taking one moves the Ticket as a human's choice that never counts nor checks the artifact", async () => {
    const lasso = await lassoWith();
    const ticket = await add(lasso);
    const atReview = await restsAt(lasso, ticket.id, "review");
    expect(atReview.markDone).toEqual({
      routes: [
        { name: "fix", to: "implement", text: "Fix what review found.", replaces: false },
        { name: "ahead", to: "ship", text: null, replaces: false },
      ],
      suggested: null,
    });

    // Only Done, walk forward warns about the missing NOTES.md.
    expect(await refusal(lasso, ticket.id, {})).toMatchObject({ status: 409, body: { artifact: "file NOTES.md", override: true } });
    // fix allows no lap to an agent, Action or check; a human takes it anyway, with a note for implement.
    const routed = await pull(lasso, ticket.id, "done", { route: "fix", note: "  Handle the empty list too. " });
    expect(routed.stage.name).toBe("implement");
    expect(routed.flag).toBeNull();
    expect(visitsOf(lasso, ticket.id).at(-1)).toMatchObject({ stage: "implement", arrived_by: "route", route: "fix", chosen_by: "human", text: "Fix what review found.", note: "Handle the empty list too." });
    // The arc shows the lap uncounted, and its Budget unspent by it.
    const back = await restsAt(lasso, ticket.id, "review");
    expect(back.arcs.find((a) => a.route === "fix")).toMatchObject({ kind: "route", budget: { used: 0, limit: 0 } });
    expect((await lasso.runner.calls()).at(-1)!.argv.join("\n")).toContain("Do the work.\n\nFix what review found.\n\nLasso sent this Ticket here by Route fix, chosen by a human, with this note: Handle the empty list too.");
  });

  it("holds before a Route that says advance: false, and Start takes it", async () => {
    const lasso = await lassoWith();
    const ticket = await add(lasso);
    await restsAt(lasso, ticket.id, "review");
    const held = await pull(lasso, ticket.id, "done", { route: "ahead" });
    expect(held).toMatchObject({ stage: { name: "review" }, display: { state: "holding", why: "Start ship via ahead when ready" }, markDone: null });
    expect(visitsOf(lasso, ticket.id).at(-1)).toMatchObject({ stage: "review", picked_route: "ahead", picked_by: "human" });
    await waitFor(async () => ((await bodies(lasso)).includes("review finished; Start ship via ahead when ready") ? true : null), "the gate notification");

    const started = await pull(lasso, ticket.id, "start");
    expect(started.stage.name).toBe("ship");
    expect(visitsOf(lasso, ticket.id).at(-1)).toMatchObject({ stage: "ship", arrived_by: "route", route: "ahead", chosen_by: "human" });
  });

  it("holds after any choice on a human Stage that says advance: false", async () => {
    const lasso = await lassoWith(PIPELINE.replace("    artifact: file NOTES.md\n", "    advance: false\n"));
    const ticket = await add(lasso);
    await restsAt(lasso, ticket.id, "review");
    const held = await pull(lasso, ticket.id, "done", { route: "fix" });
    expect(held).toMatchObject({ stage: { name: "review" }, display: { state: "holding", why: "Start implement via fix when ready" } });
    expect(visitsOf(lasso, ticket.id).map((v) => v.stage)).toEqual(["implement", "review"]);
  });

  it("refuses a Route the Stage does not declare, and walks forward with none", async () => {
    const lasso = await lassoWith();
    const ticket = await add(lasso);
    await restsAt(lasso, ticket.id, "review");
    expect(await refusal(lasso, ticket.id, { route: "polish" })).toEqual({ status: 400, body: { error: "no Route named polish on Stage review; it has fix, ahead" } });
    expect(await refusal(lasso, ticket.id, { route: 3 })).toMatchObject({ status: 400 });
    const walked = await pull(lasso, ticket.id, "done", { override: true });
    expect(walked.stage.name).toBe("polish");
    // polish declares no Routes: its menu offers only walking forward and Send to Stage.
    expect(walked.markDone).toEqual({ routes: [], suggested: null });
  });
});

describe("a Route that lands on a human Stage", () => {
  const LANDING = `stages:
  - name: implement
    prompt: Do the work.
    agentRoutes: true
    routes:
      ask: { to: decide, append: The agent needs a decision from you. }
  - name: build
    prompt: Build it.
  - name: decide
    prompt: Decide what to do.
    human: true
`;

  it("names the Route and its source in the notification, and opens the terminal on the amended prompt", async () => {
    const lasso = await lassoWith(LANDING);
    // The agent's Session runs `lasso route` through the CLI shim, with its LASSO_SESSION.
    const bin = path.join(import.meta.dirname, "..", "bin", "lasso.js");
    writeFileSync(path.join(lasso.pathDir, "lasso"), `#!/bin/sh\nexec '${process.execPath}' '${bin}' --port ${lasso.port} "$@"\n`, { mode: 0o755 });
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["lasso", "route", "ask", "--note", "Which table should it use?"]] });
    const ticket = await add(lasso);
    await restsAt(lasso, ticket.id, "decide");
    await waitFor(async () => ((await bodies(lasso)).includes("decide needs you: Route ask from implement") ? true : null), "the human Stage notification");
    expect(visitsOf(lasso, ticket.id).map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["decide", "route"]]);

    await pull(lasso, ticket.id, "terminal");
    const launcher = readFileSync((await lasso.terminals()).at(-1)!.launcher!, "utf8");
    expect(launcher).toContain("Decide what to do.\n\nThe agent needs a decision from you.\n\nLasso sent this Ticket here by Route ask, chosen by the agent, with this note: Which table should it use?");
  });

  it("keeps the plain notification for a walk forward", async () => {
    const lasso = await lassoWith(LANDING.replace("    agentRoutes: true\n", ""));
    const ticket = await add(lasso);
    await restsAt(lasso, ticket.id, "decide");
    await waitFor(async () => ((await bodies(lasso)).includes("decide needs you") ? true : null), "the human Stage notification");
  });
});

describe("the Mark done menu on a taken-over Stage", () => {
  it("offers the Stage's Routes as on a human Stage, and takes one as a human's choice", async () => {
    const lasso = await lassoWith(`stages:
  - name: implement
    prompt: Do the work.
    routes:
      again: { to: implement, append: Once more. }
  - name: ship
    prompt: Ship it.
    human: true
`);
    await lasso.runner.script({ hang: true });
    const ticket = await add(lasso);
    await waitFor(async () => { await lasso.api("/api/check-now", { method: "POST" }); return (await detailOf(lasso, ticket.id)).session?.running ? true : null; }, "implement to run");
    expect((await detailOf(lasso, ticket.id)).markDone).toBeNull();
    const taken = await pull(lasso, ticket.id, "takeover");
    expect(taken.markDone).toEqual({ routes: [{ name: "again", to: "implement", text: "Once more.", replaces: false }], suggested: null });
    await lasso.runner.script({ stdout: claudeFixture("success.json") });
    const routed = await pull(lasso, ticket.id, "done", { route: "again" });
    expect(routed.stage.name).toBe("implement");
    expect(visitsOf(lasso, ticket.id).at(-1)).toMatchObject({ arrived_by: "route", route: "again", chosen_by: "human" });
  });
});
