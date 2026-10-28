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

// The gate runs gate.sh beside the lasso shim, and the check check.sh, so each test writes what they do.
const ACTIONS: LassoConfig["actions"] = {
  gate: { run: 'sh "$(dirname "$(command -v lasso)")/gate.sh"' },
  check: { run: 'sh "$(dirname "$(command -v lasso)")/check.sh"' },
};

async function lassoWith(pipeline = WORK, extra: LassoConfig = {}) {
  const { lasso } = await startLassoWithRepos({ app: { pipeline: "work" } }, { actions: ACTIONS, ...extra }, { work: pipeline });
  running.push(lasso);
  // `lasso` inside a Session is this checkout's CLI, talking to this server.
  await writeFile(path.join(lasso.pathDir, "lasso"), `#!/bin/sh\nexec '${process.execPath}' '${BIN}' --port ${lasso.port} "$@"\n`, { mode: 0o755 });
  await lasso.runner.script({ stdout: claudeFixture("success.json") });
  return lasso;
}

/** <name>.sh: run n of the Action does the n-th script, counting from 1; past the last it does nothing. Each run's LASSO_SESSION goes on a line of <name>-ids. */
const script = (lasso: Lasso, name: string, runs: string[]) =>
  writeFile(
    path.join(lasso.pathDir, `${name}.sh`),
    `dir=$(dirname "$(command -v lasso)")\nn=$(( $(cat "$dir/${name}-count" 2>/dev/null || echo 0) + 1 ))\necho $n > "$dir/${name}-count"\necho "$LASSO_SESSION" >> "$dir/${name}-ids"\ncase $n in\n${runs.map((r, i) => `${i + 1}) ${r} ;;`).join("\n")}\nesac\n`,
  );
const gate = (lasso: Lasso, ...runs: string[]) => script(lasso, "gate", runs);
const check = (lasso: Lasso, ...runs: string[]) => script(lasso, "check", runs);
/** The LASSO_SESSION of each run of the Action so far. */
const idsOf = async (lasso: Lasso, name: string) => (await readFile(path.join(lasso.pathDir, `${name}-ids`), "utf8")).trim().split("\n");

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
  picked_note: string | null;
  picked_by: string | null;
  skipped_at: string | null;
  check_result: string | null;
  check_run: string | null;
}

