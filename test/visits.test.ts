import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLaissoWithRepos, startLaisso, runCli, waitFor, claudeFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, TicketView, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";
import { PR_URL, setScene, sceneFile, swapTo, marker, type Scene } from "./scenes.ts";

// Visits (LASSO-189): each arrival at a Stage, watched through the API and the
// rows the store holds. With no Routes yet a Ticket visits each Stage once, so
// an earlier lap is written into the store the way a Route will leave one.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: grill
    prompt: Interview me.
    human: true
  - name: implement
    prompt: Do the work.
    artifact:
      action: grep-file
      with: { file: CHANGELOG.md, pattern: dark }
  - name: ship
    prompt: Ship it.
    human: true
`;

const GREP: LaissoConfig["actions"] = {
  "grep-file": { params: ["file", "pattern"], run: 'if grep -q "$LAISSO_PATTERN" "$LAISSO_FILE" 2>/dev/null; then echo "found"; else echo "no $LAISSO_PATTERN in $LAISSO_FILE"; exit 1; fi' },
};

const REVIEW = `stages:
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
    budget: { rounds: 2 }
`;

async function laissoWith(pipeline: string, config: LaissoConfig = {}) {
  const { laisso } = await startLaissoWithRepos({ app: { pipeline: "work" } }, { actions: GREP, ...config }, { work: pipeline });
  running.push(laisso);
  return laisso;
}

const add = (laisso: Laisso, input = "Add dark mode") => laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input, repo: "app", pipeline: "work" }) });
const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (laisso: Laisso, id: string, lever: string, body: object = {}) => laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const flagged = (laisso: Laisso, id: string) => waitFor(async () => { const d = await detailOf(laisso, id); return d.flag ? d : null; }, "the Flag");

interface Visit {
  id: number;
  stage: string;
  number: number;
  left_at: string | null;
  arrived_by: string;
  from_visit: number | null;
  check_result: string | null;
  skipped_at: string | null;
}

/** The store, opened beside the running server as a person poking at it would. */
function withStore<T>(laisso: Laisso, use: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(laisso.home, "laisso.db"));
  try {
    return use(db);
  } finally {
    db.close();
  }
}

const visitsOf = (laisso: Laisso, ticket: string) =>
  withStore(laisso, (db) => db.prepare(`SELECT id, stage, number, left_at, arrived_by, from_visit, check_result, skipped_at FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as Visit[]);
const sessionVisits = (laisso: Laisso, ticket: string) =>
  withStore(laisso, (db) => db.prepare(`SELECT stage, ordinal, visit FROM sessions WHERE ticket = ? ORDER BY started_at, ordinal`).all(ticket) as Array<{ stage: string; ordinal: number; visit: number }>);

/**
 * An earlier lap of the Stage the Ticket is on: a left Visit, numbered 1, holding ended Sessions
 * (with these Rounds), before the current Visit, which becomes number 2 arrived by Route.
 */
function earlierLap(laisso: Laisso, ticket: string, stage: string, rounds: Array<number | null>): void {
  withStore(laisso, (db) => {
    const current = db.prepare(`SELECT id FROM visits WHERE ticket = ? AND left_at IS NULL`).get(ticket) as { id: number };
    db.prepare(`UPDATE visits SET number = 2, arrived_by = 'route', route = 'again', chosen_by = 'agent' WHERE id = ?`).run(current.id);
    const lap = Number(db.prepare(`INSERT INTO visits (ticket, stage, number, version, arrived_at, left_at, arrived_by) VALUES (?, ?, 1, 1, '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'intake')`).run(ticket, stage).lastInsertRowid);
    db.prepare(`UPDATE visits SET from_visit = ? WHERE id = ?`).run(lap, current.id);
    const insert = db.prepare(`INSERT INTO sessions (id, ticket, stage, ordinal, visit, round, stage_snapshot, mode, started_by, started_at, ended_at, ended_by, outcome)
                               VALUES (?, ?, ?, ?, ?, ?, '{}', 'headless', 'auto', ?, ?, 'outcome', 'failed')`);
    rounds.forEach((round, i) => insert.run(`lap-${i}`, ticket, stage, i + 1, lap, round, `2026-10-01T09:0${i}:00Z`, `2026-10-01T09:0${i}:30Z`));
  });
}

