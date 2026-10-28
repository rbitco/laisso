import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLassoWithRepos, waitFor, claudeFixture, type Lasso, type LassoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { UpgradePlan } from "../src/session/upgrade.ts";
import type { TickChange } from "../src/server/tick.ts";

// Version upgrades and Routes (LASSO-201): a human upgrades a Ticket to its Pipeline as the file stands; the Visit
// continues on a Stage that kept its name, Route counts carry by Stage and Route name, and a pending or held pick
// follows its Route's new to:, or is warned about, dropped and recorded when its Route or target is gone.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const BIN = path.join(import.meta.dirname, "..", "bin", "lasso.js");

// The gate's fix Route goes to polish, a human Stage, so a Ticket that takes it rests there on a routed Visit.
const ROUTED = `stages:
  - name: implement
    prompt: Do the work.
  - action: gate
    routes:
      fix: { to: polish, append: Polish the lint. }
  - name: polish
    prompt: Polish.
    human: true
  - name: ship
    prompt: Ship it.
    human: true
`;

// The gate's back Route holds (advance: false), so a Ticket that picks it waits at the gate for Start.
const HELD = `stages:
  - name: implement
    prompt: Do the work.
  - action: gate
    routes:
      back: { to: implement, append: Fix what the gate found., advance: false }
  - name: polish
    prompt: Polish.
    human: true
`;

const ACTIONS: LassoConfig["actions"] = { gate: { run: 'sh "$(dirname "$(command -v lasso)")/gate.sh"' } };

async function lassoWith(pipeline: string) {
  const { lasso } = await startLassoWithRepos({ app: { pipeline: "work" } }, { actions: ACTIONS }, { work: pipeline });
  running.push(lasso);
  await writeFile(path.join(lasso.pathDir, "lasso"), `#!/bin/sh\nexec '${process.execPath}' '${BIN}' --port ${lasso.port} "$@"\n`, { mode: 0o755 });
  await lasso.runner.script({ stdout: claudeFixture("success.json") });
  return lasso;
}

/** gate.sh: run n of the gate does the n-th line; past the last it does nothing. */
const gate = (lasso: Lasso, ...runs: string[]) =>
  writeFile(
    path.join(lasso.pathDir, "gate.sh"),
    `dir=$(dirname "$(command -v lasso)")\nn=$(( $(cat "$dir/gate-count" 2>/dev/null || echo 0) + 1 ))\necho $n > "$dir/gate-count"\ncase $n in\n${runs.map((r, i) => `${i + 1}) ${r} ;;`).join("\n")}\nesac\n`,
  );
/** Edit the Pipeline file, as a human would between Intake and the upgrade. */
const edit = (lasso: Lasso, yaml: string) => writeFile(path.join(lasso.home, "pipelines", "work.yaml"), yaml);

const json = (body: unknown) => JSON.stringify(body);
const add = (lasso: Lasso) => lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input: "Add dark mode", repo: "app", pipeline: "work" }) });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const planOf = (lasso: Lasso, id: string) => lasso.api<UpgradePlan>(`/api/tickets/${id}/upgrade`);
const upgrade = (lasso: Lasso, id: string, body: Record<string, unknown> = {}) => lasso.api<TicketDetail>(`/api/tickets/${id}/upgrade`, { method: "POST", body: json(body) });
const refusal = async (lasso: Lasso, id: string, body: Record<string, unknown> = {}) => {
  const res = await lasso.api<Response>(`/api/tickets/${id}/upgrade`, { method: "POST", body: json(body), raw: true });
  return { status: res.status, error: ((await res.json()) as { error: string }).error };
};
const send = (lasso: Lasso, id: string, stage: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/send`, { method: "POST", body: json({ stage }) });
const start = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/start`, { method: "POST", body: "{}" });
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });

