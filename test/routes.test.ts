import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLassoWithRepos, runCli, waitFor, claudeFixture, type Lasso, type LassoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult, PipelineListing, PipelineFile } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";
import { decide, type RoutePick } from "../src/route/route.ts";
import type { Stage } from "../src/pipeline/load.ts";

// Routes (LASSO-190): a Stage declares Routes to other Stages, an Action picks
// one with `lasso route`, and the Ticket takes it when the Action exits 0.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const BIN = path.join(import.meta.dirname, "..", "bin", "lasso.js");

const WORK = `stages:
  - name: implement
    prompt: Do the work.
  - action: gate
    routes:
      back:
        to: implement
        when: the gate finds a fault to fix
        append: Fix what the gate found.
        budget: 3
      redo: { to: implement, replace: Start over. }
      ahead: { to: ship }
  - name: polish
    prompt: Polish.
    human: true
  - name: ship
    prompt: Ship it.
    human: true
`;

// The gate runs gate.sh beside the lasso shim, so each test writes what it does.
const ACTIONS: LassoConfig["actions"] = { gate: { run: 'sh "$(dirname "$(command -v lasso)")/gate.sh"' } };

async function lassoWith(pipeline = WORK) {
  const { lasso } = await startLassoWithRepos({ app: { pipeline: "work" } }, { actions: ACTIONS }, { work: pipeline });
  running.push(lasso);
  // `lasso` inside a Session is this checkout's CLI, talking to this server.
  await writeFile(path.join(lasso.pathDir, "lasso"), `#!/bin/sh\nexec '${process.execPath}' '${BIN}' --port ${lasso.port} "$@"\n`, { mode: 0o755 });
  await lasso.runner.script({ stdout: claudeFixture("success.json") });
  return lasso;
}

/** gate.sh: run n of the gate does the n-th script, counting from 1; past the last it does nothing. */
const gate = (lasso: Lasso, ...runs: string[]) =>
  writeFile(
    path.join(lasso.pathDir, "gate.sh"),
    `dir=$(dirname "$(command -v lasso)")\nn=$(( $(cat "$dir/gate-count" 2>/dev/null || echo 0) + 1 ))\necho $n > "$dir/gate-count"\ncase $n in\n${runs.map((r, i) => `${i + 1}) ${r} ;;`).join("\n")}\nesac\n`,
  );

const json = (body: unknown) => JSON.stringify(body);
const add = (lasso: Lasso, input = "Add dark mode") => lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input, repo: "app", pipeline: "work" }) });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });

/** Tick until the Ticket rests: at a human Stage, or Flagged, with nothing running. */
const rested = (lasso: Lasso, id: string) =>
  waitFor(async () => {
    await checkNow(lasso);
    const d = await detailOf(lasso, id);
    return !d.sessions.some((s) => s.running) && (d.flag || d.stage.name === "polish" || d.stage.name === "ship") ? d : null;
  }, "the Ticket to rest", 20_000);

interface Visit {
  id: number;
  stage: string;
  arrived_by: string;
  from_visit: number | null;
  route: string | null;
  chosen_by: string | null;
  text: string | null;
  note: string | null;
  replaces: number;
  picked_route: string | null;
  skipped_at: string | null;
}