function visitsOf(lasso: Lasso, ticket: string): Visit[] {
  const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
  try {
    return db.prepare(`SELECT id, stage, arrived_by, from_visit, route, chosen_by, text, note, replaces, picked_route, picked_note, picked_by, skipped_at, check_result, check_run FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as Visit[];
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
    expect(decide({ stage, pick: null, end: ok, counts: {} })).toEqual({ kind: "walk" });
  });

  it("takes the picked Route on success, with its append text and the pick's note", () => {
    expect(decide({ stage, pick: pick("back", "tests fail"), end: ok, counts: {} })).toEqual({ kind: "route", route: "back", to: "implement", text: "Fix it.", replaces: false, note: "tests fail", chosenBy: "action" });
  });

  it("carries replace text as replacing, and no text for a Route with neither", () => {
    expect(decide({ stage, pick: pick("redo"), end: ok, counts: {} })).toMatchObject({ text: "Start over.", replaces: true });
    expect(decide({ stage, pick: pick("ahead"), end: ok, counts: {} })).toMatchObject({ to: "ship", text: null, replaces: false });
  });

  it("notes the run's last line when the pick gives none or a blank one, and nothing when neither has one", () => {
    expect(decide({ stage, pick: pick("back"), end: ok, counts: {} })).toMatchObject({ note: "all checks ran" });
    expect(decide({ stage, pick: pick("back", "  "), end: ok, counts: {} })).toMatchObject({ note: "all checks ran" });
    expect(decide({ stage, pick: pick("back"), end: { succeeded: true, lastLine: null }, counts: {} })).toMatchObject({ note: null });
  });

  it("fails a run that did not succeed, naming the pick it does not take", () => {
    expect(decide({ stage, pick: pick("back"), end: { succeeded: false, lastLine: "boom" }, counts: {} })).toEqual({ kind: "failed", untaken: pick("back") });
    expect(decide({ stage, pick: null, end: { succeeded: false, lastLine: null }, counts: {} })).toEqual({ kind: "failed", untaken: null });
  });

  it("walks forward on a pick the Stage does not declare", () => {
    expect(decide({ stage: { ...stage, routes: undefined }, pick: pick("back"), end: ok, counts: {} })).toEqual({ kind: "walk" });
  });
});

describe("the Route decision's Budget rule", () => {
  const stage: Stage = { kind: "action", name: "gate", action: "gate", with: {}, routes: { back: { to: "implement", append: "Fix it." }, ahead: { to: "ship" } } };
  const ok = { succeeded: true, lastLine: "lint is red" };
  const take = { kind: "route", route: "back", to: "implement", text: "Fix it.", replaces: false, note: "lint is red", chosenBy: "action" };
  const exits = (by: RoutePick["by"], used: number, limit: number) => decide({ stage, pick: { route: "back", note: null, by }, end: ok, counts: { back: { used, limit } } });

  it("takes a Route with Budget left", () => {
    expect(exits("action", 0, 3)).toEqual(take);
    expect(exits("action", 2, 3)).toEqual(take);
  });

  it("Flags budget.routes at the limit and past it, naming the Route and keeping it pending", () => {
    expect(exits("action", 3, 3)).toEqual({ kind: "flag", reason: "budget.routes", detail: "Route back to implement: 3 of 3 used; Extend to take it", pending: take });
    expect(exits("check", 5, 3)).toMatchObject({ kind: "flag", detail: "Route back to implement: 5 of 3 used; Extend to take it", pending: { chosenBy: "check" } });
    expect(exits("agent", 0, 0)).toMatchObject({ kind: "flag", reason: "budget.routes" });
  });

  it("never refuses a human's pick", () => {
    expect(exits("human", 3, 3)).toEqual({ ...take, chosenBy: "human" });
  });

  it("counts only the picked Route, leaves one with no count uncapped, and fails a failed run first", () => {
    expect(decide({ stage, pick: { route: "ahead", note: null, by: "action" }, end: ok, counts: { back: { used: 3, limit: 3 } } })).toMatchObject({ kind: "route", route: "ahead" });
    expect(decide({ stage, pick: { route: "back", note: null, by: "action" }, end: { succeeded: false, lastLine: null }, counts: { back: { used: 3, limit: 3 } } })).toMatchObject({ kind: "failed" });
    expect(decide({ stage, pick: null, end: ok, counts: { back: { used: 3, limit: 3 } } })).toEqual({ kind: "walk" });
  });

  describe("with an agent's pick and a check's (LASSO-192)", () => {
    const agent = (route: string, note: string | null = null): RoutePick => ({ route, note, by: "agent" });
    const checked = (route: string, note: string | null = null): RoutePick => ({ route, note, by: "check", run: "run-1" });
    const done = { succeeded: true, lastLine: null };

    it("takes a check's pick alone, chosen by the check", () => {
      expect(decide({ stage, pick: null, check: checked("back", "flaky"), end: done, counts: {} })).toMatchObject({ kind: "route", route: "back", to: "implement", note: "flaky", chosenBy: "check" });
    });

    it("takes an agent's pick alone, with no check pick or a null one", () => {
      expect(decide({ stage, pick: agent("ahead"), check: null, end: done, counts: {} })).toMatchObject({ kind: "route", route: "ahead", chosenBy: "agent" });
    });

    it("takes the same Route once, as the agent's, its note falling back to the check's", () => {
      expect(decide({ stage, pick: agent("back", "agent says"), check: checked("back", "check says"), end: done, counts: {} })).toMatchObject({ kind: "route", route: "back", note: "agent says", chosenBy: "agent" });
      expect(decide({ stage, pick: agent("back", " "), check: checked("back", "check says"), end: done, counts: {} })).toMatchObject({ note: "check says", chosenBy: "agent" });
    });

    it("is a conflict when the two pick different Routes, showing both", () => {
      expect(decide({ stage, pick: agent("back", "again"), check: checked("ahead"), end: done, counts: {} })).toEqual({ kind: "conflict", pick: agent("back", "again"), check: checked("ahead") });
    });

    it("ignores a pick the Stage does not declare, so the other is taken alone", () => {
      expect(decide({ stage, pick: agent("gone"), check: checked("ahead"), end: done, counts: {} })).toMatchObject({ kind: "route", route: "ahead", chosenBy: "check" });
      expect(decide({ stage, pick: agent("back"), check: checked("gone"), end: done, counts: {} })).toMatchObject({ kind: "route", route: "back", chosenBy: "agent" });
    });

    it("fails a run that did not succeed, naming the run's own pick", () => {
      expect(decide({ stage, pick: agent("back"), check: checked("ahead"), end: { succeeded: false, lastLine: null }, counts: {} })).toEqual({ kind: "failed", untaken: agent("back") });
    });
  });
});

describe("the Route decision's hold rule (LASSO-196)", () => {
  const routes = { back: { to: "implement" }, gated: { to: "implement", advance: false }, open: { to: "ship", advance: true } };
  const action: Stage = { kind: "action", name: "gate", action: "gate", with: {}, routes };
  const runner = (advance: boolean): Stage => ({ kind: "runner", name: "review", prompt: null, skills: [], profile: null, human: false, advance, artifact: null, repeat: null, budget: {}, routes });
  const ok = { succeeded: true, lastLine: null };
  const by = (stage: Stage, route: string, who: RoutePick["by"] = "check", counts = {}) => decide({ stage, pick: { route, note: null, by: who }, end: ok, counts });

  it("holds on every Route of a source Stage that says advance: false, and on none of one that does not", () => {
    expect(by(runner(false), "back")).toMatchObject({ kind: "route", route: "back", holds: true });
    expect(by(runner(false), "open")).toMatchObject({ kind: "route", route: "open", holds: true });
    expect(by(runner(true), "back")).not.toHaveProperty("holds");
    expect(decide({ stage: runner(false), pick: null, end: ok, counts: {} })).toEqual({ kind: "walk" });
  });

  it("holds on a Route that says advance: false, on that exit only", () => {
    expect(by(action, "gated", "action")).toMatchObject({ kind: "route", route: "gated", holds: true });
    expect(by(runner(true), "gated")).toMatchObject({ holds: true });
    expect(by(action, "back", "action")).not.toHaveProperty("holds");
    expect(by(action, "open", "action")).not.toHaveProperty("holds");
  });

  it("Flags a spent Route at once rather than holding, and never holds a human's pick", () => {
    expect(by(runner(false), "back", "agent", { back: { used: 1, limit: 1 } })).toMatchObject({ kind: "flag", reason: "budget.routes" });
    expect(by(action, "gated", "action", { gated: { used: 0, limit: 1 } })).toMatchObject({ holds: true });
    expect(by(action, "gated", "human")).not.toHaveProperty("holds");
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
    ["      back: { to: implement, advance: later }\n", /Route back: advance must be true or false/],
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

// A check Action as a Runner Stage's Artifact may run `lasso route` too (LASSO-192): each check run has its own
// LASSO_SESSION, and its pick counts only when the run is met.
const CHECKED = `stages:
  - name: implement
    prompt: Do the work.
    artifact: action check
    routes:
      again: { to: implement, append: Look again. }
      ahead: { to: ship }
  - name: polish
    prompt: Polish.
    human: true
  - name: ship
    prompt: Ship it.
    human: true
`;

describe("a check Action that picks a Route", () => {
  it("takes the Route a met check picked, then walks on after a met run without a call", async () => {
    const lasso = await lassoWith(CHECKED);
    await check(lasso, 'lasso route again --note "missed a case"; echo "looked"', 'echo "all good"');
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(detail.flag).toBeNull();
    expect(detail.stage.name).toBe("polish");

    const ids = await idsOf(lasso, "check");
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/\S/);
    expect(ids[1]).not.toBe(ids[0]);
    const visits = visitsOf(lasso, ticket.id);
    expect(visits.map((v) => v.stage)).toEqual(["implement", "implement", "polish"]);
    expect(visits[1]).toMatchObject({ arrived_by: "route", from_visit: visits[0]!.id, route: "again", chosen_by: "check", text: "Look again.", note: "missed a case" });
    // The pick and the run that made it are kept on the Visit's check result.
    expect(visits[0]!.check_run).toBe(ids[0]);
    expect(JSON.parse(visits[0]!.check_result!)).toMatchObject({ action: "check", result: "met", line: "looked", route: "again", note: "missed a case" });
    expect(visits[1]!.check_run).toBe(ids[1]);
    expect(JSON.parse(visits[1]!.check_result!)).not.toHaveProperty("route");

    const calls = await prompts(lasso);
    expect(calls[1]).toContain("Do the work.\n\nLook again.\n\nLasso sent this Ticket here by Route again, chosen by a check");
  });

  it("notes the check's last line when the call gives no note", async () => {
    const lasso = await lassoWith(CHECKED);
    await check(lasso, 'lasso route ahead; echo "nothing left to do"');
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("ship");
    expect(visitsOf(lasso, ticket.id)[1]).toMatchObject({ arrived_by: "route", route: "ahead", chosen_by: "check", note: "nothing left to do" });
  });

  it("discards a not-met run's pick, never counts a stale call from it, and walks on after a later met run", async () => {
    const lasso = await lassoWith(CHECKED);
    await check(lasso, 'lasso route ahead --note "skip polish"; echo "not yet"; exit 1', 'echo "all good"');
    const ticket = await add(lasso);
    const flagged = await rested(lasso, ticket.id);
    expect(flagged.flag).toMatchObject({ reason: "artifact.missing", detail: "action check: not yet" });
    const [first] = await idsOf(lasso, "check");
    const [visit] = visitsOf(lasso, ticket.id);
    expect(visit!.check_run).toBe(first);
    expect(JSON.parse(visit!.check_result!)).toEqual({ action: "check", result: "not_met", at: expect.any(String), code: 1, line: "not yet" });

    // The run has ended: a late call carrying its id is refused and records nothing.
    const stale = await runCli(["route", "ahead"], { ...lasso, env: { LASSO_SESSION: first! } });
    expect(stale).toMatchObject({ code: 1, stderr: `no running Session or check run ${first}; a Route is picked while it runs\n` });

    await lasso.api(`/api/tickets/${ticket.id}/retry`, { method: "POST", body: "{}" });
    const detail = await rested(lasso, ticket.id);
    expect(detail.flag).toBeNull();
    expect(detail.stage.name).toBe("polish");
    expect(visitsOf(lasso, ticket.id).map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["polish", "walk"]]);
  });

  it("refuses a Route the Stage does not declare", async () => {
    const lasso = await lassoWith(CHECKED);
    await check(lasso, 'out="$(dirname "$(command -v lasso)")/out.txt"; lasso route nowhere > "$out" 2>&1; echo "exit $?" >> "$out"');
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("polish");
    expect(await readFile(path.join(lasso.pathDir, "out.txt"), "utf8")).toBe("no Route named nowhere on Stage implement; it has again, ahead\nexit 1\n");
  });

  describe("beside an agent's pick", () => {
    // An opted-in agent (LASSO-193) picks with `lasso route` during its Session; the check then picks and is met.
    const OPTED_IN = CHECKED.replace("    artifact: action check\n", "    artifact: action check\n    agentRoutes: true\n");
    const agentRuns = (lasso: Lasso, call: string) => lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["sh", "-c", call]] });

    it("Flags route.conflict showing both when they pick different Routes, and takes the Route once when they agree", async () => {
      const lasso = await lassoWith(OPTED_IN);
      await check(lasso, 'lasso route ahead; echo "ready to ship"', 'lasso route ahead --note "check agrees"');
      await agentRuns(lasso, 'lasso route again --note "another pass needed"');
      const split = await add(lasso);
      const flagged = await rested(lasso, split.id);
      expect(flagged.stage.name).toBe("implement");
      expect(flagged.flag).toMatchObject({ reason: "route.conflict", detail: "the agent picked Route again (another pass needed); the check picked Route ahead (ready to ship)" });
      expect(visitsOf(lasso, split.id).map((v) => v.stage)).toEqual(["implement"]);

      await agentRuns(lasso, "lasso route ahead");
      const agreed = await add(lasso, "Add light mode");
      const detail = await rested(lasso, agreed.id);
      expect(detail.flag).toBeNull();
      expect(detail.stage.name).toBe("ship");
      expect(visitsOf(lasso, agreed.id)[1]).toMatchObject({ arrived_by: "route", route: "ahead", chosen_by: "agent", note: "check agrees" });
    });
  });
});

describe("Send to Stage", () => {
  const send = (lasso: Lasso, id: string, body: Record<string, unknown>) => lasso.api<TicketDetail>(`/api/tickets/${id}/send`, { method: "POST", body: json(body) });

  it("sends a Ticket back from a human Stage with instructions that reach the target prompt, and it walks on from there", async () => {
    const lasso = await lassoWith();
    await gate(lasso);
    const ticket = await add(lasso);
    const at = await rested(lasso, ticket.id);
    expect(at.stage.name).toBe("polish");
    // polish declares no Routes: any Stage can still be sent to, with only the human's words.
    expect(at.send).toEqual({ unavailable: null, routes: [] });

    await send(lasso, ticket.id, { stage: "implement", instructions: "  Handle the empty list too. " });
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("polish");
    const visits = visitsOf(lasso, ticket.id);
    expect(visits.map((v) => v.stage)).toEqual(["implement", "gate", "polish", "implement", "gate", "polish"]);
    expect(visits[3]).toMatchObject({ arrived_by: "send", from_visit: visits[2]!.id, route: null, chosen_by: "human", text: null, note: "Handle the empty list too.", replaces: 0 });
    // The instructions last for that Visit only; the walk on from it is ordinary.
    expect(visits[4]).toMatchObject({ arrived_by: "walk", note: null });

    const [first, second] = await prompts(lasso);
    expect(first).not.toContain("A human sent this Ticket here");
    expect(second).toContain("Do the work.\n\nA human sent this Ticket here, with these instructions: Handle the empty list too.");
  });

  it("reuses a declared Route's text from a Flag, keeping the pick it overrides on the Visit it leaves", async () => {
    const lasso = await lassoWith();
    await gate(lasso, 'lasso route back; echo "broke"; exit 2');
    const ticket = await add(lasso);
    const flagged = await rested(lasso, ticket.id);
    expect(flagged.flag).toMatchObject({ reason: "outcome.failed" });
    expect(flagged.send).toEqual({
      unavailable: null,
      routes: [
        { name: "back", to: "implement", text: "Fix what the gate found.", replaces: false },
        { name: "redo", to: "implement", text: "Start over.", replaces: true },
        { name: "ahead", to: "ship", text: null, replaces: false },
      ],
    });

    const sent = await send(lasso, ticket.id, { stage: "implement", route: "redo", instructions: "Try a smaller change." });
    expect(sent.flag).toBeNull();
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("polish");
    const visits = visitsOf(lasso, ticket.id);
    expect(visits.map((v) => v.stage)).toEqual(["implement", "gate", "implement", "gate", "polish"]);
    expect(visits[1]).toMatchObject({ picked_route: "back" });
    expect(visits[2]).toMatchObject({ arrived_by: "send", route: "redo", chosen_by: "human", text: "Start over.", note: "Try a smaller change.", replaces: 1 });

    const second = (await prompts(lasso))[1]!;
    expect(second).toContain("Start over.\n\nA human sent this Ticket here by Route redo, with these instructions: Try a smaller change.");
    expect(second).not.toContain("Do the work.");
  });

  it("is never refused for a Route's Budget, and refuses only what it cannot do", async () => {
    const lasso = await lassoWith(WORK.replace("budget: 3", "budget: 0"));
    await gate(lasso, "exit 2");
    const ticket = await add(lasso);
    expect((await rested(lasso, ticket.id)).flag).toMatchObject({ reason: "outcome.failed" });

    await expect(send(lasso, ticket.id, {})).rejects.toThrow("stage must name the Stage to send the Ticket to");
    await expect(send(lasso, ticket.id, { stage: "nowhere" })).rejects.toThrow("Pipeline work has no Stage named nowhere");
    await expect(send(lasso, ticket.id, { stage: "implement", route: "nope" })).rejects.toThrow("Stage gate declares no Route named nope");
    await expect(send(lasso, ticket.id, { stage: "implement", route: "ahead" })).rejects.toThrow("Route ahead goes to ship, not implement");
    expect(visitsOf(lasso, ticket.id)).toHaveLength(2);

    // back allows an agent, Action or check no laps at all; a human's send takes it anyway, and counts nothing.
    await send(lasso, ticket.id, { stage: "implement", route: "back" });
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("polish");
    expect(visitsOf(lasso, ticket.id)[2]).toMatchObject({ arrived_by: "send", route: "back", chosen_by: "human", text: "Fix what the gate found.", note: null });
    // With no instructions the Route's text is all the prompt gains.
    const second = (await prompts(lasso))[1]!;
    expect(second).toContain("Do the work.\n\nFix what the gate found.");
    expect(second).not.toContain("A human sent this Ticket here");
  });

  it("releases a holding Ticket into the Stage it is sent to", async () => {
    const lasso = await lassoWith(`stages:\n  - name: implement\n    prompt: Do the work.\n    advance: false\n  - name: polish\n    prompt: Polish.\n    human: true\n`);
    const ticket = await add(lasso);
    const holding = await rested(lasso, ticket.id);
    expect(holding.display.state).toBe("holding");

    await send(lasso, ticket.id, { stage: "implement", instructions: "" });
    await waitFor(async () => ((await lasso.runner.calls()).length === 2 ? true : null), "implement to run again");
    // implement runs and, saying advance: false, holds before polish again.
    expect((await rested(lasso, ticket.id)).display.state).toBe("holding");
    expect(visitsOf(lasso, ticket.id).map((v) => [v.stage, v.arrived_by, v.note])).toEqual([["implement", "intake", null], ["polish", "walk", null], ["implement", "send", null], ["polish", "walk", null]]);
    // Blank instructions are none: the prompt is the Stage's own.
    expect((await prompts(lasso))[1]).not.toContain("A human sent this Ticket here");
  });

  it("is refused while a Session runs, and for a Ticket that has ended", async () => {
    const lasso = await lassoWith();
    await lasso.runner.script({ hang: true });
    const ticket = await add(lasso);
    const runningNow = await waitFor(async () => {
      await checkNow(lasso);
      const d = await detailOf(lasso, ticket.id);
      return d.sessions.some((s) => s.running) ? d : null;
    }, "implement to start");
    expect(runningNow.send).toEqual({ unavailable: "implement has a Session running; stop it or let it end first", routes: [] });
    await expect(send(lasso, ticket.id, { stage: "ship" })).rejects.toThrow("implement has a Session running; stop it or let it end before sending the Ticket elsewhere");

    const abandoned = await lasso.api<TicketDetail>(`/api/tickets/${ticket.id}/abandon`, { method: "POST", body: "{}" });
    expect(abandoned.send).toBeNull();
    await expect(send(lasso, ticket.id, { stage: "ship" })).rejects.toThrow("is abandoned");
  });
});

describe("the Route Budget", () => {
  // back has no budget: of its own, so the global budget.routes caps it; again sets its own.
  const LOOP = `stages:
  - name: implement
    prompt: Do the work.
  - action: gate
    routes:
      back: { to: implement, append: Fix what the gate found. }
      again: { to: implement, budget: 4 }
  - name: polish
    prompt: Polish.
    human: true
`;
  const extend = (lasso: Lasso, id: string, body: unknown) => lasso.api<TicketDetail>(`/api/tickets/${id}/extend`, { method: "POST", body: json(body) });
  const routeCount = (lasso: Lasso, id: string, route: string) => visitsOf(lasso, id).filter((v) => v.route === route).length;

  it("takes a Route three times by default, then Flags budget.routes at the source without moving", async () => {
    const lasso = await lassoWith(LOOP);
    await gate(lasso, ...Array.from({ length: 4 }, (_, i) => `lasso route back --note "lap ${i + 1}"`));
    const ticket = await add(lasso);
    const detail = await rested(lasso, ticket.id);
    expect(detail.stage.name).toBe("gate");
    expect(detail.flag).toMatchObject({ reason: "budget.routes", detail: "Route back to implement: 3 of 3 used; Extend to take it" });
    const visits = visitsOf(lasso, ticket.id);
    // Each lap is a new Visit; the count carries across them.
    expect(visits.map((v) => v.stage)).toEqual(["implement", "gate", "implement", "gate", "implement", "gate", "implement", "gate"]);
    expect(visits.at(-1)).toMatchObject({ stage: "gate", picked_route: "back", picked_note: "lap 4", picked_by: "action" });
    expect(routeCount(lasso, ticket.id, "back")).toBe(3);
    expect(await lasso.runner.calls()).toHaveLength(4);
    await waitFor(async () => ((await lasso.notifications()).some((n) => n.body === "budget.routes: Route back to implement: 3 of 3 used; Extend to take it") ? true : null), "the Flag's notification");
  });

  it("lets a Route's budget: beat the global limit, and the Ticket's limit beat both", async () => {
    const lasso = await lassoWith(LOOP, { budget: { routes: 1 } });
    await gate(lasso, "lasso route back", "lasso route back", "lasso route again", "lasso route again", "lasso route again");
    const ticket = await add(lasso);
    let detail = await rested(lasso, ticket.id);
    expect(detail.flag).toMatchObject({ reason: "budget.routes", detail: "Route back to implement: 1 of 1 used; Extend to take it" });

    // The Ticket's limit of 2 lets back go round once more, and caps again below its own budget: 4.
    await extend(lasso, ticket.id, { routes: 2 });
    detail = await rested(lasso, ticket.id);
    expect(detail.flag).toMatchObject({ reason: "budget.routes", detail: "Route again to implement: 2 of 2 used; Extend to take it" });
    expect(routeCount(lasso, ticket.id, "back")).toBe(2);
    expect(routeCount(lasso, ticket.id, "again")).toBe(2);

    // Cleared, the Ticket layer falls back to again's own budget: 4, and the pending Route is taken.
    await extend(lasso, ticket.id, { routes: null });
    detail = await rested(lasso, ticket.id);
    expect(detail.flag).toBeNull();
    expect(detail.stage.name).toBe("polish");
    expect(routeCount(lasso, ticket.id, "again")).toBe(3);
  });

  it("Extend takes the pending Route once the Ticket's limit allows it, and leaves the Flag while it does not", async () => {
    const lasso = await lassoWith(LOOP, { budget: { routes: 1 } });
    await gate(lasso, "lasso route back", 'lasso route back; echo "still red"');
    const ticket = await add(lasso);
    await rested(lasso, ticket.id);

    const unchanged = await extend(lasso, ticket.id, { routes: 1 });
    expect(unchanged.flag).toMatchObject({ reason: "budget.routes" });
    expect(visitsOf(lasso, ticket.id)).toHaveLength(4);

    const extended = await extend(lasso, ticket.id, { routes: 2 });
    expect(extended.flag).toBeNull();
    expect(extended.stage.name).toBe("implement");
    const visits = visitsOf(lasso, ticket.id);
    // The pending pick is taken as the Action's, with the note it would have carried.
    expect(visits.at(-1)).toMatchObject({ stage: "implement", arrived_by: "route", route: "back", chosen_by: "action", text: "Fix what the gate found.", note: "still red", from_visit: visits.at(-2)!.id });
    expect(routeCount(lasso, ticket.id, "back")).toBe(2);
    expect((await detailOf(lasso, ticket.id)).budget.ticket.routes).toBe(2);
  });

  it("refuses a Route limit that is not a whole number", async () => {
    const lasso = await lassoWith(LOOP);
    const ticket = await add(lasso);
    await expect(extend(lasso, ticket.id, { routes: 1.5 })).rejects.toThrow(/routes must be a whole number of 0 or more/);
  });

  it("Mark done and Skip walk forward, leaving the pick unused", async () => {
    for (const lever of ["done", "skip"]) {
      const lasso = await lassoWith(LOOP, { budget: { routes: 0 } });
      await gate(lasso, "lasso route back");
      const ticket = await add(lasso);
      expect((await rested(lasso, ticket.id)).flag).toMatchObject({ reason: "budget.routes", detail: "Route back to implement: 0 of 0 used; Extend to take it" });
      const after = await lasso.api<TicketDetail>(`/api/tickets/${ticket.id}/${lever}`, { method: "POST", body: "{}" });
      expect(after.flag).toBeNull();
      expect(after.stage.name).toBe("polish");
      const visits = visitsOf(lasso, ticket.id);
      expect(visits.map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["gate", "walk"], ["polish", "walk"]]);
      expect(visits[1]!.picked_route).toBe("back");
    }
  });

  it("Retry re-runs the source Stage, whose pick is judged afresh against counts that never reset", async () => {
    const lasso = await lassoWith(LOOP, { budget: { routes: 1 } });
    await gate(lasso, "lasso route back", "lasso route back", "lasso route back", 'echo "clean"');
    const ticket = await add(lasso);
    await rested(lasso, ticket.id);
    expect(visitsOf(lasso, ticket.id)).toHaveLength(4);

    // The retried gate picks back again: still spent, it Flags again on the same Visit.
    await lasso.api(`/api/tickets/${ticket.id}/retry`, { method: "POST", body: "{}" });
    let detail = await rested(lasso, ticket.id);
    expect(detail.flag).toMatchObject({ reason: "budget.routes", detail: "Route back to implement: 1 of 1 used; Extend to take it" });
    expect(visitsOf(lasso, ticket.id)).toHaveLength(4);

    // A retry that picks nothing walks forward.
    await lasso.api(`/api/tickets/${ticket.id}/retry`, { method: "POST", body: "{}" });
    detail = await rested(lasso, ticket.id);
    expect(detail.flag).toBeNull();
    expect(detail.stage.name).toBe("polish");
    expect(routeCount(lasso, ticket.id, "back")).toBe(1);
  });

  it("holds a met check's pick to the Budget too, and Extend takes it as the check's", async () => {
    const lasso = await lassoWith(CHECKED, { budget: { routes: 1 } });
    await check(lasso, 'lasso route again --note "first"', 'lasso route again --note "second"', 'echo "all good"');
    const ticket = await add(lasso);
    const flagged = await rested(lasso, ticket.id);
    expect(flagged.flag).toMatchObject({ reason: "budget.routes", detail: "Route again to implement: 1 of 1 used; Extend to take it" });
    expect(visitsOf(lasso, ticket.id).at(-1)).toMatchObject({ stage: "implement", picked_route: "again", picked_note: "second", picked_by: "check" });

    await extend(lasso, ticket.id, { routes: 2 });
    const detail = await rested(lasso, ticket.id);
    expect(detail.flag).toBeNull();
    expect(detail.stage.name).toBe("polish");
    const visits = visitsOf(lasso, ticket.id);
    expect(visits.map((v) => v.stage)).toEqual(["implement", "implement", "implement", "polish"]);
    expect(visits[2]).toMatchObject({ arrived_by: "route", route: "again", chosen_by: "check", note: "second" });
  });

  it("does not take a spent check pick left pending once a retried run's check picks nothing", async () => {
    const lasso = await lassoWith(CHECKED, { budget: { routes: 0 } });
    await check(lasso, "lasso route again", 'echo "all good"');
    const ticket = await add(lasso);
    expect((await rested(lasso, ticket.id)).flag).toMatchObject({ reason: "budget.routes" });
    await lasso.api(`/api/tickets/${ticket.id}/retry`, { method: "POST", body: "{}" });
    const detail = await rested(lasso, ticket.id);
    expect(detail.flag).toBeNull();
    expect(detail.stage.name).toBe("polish");
    expect(visitsOf(lasso, ticket.id).map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["polish", "walk"]]);
  });
});

describe("holding before a Route (LASSO-196)", () => {
  // implement's check picks a Route; implement says advance: false, so every exit from it holds.
  const SOURCE_GATE = CHECKED.replace("    artifact: action check\n", "    artifact: action check\n    advance: false\n");
  // Only the gate's back Route holds; ahead passes over polish, whose own hold is ignored.
  const ROUTE_GATE = `stages:
  - name: implement
    prompt: Do the work.
  - action: gate
    routes:
      back: { to: implement, append: Fix what the gate found., advance: false }
      ahead: { to: ship }
  - name: polish
    prompt: Polish.
    advance: false
  - name: ship
    prompt: Ship it.
    human: true
`;
  const start = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/start`, { method: "POST", body: "{}" });
  const routeCount = (lasso: Lasso, id: string, route: string) => visitsOf(lasso, id).filter((v) => v.route === route && v.chosen_by !== "human").length;
  /** Tick until the Ticket holds, rests at ship, or Flags, with nothing running. */
  const settled = (lasso: Lasso, id: string) =>
    waitFor(async () => {
      await checkNow(lasso);
      const d = await detailOf(lasso, id);
      return !d.sessions.some((s) => s.running) && (d.flag || d.display.state === "holding" || d.stage.name === "ship") ? d : null;
    }, "the Ticket to settle", 20_000);
  const notified = (lasso: Lasso, body: string) => waitFor(async () => ((await lasso.notifications()).some((n) => n.body === body) ? true : null), `the notification "${body}"`);

  it("holds at a source Stage that says advance: false, naming the Route, and Start takes it, counting it then", async () => {
    const lasso = await lassoWith(SOURCE_GATE);
    await check(lasso, 'lasso route again --note "missed a case"', 'echo "all good"');
    const ticket = await add(lasso);
    const held = await settled(lasso, ticket.id);
    expect(held.stage.name).toBe("implement");
    expect(held.display).toMatchObject({ state: "holding", why: "Start implement via again when ready" });
    expect(held.triggers.map((t) => t.label)).toContain("Start implement via again");
    // The pick waits on the source Visit; no Visit opens at the target, so the Route has not counted yet.
    expect(visitsOf(lasso, ticket.id)).toEqual([expect.objectContaining({ stage: "implement", picked_route: "again", picked_note: "missed a case", picked_by: "check" })]);
    expect(routeCount(lasso, ticket.id, "again")).toBe(0);
    await notified(lasso, "implement finished; Start implement via again when ready");
    expect(await lasso.runner.calls()).toHaveLength(1);

    const started = await start(lasso, ticket.id);
    expect(started.display.state).not.toBe("holding");
    const visits = visitsOf(lasso, ticket.id);
    expect(visits[1]).toMatchObject({ stage: "implement", arrived_by: "route", route: "again", chosen_by: "check", text: "Look again.", note: "missed a case", from_visit: visits[0]!.id });
    expect(routeCount(lasso, ticket.id, "again")).toBe(1);

    // The second run walks forward; implement's advance: false holds that exit too, as before Routes.
    const walked = await settled(lasso, ticket.id);
    expect(walked).toMatchObject({ stage: { name: "polish" }, display: { state: "holding", why: "Start polish when ready" } });
    expect((await prompts(lasso))[1]).toContain("Do the work.\n\nLook again.");
  });

  it("holds on a Route that says advance: false only, and ignores the hold of a Stage a forward Route passes over", async () => {
    const lasso = await lassoWith(ROUTE_GATE);
    await gate(lasso, 'lasso route back --note "lint"', "lasso route ahead");
    const ticket = await add(lasso);
    const held = await settled(lasso, ticket.id);
    expect(held).toMatchObject({ stage: { name: "gate" }, display: { state: "holding", why: "Start implement via back when ready" } });
    await start(lasso, ticket.id);

    // ahead does not hold, and passes over polish with its advance: false: the Ticket lands at ship.
    const detail = await settled(lasso, ticket.id);
    expect(detail.stage.name).toBe("ship");
    expect(detail.display.state).toBe("needs_you");
    expect(visitsOf(lasso, ticket.id).map((v) => [v.stage, v.arrived_by, v.route])).toEqual([["implement", "intake", null], ["gate", "walk", null], ["implement", "route", "back"], ["gate", "walk", null], ["ship", "route", "ahead"]]);
    // The hold posts the gate notification; the Routes firing post none, and only the human Stage's follows.
    await notified(lasso, "ship needs you");
    expect((await lasso.notifications()).map((n) => n.body)).toEqual(["gate finished; Start implement via back when ready", "ship needs you"]);
  });

  it("Flags a spent pick at once, even when it would hold", async () => {
    const lasso = await lassoWith(ROUTE_GATE.replace("advance: false }", "advance: false, budget: 0 }"));
    await gate(lasso, "lasso route back");
    const ticket = await add(lasso);
    const detail = await settled(lasso, ticket.id);
    expect(detail.flag).toMatchObject({ reason: "budget.routes", detail: "Route back to implement: 0 of 0 used; Extend to take it" });
    expect(detail.display.state).toBe("flagged");

    // Extend lets it be taken, and the Route's hold still applies before it is.
    const extended = await lasso.api<TicketDetail>(`/api/tickets/${ticket.id}/extend`, { method: "POST", body: json({ routes: 1 }) });
    expect(extended).toMatchObject({ flag: null, stage: { name: "gate" }, display: { state: "holding", why: "Start implement via back when ready" } });
    expect(routeCount(lasso, ticket.id, "back")).toBe(0);
  });

  it("Skip declines the Route and walks on without holding again, even from a source Stage that says advance: false", async () => {
    const lasso = await lassoWith(SOURCE_GATE);
    await check(lasso, 'lasso route again --note "missed a case"');
    const ticket = await add(lasso);
    expect((await settled(lasso, ticket.id)).display.why).toBe("Start implement via again when ready");
    await expect(lasso.api(`/api/tickets/${ticket.id}/takeover`, { method: "POST", body: "{}" })).rejects.toThrow(`Ticket ${ticket.id} is holding; Start implement via again or open the draft`);

    const skipped = await lasso.api<TicketDetail>(`/api/tickets/${ticket.id}/skip`, { method: "POST", body: "{}" });
    expect(skipped).toMatchObject({ stage: { name: "polish" }, display: { state: "needs_you" } });
    const visits = visitsOf(lasso, ticket.id);
    expect(visits.map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["polish", "walk"]]);
    expect(visits[0]).toMatchObject({ picked_route: "again", picked_note: "missed a case", picked_by: "check" });
    expect(visits[0]!.skipped_at).not.toBeNull();
    expect(routeCount(lasso, ticket.id, "again")).toBe(0);
  });

  it("Skip, Abandon or a send instead of Start never counts, and the source Visit keeps the overridden pick", async () => {
    for (const lever of ["skip", "abandon", "send"] as const) {
      const lasso = await lassoWith(ROUTE_GATE);
      await gate(lasso, 'lasso route back --note "lint"');
      const ticket = await add(lasso);
      expect((await settled(lasso, ticket.id)).display.state).toBe("holding");
      const body = lever === "send" ? json({ stage: "ship", instructions: "Ship as is." }) : "{}";
      const after = await lasso.api<TicketDetail>(`/api/tickets/${ticket.id}/${lever}`, { method: "POST", body });
      expect(after.stage.name).toBe({ skip: "polish", abandon: "gate", send: "ship" }[lever]);
      expect(after.display.state).not.toBe("holding");
      const visits = visitsOf(lasso, ticket.id);
      expect(visits[1]).toMatchObject({ stage: "gate", picked_route: "back", picked_note: "lint", picked_by: "action" });
      expect(routeCount(lasso, ticket.id, "back")).toBe(0);
      if (lever === "skip") expect(visits.map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["gate", "walk"], ["polish", "walk"]]);
      if (lever === "send") expect(visits[2]).toMatchObject({ stage: "ship", arrived_by: "send", route: null, chosen_by: "human", note: "Ship as is.", from_visit: visits[1]!.id });
      if (lever === "abandon") expect(visits).toHaveLength(2);
    }
  }, 60_000);
});