describe("Visits", () => {
  it("opens one at Intake and at each step forward, and keeps the Stage's Sessions, check and Skip on it", async () => {
    const laisso = await laissoWith(PIPELINE);
    const ticket = await add(laisso);
    expect(visitsOf(laisso, ticket.id)).toEqual([expect.objectContaining({ stage: "grill", number: 1, left_at: null, arrived_by: "intake", from_visit: null })]);

    await pull(laisso, ticket.id, "done", { override: true });
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(laisso);
    const missing = await flagged(laisso, ticket.id);
    expect(missing.flag!.reason).toBe("artifact.missing");
    expect(missing.check).toMatchObject({ action: "grep-file", result: "not_met" });
    const skipped = await pull(laisso, ticket.id, "skip");
    expect(skipped.stage.name).toBe("ship");

    const [grill, implement, ship] = visitsOf(laisso, ticket.id);
    expect(grill).toMatchObject({ stage: "grill", left_at: expect.any(String), skipped_at: null });
    expect(implement).toMatchObject({ stage: "implement", number: 1, left_at: expect.any(String), arrived_by: "walk", from_visit: grill!.id, skipped_at: expect.any(String) });
    expect(JSON.parse(implement!.check_result!)).toMatchObject({ action: "grep-file", result: "not_met", line: "no dark in CHANGELOG.md" });
    expect(ship).toMatchObject({ stage: "ship", number: 1, left_at: null, arrived_by: "walk", from_visit: implement!.id, check_result: null, skipped_at: null });
    expect(sessionVisits(laisso, ticket.id)).toEqual([{ stage: "implement", ordinal: 1, visit: implement!.id }]);
    expect(skipped.stages.map((s) => [s.name, s.skippedAt])).toEqual([["grill", null], ["implement", implement!.skipped_at], ["ship", null]]);
  });

  it("counts attempts in the current Visit only, so an earlier lap's tries do not refuse the next", async () => {
    const laisso = await laissoWith(PIPELINE.replace("    prompt: Do the work.\n", "    prompt: Do the work.\n    budget: { attempts: 1 }\n"));
    const ticket = await add(laisso);
    await pull(laisso, ticket.id, "done", { override: true });
    earlierLap(laisso, ticket.id, "implement", [null]);

    const before = await detailOf(laisso, ticket.id);
    expect(before.budget.attempts).toEqual({ used: 0, limit: 1, source: "pipeline" });
    expect(before.display.state).toBe("ready");
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    const ran = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.session?.running ? d : null; }, "the Session to start");
    expect(ran.flag).toBeNull();
    expect(ran.session).toMatchObject({ stage: "implement", ordinal: 2 });
    expect(ran.budget.attempts).toEqual({ used: 1, limit: 1, source: "pipeline" });
    const current = visitsOf(laisso, ticket.id).find((v) => v.left_at === null)!;
    expect(sessionVisits(laisso, ticket.id).map((s) => s.visit === current.id)).toEqual([false, true]);
  });

  it("caps Rounds per Visit, and numbers a new Visit's Rounds on from the Stage's highest", async () => {
    const laisso = await laissoWith(REVIEW);
    const ticket = await add(laisso);
    // The earlier lap spent both Rounds the Budget allows.
    earlierLap(laisso, ticket.id, "review", [1, 2]);
    expect((await detailOf(laisso, ticket.id)).budget.rounds).toEqual({ used: 0, limit: 2, source: "pipeline" });

    const asked: Scene = { tag: "asked", checks: [], comments: [{ id: 201, author: "bob", body: "Rename this.", at: "2026-10-02T10:00:00Z" }] };
    const replied: Scene = { ...asked, tag: "replied", comments: [...asked.comments!, { id: 202, author: "laisso-bot", body: `Renamed.\n${marker(ticket.id, 3)}`, at: "2026-10-02T10:05:00Z" }] };
    await setScene(laisso, ticket.branch, asked);
    await laisso.runner.script({ stdout: claudeFixture("success.json"), commands: swapTo(laisso, await sceneFile(laisso, ticket.branch, "replied", replied)) });
    const tick = await checkNow(laisso);
    expect(tick.changes.map((c) => c.summary)).toContain("started review Round 3");
    const d = await waitFor(async () => { const x = await detailOf(laisso, ticket.id); return x.session && !x.session.running ? x : null; }, "the Round to end");
    expect(d.flag).toBeNull();
    expect(d.session).toMatchObject({ round: 3, outcome: "succeeded" });
    expect(d.budget.rounds).toEqual({ used: 1, limit: 2, source: "pipeline" });
    expect(d.prs.map((p) => p.url)).toEqual([PR_URL]);
  });

  it("never re-runs an earlier lap's interrupted Round on a new Visit", async () => {
    const laisso = await laissoWith(REVIEW);
    const ticket = await add(laisso);
    earlierLap(laisso, ticket.id, "review", [1, 2]);
    // The lap's last Round was cut off; this Visit walked in, so it waits for new Feedback rather than re-running it.
    withStore(laisso, (db) => {
      db.prepare(`UPDATE sessions SET outcome = 'interrupted' WHERE id = 'lap-1'`).run();
      db.prepare(`UPDATE visits SET arrived_by = 'walk', route = NULL, chosen_by = NULL WHERE ticket = ? AND left_at IS NULL`).run(ticket.id);
    });
    await setScene(laisso, ticket.branch, { tag: "green", checks: [] });
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    expect((await checkNow(laisso)).changes.map((c) => c.summary)).toEqual(["PR #7 found"]);
    const d = await detailOf(laisso, ticket.id);
    expect(d.display.state).toBe("quiet");
    expect(await laisso.runner.calls()).toEqual([]);
  });
});