/** Tick until the Ticket rests: at a human Stage, holding, or Flagged, with nothing running. */
const rested = (lasso: Lasso, id: string) =>
  waitFor(async () => {
    await checkNow(lasso);
    const d = await detailOf(lasso, id);
    return !d.sessions.some((s) => s.running) && (d.flag || d.display.state === "holding" || d.display.state === "needs_you") ? d : null;
  }, "the Ticket to rest", 20_000);

interface Visit {
  id: number;
  stage: string;
  version: number | null;
  arrived_by: string;
  from_visit: number | null;
  route: string | null;
  text: string | null;
  note: string | null;
  left_at: string | null;
  picked_route: string | null;
  skipped_at: string | null;
}

function visitsOf(lasso: Lasso, ticket: string): Visit[] {
  const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
  try {
    return db.prepare(`SELECT id, stage, version, arrived_by, from_visit, route, text, note, left_at, picked_route, skipped_at FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as Visit[];
  } finally {
    db.close();
  }
}

function upgradesOf(lasso: Lasso, ticket: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
  try {
    return db.prepare(`SELECT from_version, to_version, visit, landed, dropped_route, dropped_to, dropped_note, dropped_by FROM upgrades WHERE ticket = ? ORDER BY id`).all(ticket) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("upgrading a Ticket whose Stage keeps its name", () => {
  it("continues the same Visit, its Route text and note included, and counts the Route under its new budget:", async () => {
    const lasso = await lassoWith(ROUTED);
    await gate(lasso, 'lasso route fix --note "lint"');
    const ticket = await add(lasso);
    const before = await rested(lasso, ticket.id);
    expect(before.stage.name).toBe("polish");
    const visits = visitsOf(lasso, ticket.id);
    expect(visits.at(-1)).toMatchObject({ stage: "polish", version: 1, arrived_by: "route", route: "fix", text: "Polish the lint.", note: "lint", left_at: null });

    // Nothing to upgrade to while the file is unchanged.
    expect(await refusal(lasso, ticket.id)).toEqual({ status: 400, error: `Ticket ${ticket.reference ?? ticket.id} already runs work v1, the Pipeline as it stands` });

    await edit(lasso, ROUTED.replace("prompt: Polish.", "prompt: Polish carefully.").replace("append: Polish the lint. }", "append: Polish the lint., budget: 5 }"));
    expect(await planOf(lasso, ticket.id)).toEqual({ from: 1, to: 2, fresh: true, stages: ["implement", "gate", "polish", "ship"], stage: "polish", keeps: true, pick: null, unavailable: null });
    const after = await upgrade(lasso, ticket.id);
    expect(after).toMatchObject({ pipelineVersion: 2, pipelineDrift: "same", stage: { name: "polish" }, display: { state: "needs_you" } });
    // Visit rows are never rewritten: the same Visit goes on, still saying the Version it arrived under.
    expect(visitsOf(lasso, ticket.id)).toEqual(visits);
    expect(upgradesOf(lasso, ticket.id)).toEqual([{ from_version: 1, to_version: 2, visit: visits.at(-1)!.id, landed: null, dropped_route: null, dropped_to: null, dropped_note: null, dropped_by: null }]);
    // The count carries by Stage and Route name, against the new Version's budget.
    expect(after.arcs.map((a) => [a.key, a.budget])).toEqual([["route:gate:fix", { used: 1, limit: 5 }]]);
    expect(after.upgrades).toEqual([{ key: expect.stringMatching(/^upgrade:\d+$/), at: expect.any(String), from: 1, to: 2, stage: "polish", landed: false, dropped: null, earlier: [] }]);
  });

  it("carries Route counts by Stage and Route name, so a renamed Route starts at 0", async () => {
    const lasso = await lassoWith(ROUTED);
    // v2 keeps fix, now capped at 1, and adds mend, also capped at 1: the gate's second run takes mend, its third picks fix.
    await gate(lasso, "lasso route fix", "lasso route mend", "lasso route fix");
    const ticket = await add(lasso);
    expect((await rested(lasso, ticket.id)).stage.name).toBe("polish");
    await edit(lasso, ROUTED.replace("fix: { to: polish, append: Polish the lint. }", "fix: { to: polish, budget: 1 }\n      mend: { to: polish, budget: 1 }"));
    await upgrade(lasso, ticket.id);

    await send(lasso, ticket.id, "gate");
    const mended = await rested(lasso, ticket.id);
    expect(mended).toMatchObject({ stage: { name: "polish" }, flag: null, visit: { arrivedBy: "route", route: "mend" } });
    await send(lasso, ticket.id, "gate");
    const spent = await rested(lasso, ticket.id);
    expect(spent).toMatchObject({ stage: { name: "gate" }, flag: { reason: "budget.routes", detail: "Route fix to polish: 1 of 1 used; Extend to take it" } });
  });

  it("is never refused over Routes, but waits for a running Session to end", async () => {
    const lasso = await lassoWith(ROUTED);
    await lasso.runner.script({ hang: true });
    const ticket = await add(lasso);
    await waitFor(async () => {
      await checkNow(lasso);
      return (await detailOf(lasso, ticket.id)).sessions.some((s) => s.running) ? true : null;
    }, "implement to run");
    await edit(lasso, ROUTED.replace("prompt: Do the work.", "prompt: Do the work well."));
    expect((await planOf(lasso, ticket.id)).unavailable).toBe("implement has a Session running; upgrade once it ends");
    expect(await refusal(lasso, ticket.id)).toEqual({ status: 400, error: "implement has a Session running; upgrade once it ends" });
    expect(upgradesOf(lasso, ticket.id)).toEqual([]);
  });
});

describe("upgrading a Ticket whose Stage is gone", () => {
  it("asks where it lands, opens an upgrade Visit there with no Route text, and keeps records off the track as an earlier Version", async () => {
    const lasso = await lassoWith(ROUTED);
    await gate(lasso, 'lasso route fix --note "lint"');
    const ticket = await add(lasso);
    expect((await rested(lasso, ticket.id)).stage.name).toBe("polish");
    // v2 renames polish to tidy, so the fix Route goes there now.
    await edit(lasso, ROUTED.replaceAll("polish", "tidy"));
    const plan = await planOf(lasso, ticket.id);
    expect(plan).toMatchObject({ from: 1, to: 2, stages: ["implement", "gate", "tidy", "ship"], stage: "polish", keeps: false });
    expect(await refusal(lasso, ticket.id)).toEqual({ status: 400, error: "work v2 has no Stage named polish; pick the Stage the Ticket lands on" });
    expect(await refusal(lasso, ticket.id, { stage: "review" })).toEqual({ status: 400, error: "work v2 has no Stage named review; it has implement, gate, tidy, ship" });

    const after = await upgrade(lasso, ticket.id, { stage: "tidy" });
    expect(after).toMatchObject({ pipelineVersion: 2, stage: { name: "tidy" }, display: { state: "needs_you" }, visit: { number: 1, arrivedBy: "upgrade", route: null, chosenBy: null } });
    const visits = visitsOf(lasso, ticket.id);
    const [polish, tidy] = visits.slice(-2);
    expect(polish).toMatchObject({ stage: "polish", version: 1, left_at: expect.any(String) });
    expect(tidy).toMatchObject({ stage: "tidy", version: 2, arrived_by: "upgrade", from_visit: polish!.id, route: null, text: null, note: null, left_at: null });
    expect(upgradesOf(lasso, ticket.id)).toEqual([expect.objectContaining({ from_version: 1, to_version: 2, visit: polish!.id, landed: tidy!.id, dropped_route: null })]);

    // The fix record went to polish, which the track no longer has: no arc, but kept with the upgrade's marker.
    expect(after.arcs).toEqual([]);
    expect(after.upgrades).toEqual([
      {
        key: expect.any(String), at: expect.any(String), from: 1, to: 2, stage: "tidy", landed: true, dropped: null,
        earlier: [{ kind: "route", from: "gate", to: "polish", version: 1, visit: polish!.id, number: 1, at: expect.any(String), chosenBy: "action", route: "fix", text: "Polish the lint.", replaces: false, note: "lint", budget: { used: 1, limit: null } }],
      },
    ]);
  });
});

describe("upgrading a Ticket holding before a Route", () => {
  it("re-resolves a held pick whose Route survives to its new to:, and Start takes it there", async () => {
    const lasso = await lassoWith(HELD);
    await gate(lasso, 'lasso route back --note "lint"');
    const ticket = await add(lasso);
    expect((await rested(lasso, ticket.id)).display).toMatchObject({ state: "holding", why: "Start implement via back when ready" });
    await edit(lasso, HELD.replace("to: implement,", "to: review,").replace("  - name: polish", "  - name: review\n    prompt: Review.\n    human: true\n  - name: polish"));
    expect((await planOf(lasso, ticket.id)).pick).toEqual({ route: "back", by: "action", note: "lint", from: "implement", to: "review", dropped: null, held: true });
    const after = await upgrade(lasso, ticket.id);
    expect(after).toMatchObject({ pipelineVersion: 2, stage: { name: "gate" }, display: { state: "holding", why: "Start review via back when ready" } });
    expect(after.triggers.map((t) => t.label)).toContain("Start review via back");
    const started = await start(lasso, ticket.id);
    expect(started).toMatchObject({ stage: { name: "review" }, visit: { arrivedBy: "route", route: "back", chosenBy: "action" } });
    expect(visitsOf(lasso, ticket.id).at(-1)).toMatchObject({ stage: "review", version: 2, text: "Fix what the gate found.", note: "lint" });
  });

  it("warns that a pick whose Route is gone will be dropped, drops and records it on confirm, and Start walks forward", async () => {
    const lasso = await lassoWith(HELD);
    await gate(lasso, 'lasso route back --note "lint"');
    const ticket = await add(lasso);
    expect((await rested(lasso, ticket.id)).display.state).toBe("holding");
    await edit(lasso, HELD.replace("    routes:\n      back: { to: implement, append: Fix what the gate found., advance: false }\n", ""));
    expect((await planOf(lasso, ticket.id)).pick).toEqual({ route: "back", by: "action", note: "lint", from: "implement", to: null, dropped: "Route back is gone from gate in the new Version", held: true });
    expect(await refusal(lasso, ticket.id)).toEqual({ status: 400, error: "Route back is gone from gate in the new Version; upgrading drops the action pick of it. Confirm with drop: true" });
    expect(upgradesOf(lasso, ticket.id)).toEqual([]);

    const after = await upgrade(lasso, ticket.id, { drop: true });
    // Still holding at the gate, which has finished: Start walks on to polish.
    expect(after).toMatchObject({ pipelineVersion: 2, stage: { name: "gate" }, display: { state: "holding", why: "Start polish when ready" } });
    expect(after.triggers.map((t) => t.label)).toContain("Start polish");
    const gateVisit = visitsOf(lasso, ticket.id).at(-1)!;
    expect(gateVisit).toMatchObject({ stage: "gate", picked_route: null });
    expect(upgradesOf(lasso, ticket.id)).toEqual([{ from_version: 1, to_version: 2, visit: gateVisit.id, landed: null, dropped_route: "back", dropped_to: "implement", dropped_note: "lint", dropped_by: "action" }]);
    expect(after.upgrades[0]!.dropped).toEqual({ route: "back", to: "implement", by: "action", note: "lint" });

    const started = await start(lasso, ticket.id);
    expect(started).toMatchObject({ stage: { name: "polish" }, display: { state: "needs_you" } });
    expect(visitsOf(lasso, ticket.id).slice(-2)).toEqual([
      expect.objectContaining({ stage: "gate", skipped_at: null, left_at: expect.any(String) }),
      expect.objectContaining({ stage: "polish", arrived_by: "walk", version: 2 }),
    ]);
  });
});