function visitsOf(lasso: Lasso, ticket: string): Visit[] {
  const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
  try {
    return db.prepare(`SELECT id, stage, arrived_by, from_visit, route, chosen_by, text, note, replaces, picked_route, skipped_at FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as Visit[];
  } finally {
    db.close();
  }
}

const prompts = async (lasso: Lasso) => (await lasso.runner.calls()).map((c) => c.argv.join("\n"));

describe("the Route decision", () => {
  const stage: Stage = {
    kind: "action",
    name: "gate",
    action: "gate",
    with: {},
    routes: { back: { to: "implement", append: "Fix it." }, redo: { to: "implement", replace: "Start over." }, ahead: { to: "ship" } },
  };
  const pick = (route: string, note: string | null = null): RoutePick => ({ route, note, by: "action" });
  const ok = { succeeded: true, lastLine: "all checks ran" };

  it("walks forward with no pick", () => {
    expect(decide({ stage, pick: null, end: ok })).toEqual({ kind: "walk" });
  });

  it("takes the picked Route on success, with its append text and the pick's note", () => {
    expect(decide({ stage, pick: pick("back", "tests fail"), end: ok })).toEqual({ kind: "route", route: "back", to: "implement", text: "Fix it.", replaces: false, note: "tests fail", chosenBy: "action" });
  });

  it("carries replace text as replacing, and no text for a Route with neither", () => {
    expect(decide({ stage, pick: pick("redo"), end: ok })).toMatchObject({ text: "Start over.", replaces: true });
    expect(decide({ stage, pick: pick("ahead"), end: ok })).toMatchObject({ to: "ship", text: null, replaces: false });
  });

  it("notes the run's last line when the pick gives none or a blank one, and nothing when neither has one", () => {
    expect(decide({ stage, pick: pick("back"), end: ok })).toMatchObject({ note: "all checks ran" });
    expect(decide({ stage, pick: pick("back", "  "), end: ok })).toMatchObject({ note: "all checks ran" });
    expect(decide({ stage, pick: pick("back"), end: { succeeded: true, lastLine: null } })).toMatchObject({ note: null });
  });

  it("fails a run that did not succeed, naming the pick it does not take", () => {
    expect(decide({ stage, pick: pick("back"), end: { succeeded: false, lastLine: "boom" } })).toEqual({ kind: "failed", untaken: pick("back") });
    expect(decide({ stage, pick: null, end: { succeeded: false, lastLine: null } })).toEqual({ kind: "failed", untaken: null });
  });

  it("walks forward on a pick the Stage does not declare", () => {
    expect(decide({ stage: { ...stage, routes: undefined }, pick: pick("back"), end: ok })).toEqual({ kind: "walk" });
  });
});

describe("Route validation", () => {
  const withRoutes = (routes: string) => `stages:\n  - name: implement\n    prompt: Do the work.\n  - action: gate\n    routes:\n${routes}  - name: ship\n    prompt: Ship it.\n    human: true\n`;
  const BAD: Array<[string, RegExp]> = [
    ["      back: { to: nowhere }\n", /Route back goes to nowhere, which is not a Stage of this Pipeline/],
    ["      Back: { to: implement }\n", /Route Back needs a name of lowercase letters, digits, and hyphens/],
    ["      back: { to: implement }\n      back: { to: ship }\n", /Map keys must be unique/],
    ["      back: { to: implement, append: a, replace: b }\n", /Route back has both append and replace; give one/],
    ["      back: { to: implement, budget: -1 }\n", /Route back: budget must be a whole number of 0 or more/],
    ["      back: { to: implement, budget: 1.5 }\n", /Route back: budget must be a whole number of 0 or more/],
    ["      back: { append: a }\n", /Route back needs to: <Stage>/],
    ["      back: { to: implement, via: x }\n", /Route back: via is not a field of a Route/],
  ];

  it("refuses a dashboard save that breaks a rule, and leaves the file alone", async () => {
    const lasso = await lassoWith();
    for (const [routes, problem] of BAD) {
      await expect(lasso.api("/api/pipelines/work", { method: "PUT", body: json({ text: withRoutes(routes) }) })).rejects.toThrow(problem);
    }
    // Removing a Stage a Route goes to breaks the Route.
    await expect(lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ order: ["implement", "gate", "polish"] }) })).rejects.toThrow(/Route ahead goes to ship, which is not a Stage/);
    expect(await readFile(path.join(lasso.home, "pipelines", "work.yaml"), "utf8")).toBe(WORK);

    // A self-Route, a Route on a Runner Stage, and a budget of 0 save.
    const good = `stages:\n  - name: implement\n    prompt: Do the work.\n    routes:\n      again: { to: implement, budget: 0 }\n  - action: gate\n    routes:\n      retry: { to: gate }\n`;
    const saved = await lasso.api<PipelineFile>("/api/pipelines/work", { method: "PUT", body: json({ text: good }) });
    expect(saved.pipeline!.stages.map((s) => s.routes)).toEqual([{ again: { to: "implement", budget: 0 } }, { retry: { to: "gate" } }]);
    // The dashboard's field save writes Routes too.
    const patched = await lasso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ stages: { gate: { routes: { retry: { to: "implement", append: "Look again." } } } } }) });
    expect(patched.pipeline!.stages[1]!.routes).toEqual({ retry: { to: "implement", append: "Look again." } });
  });

  it("reports a hand-written file that breaks a rule when it loads, and Intake refuses to take a Version of it", async () => {
    const lasso = await lassoWith();
    await writeFile(path.join(lasso.home, "pipelines", "work.yaml"), withRoutes(BAD[0]![0]));
    const listing = await lasso.api<PipelineListing[]>("/api/pipelines");
    expect(listing.find((p) => p.name === "work")).toMatchObject({ stages: [], problem: expect.stringMatching(BAD[0]![1]) });
    expect((await lasso.api<PipelineFile>("/api/pipelines/work")).problem).toMatch(BAD[0]![1]);
    await expect(add(lasso)).rejects.toThrow(BAD[0]![1]);
    // A duplicate Route name is a problem of the file too, not a crash.
    await writeFile(path.join(lasso.home, "pipelines", "work.yaml"), withRoutes(BAD[2]![0]));
    await expect(add(lasso)).rejects.toThrow(/Map keys must be unique/);
  });
});

describe("an Action that picks a Route", () => {
  it("routes back with its note, then by another Route the last call picked, then walks on", async () => {
    const lasso = await lassoWith();
    await gate(lasso, 'lasso route back --note "tests fail in CI"; echo "gate done"', 'lasso route ahead; lasso route redo; echo "lint is red"');
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(detail.flag).toBeNull();
    expect(detail.stage.name).toBe("polish");

    const visits = visitsOf(lasso, ticket.id);
    expect(visits.map((v) => v.stage)).toEqual(["implement", "gate", "implement", "gate", "implement", "gate", "polish"]);
    expect(visits[2]).toMatchObject({ arrived_by: "route", from_visit: visits[1]!.id, route: "back", chosen_by: "action", text: "Fix what the gate found.", note: "tests fail in CI", replaces: 0 });
    expect(visits[1]!.picked_route).toBe("back");
    expect(visits[4]).toMatchObject({ arrived_by: "route", from_visit: visits[3]!.id, route: "redo", chosen_by: "action", text: "Start over.", note: "lint is red", replaces: 1 });
    expect(visits[6]).toMatchObject({ arrived_by: "walk", route: null, text: null, note: null });

    const [first, second, third] = await prompts(lasso);
    expect(first).toContain("Do the work.");
    expect(first).not.toContain("Lasso sent this Ticket here");
    expect(second).toContain("Do the work.\n\nFix what the gate found.\n\nLasso sent this Ticket here by Route back, chosen by an Action, with this note: tests fail in CI");
    // replace takes the prompt's place; the text and note are the third Visit's alone.
    expect(third).toContain("Start over.\n\nLasso sent this Ticket here by Route redo, chosen by an Action, with this note: lint is red");
    expect(third).not.toContain("Do the work.");
    expect(third).not.toContain("Fix what the gate found.");
  });

  it("gives every Session of the routed Visit the Route's text and note", async () => {
    const lasso = await lassoWith();
    // The routed Visit's first run fails; its retry is the same Visit.
    await writeFile(path.join(lasso.pathDir, "fail.json"), JSON.stringify({ stdout: claudeFixture("failed.jsonl"), exit: 1 }));
    await gate(lasso, `cp "$dir/fail.json" "$dir/runner-script.json"; lasso route back --note 'flaky test'`);
    const ticket = await add(lasso);
    await waitFor(async () => {
      await checkNow(lasso);
      return (await detailOf(lasso, ticket.id)).flag ? true : null;
    }, "the failed run");
    expect(visitsOf(lasso, ticket.id).map((v) => v.stage)).toEqual(["implement", "gate", "implement"]);
    await lasso.runner.script({ stdout: claudeFixture("success.json") });
    await lasso.api(`/api/tickets/${ticket.id}/retry`, { method: "POST", body: "{}" });
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("polish");

    const calls = await prompts(lasso);
    expect(calls).toHaveLength(3);
    const note = "Lasso sent this Ticket here by Route back, chosen by an Action, with this note: flaky test";
    expect(calls[1]).toContain(note);
    expect(calls[2]).toContain(note);
    expect(calls[2]).toContain("Fix what the gate found.");
  });

  it("leaves a Stage it routes past with no Visit and no Skip", async () => {
    const lasso = await lassoWith();
    await gate(lasso, "lasso route ahead");
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("ship");
    const visits = visitsOf(lasso, ticket.id);
    expect(visits.map((v) => v.stage)).toEqual(["implement", "gate", "ship"]);
    expect(visits[2]).toMatchObject({ arrived_by: "route", route: "ahead", text: null, note: "picked Route ahead to ship", skipped_at: null });
  });

  it("Flags on a non-zero exit, showing the pick it does not take", async () => {
    const lasso = await lassoWith();
    await gate(lasso, 'lasso route back; echo "broke"; exit 2');
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("gate");
    expect(detail.flag).toMatchObject({ reason: "outcome.failed", detail: "gate exited 2: broke; Route back not taken" });
    expect(visitsOf(lasso, ticket.id).map((v) => v.stage)).toEqual(["implement", "gate"]);
  });

  it("refuses a Route the Stage does not declare, and walks forward once the pick is cleared", async () => {
    const lasso = await lassoWith();
    await gate(lasso, 'out="$(dirname "$(command -v lasso)")/out.txt"; lasso route nowhere > "$out" 2>&1; echo "exit $?" >> "$out"; lasso route back; lasso route --clear >> "$out"');
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("polish");
    expect(await readFile(path.join(lasso.pathDir, "out.txt"), "utf8")).toBe("no Route named nowhere on Stage gate; it has back, redo, ahead\nexit 1\nno Route picked on gate; it walks forward\n");
    expect(visitsOf(lasso, ticket.id).map((v) => [v.stage, v.picked_route])).toEqual([["implement", null], ["gate", null], ["polish", null]]);
  });

  it("is refused outside a Session, and in a Runner Session", async () => {
    const lasso = await lassoWith();
    const outside = await runCli(["route", "back"], lasso);
    expect(outside).toMatchObject({ code: 1, stderr: "lasso route runs inside a Session, where $LASSO_SESSION names it\n" });
    expect((await runCli(["route"], { ...lasso, env: { LASSO_SESSION: "x" } })).stderr).toContain("usage: lasso route <name>");

    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["sh", "-c", "lasso route back > refused.txt 2>&1; echo \"exit $?\" >> refused.txt"]] });
    await gate(lasso);
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(await readFile(path.join(detail.worktree, "refused.txt"), "utf8")).toBe("Stage implement does not let its agent choose a Route\nexit 1\n");
  });
});