describe("the Visits migration", () => {
  /** Put the store back as the Laisso before Visits kept it: checks and Skips in JSON maps on the Ticket, keyed by Stage. */
  function downgrade(laisso: Laisso): void {
    withStore(laisso, (db) => {
      db.exec(`
        ALTER TABLE tickets ADD COLUMN artifact_checks TEXT;
        ALTER TABLE tickets ADD COLUMN skipped_stages TEXT;
        UPDATE tickets SET
          artifact_checks = NULLIF((SELECT json_group_object(stage, json(check_result)) FROM visits WHERE ticket = tickets.id AND check_result IS NOT NULL), '{}'),
          skipped_stages = NULLIF((SELECT json_group_object(stage, skipped_at) FROM visits WHERE ticket = tickets.id AND skipped_at IS NOT NULL), '{}');
        DROP TABLE upgrades;
        DROP INDEX sessions_visit;
        ALTER TABLE sessions DROP COLUMN visit;
        DROP TABLE visits;
        ALTER TABLE tickets DROP COLUMN budget_routes;
      `);
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 4));
    });
  }

  it("backfills active, Done and Abandoned Tickets so the dashboard and laisso status read the same after", async () => {
    const laisso = await laissoWith(PIPELINE);
    // Active and Flagged at implement, its grill skipped and its check not met.
    const active = await add(laisso, "Add dark mode");
    await pull(laisso, active.id, "skip");
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    await checkNow(laisso);
    await flagged(laisso, active.id);
    // Done by skipping every Stage; Abandoned at grill.
    const done = await add(laisso, "Fix the footer");
    for (let i = 0; i < 3; i++) await pull(laisso, done.id, "skip");
    const abandoned = await add(laisso, "Drop the banner");
    await pull(laisso, abandoned.id, "abandon");

    const ids = [active.id, done.id, abandoned.id];
    // The backfill dates each Visit from its Sessions, else the Ticket's creation, so only those times may differ.
    const undated = (d: TicketDetail) => ({ ...d, visits: d.visits.map(({ arrivedAt: _a, leftAt, ...v }) => ({ ...v, left: leftAt !== null })) });
    const read = async (on: Laisso) => ({
      details: await Promise.all(ids.map(async (id) => undated(await detailOf(on, id)))),
      ledger: await on.api<TicketView[]>("/api/tickets?all=1"),
      status: await Promise.all(ids.map(async (id) => (await runCli(["status", id], on)).stdout)),
    });
    const before = await read(laisso);
    expect(before.details.map((d) => [d.state, d.stage.name, d.stages.map((s) => s.skippedAt !== null)])).toEqual([
      ["active", "implement", [true, false, false]],
      ["done", "ship", [true, true, true]],
      ["abandoned", "grill", [false, false, false]],
    ]);
    expect(before.details[0]!.check).toMatchObject({ result: "not_met" });

    await laisso.stop();
    downgrade(laisso);
    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    expect(await read(again)).toEqual(before);
    expect(visitsOf(again, active.id).map((v) => [v.stage, v.arrived_by, v.left_at === null])).toEqual([["grill", "intake", false], ["implement", "walk", true]]);
    expect(visitsOf(again, done.id).map((v) => [v.stage, v.left_at === null])).toEqual([["grill", false], ["implement", false], ["ship", true]]);
    expect(visitsOf(again, abandoned.id).map((v) => [v.stage, v.arrived_by, v.left_at])).toEqual([["grill", "intake", null]]);
  });
});
