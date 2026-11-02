import { describe, it, expect, afterEach } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLaissoWithRepos, waitFor, claudeFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult, PipelineListing, PipelineFile } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Wait Stages (LASSO-195): a Stage that runs no Session but Watches a check
// Action each Tick, moving on once it is met.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const BIN = path.join(import.meta.dirname, "..", "bin", "laisso.js");

const WAIT = `stages:
  - name: implement
    prompt: Do the work.
  - name: ci
    wait: action check
    routes:
      back: { to: implement, append: Fix what CI found. }
  - name: ship
    prompt: Ship it.
    human: true
`;

const ACTIONS: LaissoConfig["actions"] = {
  check: { run: 'sh "$(dirname "$(command -v laisso)")/check.sh"' },
  branchy: { params: ["branch"], run: "exit 0" },
};

async function laissoWith(pipeline = WAIT, extra: LaissoConfig = {}) {
  const { laisso } = await startLaissoWithRepos({ app: { pipeline: "work" } }, { actions: ACTIONS, ...extra }, { work: pipeline });
  running.push(laisso);
  await writeFile(path.join(laisso.pathDir, "laisso"), `#!/bin/sh\nexec '${process.execPath}' '${BIN}' --port ${laisso.port} "$@"\n`, { mode: 0o755 });
  await laisso.runner.script({ stdout: claudeFixture("success.json") });
  return laisso;
}

/** check.sh: run n does the n-th script, counting from 1; past the last it does nothing, and so is met. */
const check = (laisso: Laisso, ...runs: string[]) =>
  writeFile(
    path.join(laisso.pathDir, "check.sh"),
    `dir=$(dirname "$(command -v laisso)")\nn=$(( $(cat "$dir/check-count" 2>/dev/null || echo 0) + 1 ))\necho $n > "$dir/check-count"\ncase $n in\n${runs.map((r, i) => `${i + 1}) ${r} ;;`).join("\n")}\nesac\n`,
  );
/** check.sh is met once the returned file exists, and not met ("CI is still red") until then; every run counts. */
async function gated(laisso: Laisso): Promise<string> {
  const green = path.join(laisso.pathDir, "green");
  await writeFile(
    path.join(laisso.pathDir, "check.sh"),
    `dir=$(dirname "$(command -v laisso)")\necho $(( $(cat "$dir/check-count" 2>/dev/null || echo 0) + 1 )) > "$dir/check-count"\n[ -f "${green}" ] || { echo "CI is still red"; exit 1; }\n`,
  );
  return green;
}
const runsOf = async (laisso: Laisso) => Number((await readFile(path.join(laisso.pathDir, "check-count"), "utf8").catch(() => "0")).trim());
const notMet = (n: number, line = "CI is still red") => Array.from({ length: n }, () => `echo "${line}"; exit 1`);

const json = (body: unknown) => JSON.stringify(body);
const add = (laisso: Laisso, input = "Add dark mode") => laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input, repo: "app", pipeline: "work" }) });
const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (laisso: Laisso, id: string, lever: string, body: unknown = {}) => laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: json(body) });

/** Tick until the Ticket stands at `stage` (or is Flagged), with nothing running. */
const at = (laisso: Laisso, id: string, stage: string) =>
  waitFor(async () => {
    await checkNow(laisso);
    const d = await detailOf(laisso, id);
    return !d.sessions.some((s) => s.running) && (d.flag || d.stage.name === stage) ? d : null;
  }, `the Ticket to reach ${stage}`, 20_000);

interface Visit {
  id: number;
  stage: string;
  arrived_by: string;
  route: string | null;
  chosen_by: string | null;
  note: string | null;
  skipped_at: string | null;
  check_result: string | null;
}

function visitsOf(laisso: Laisso, ticket: string): Visit[] {
  const db = new DatabaseSync(path.join(laisso.home, "laisso.db"));
  try {
    return db.prepare(`SELECT id, stage, arrived_by, route, chosen_by, note, skipped_at, check_result FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as Visit[];
  } finally {
    db.close();
  }
}

describe("the wait Stage rules", () => {
  const withWait = (fields: string) => `stages:\n  - name: implement\n    prompt: Do the work.\n  - ${fields.replace(/\n/g, "\n    ")}\n  - name: ship\n    prompt: Ship it.\n    human: true\n`;
  const BAD: Array<[string, RegExp]> = [
    ["wait: action check", /a wait Stage needs a name of lowercase letters, digits, and hyphens/],
    ["name: ci\nwait: action nope", /nope/],
    ["name: ci\nwait: pr", /wait must name a check Action, as action <name> or \{ action, with \}/],
    ["name: ci\nwait: action check\nprompt: Look.", /prompt is not a field of a wait Stage; it allows only name, wait, routes, budget and advance/],
    ["name: ci\nwait: action check\nhuman: true", /human is not a field of a wait Stage/],
    ["name: ci\nwait: action check\nbudget: { rounds: 2 }", /budget.rounds does not apply to a wait Stage; it allows only wallTime/],
    ["name: ci\nwait: action check\nbudget: { wallTime: soon }", /is not a duration/],
    ["name: ci\nwait: action check\nadvance: maybe", /advance must be true or false/],
    ["name: ci\nwait: { action: check, with: { colour: red } }", /colour/],
  ];

  it("refuses a dashboard save that breaks a rule, and saves the forms it allows", async () => {
    const laisso = await laissoWith();
    for (const [fields, problem] of BAD) {
      await expect(laisso.api("/api/pipelines/work", { method: "PUT", body: json({ text: withWait(fields) }) })).rejects.toThrow(problem);
    }
    expect(await readFile(path.join(laisso.home, "pipelines", "work.yaml"), "utf8")).toBe(WAIT);

    const good = withWait("name: ci\nwait: { action: branchy, with: { branch: main } }\nbudget: { wallTime: 2h }\nadvance: false\nroutes:\n  back: { to: implement }");
    const saved = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PUT", body: json({ text: good }) });
    expect(saved.pipeline!.stages[1]).toEqual({ kind: "wait", name: "ci", label: "ci", wait: "action branchy", waitWith: { branch: "main" }, advance: false, budget: { wallTime: "2h" }, routes: { back: { to: "implement" } } });
  });

  it("reports a hand-written file that breaks a rule when it loads, and Intake refuses it", async () => {
    const laisso = await laissoWith();
    await writeFile(path.join(laisso.home, "pipelines", "work.yaml"), withWait(BAD[3]![0]));
    const listing = await laisso.api<PipelineListing[]>("/api/pipelines");
    expect(listing.find((p) => p.name === "work")).toMatchObject({ stages: [], problem: expect.stringMatching(BAD[3]![1]) });
    await expect(add(laisso)).rejects.toThrow(BAD[3]![1]);
  });
});

describe("a wait Stage", () => {
  it("keeps Watching while its check is not met, holding no slot and raising nothing, then walks on once met", async () => {
    const laisso = await laissoWith(WAIT, { concurrency: 1 });
    const green = await gated(laisso);
    const ticket = await add(laisso);
    const fresh = await at(laisso, ticket.id, "ci");
    expect(fresh.flag).toBeNull();
    expect(fresh.display).toMatchObject({ state: "watching", label: "Watching" });
    expect(fresh.queue).toBeNull();
    expect(fresh.triggers.map((t) => t.action)).toEqual(["check", "skip", "abandon"]);
    const before = (await laisso.notifications()).length;

    // Each Tick runs the check once more; not met, the Ticket stays put with the check's line as its why.
    await waitFor(async () => ((await runsOf(laisso)) >= 2 ? true : (await checkNow(laisso), null)), "two checks");
    const watching = await detailOf(laisso, ticket.id);
    expect(watching.stage.name).toBe("ci");
    expect(watching.display.state).toBe("watching");
    expect(watching.display.why).toMatch(/^CI is still red · checked \d\d:\d\d$/);
    expect(watching.check).toMatchObject({ action: "check", result: "not_met", line: "CI is still red" });

    // Watching holds no slot: with a cap of one, another Ticket's Session still runs.
    const other = await add(laisso, "Add light mode");
    const started = await waitFor(async () => {
      await checkNow(laisso);
      const d = await detailOf(laisso, other.id);
      return d.sessions.length > 0 ? d : null;
    }, "the other Ticket to start");
    expect(started.queue).toBeNull();
    expect(await laisso.notifications()).toHaveLength(before);

    // Met: the Ticket walks on to ship.
    await writeFile(green, "");
    const shipped = await at(laisso, ticket.id, "ship");
    expect(shipped.flag).toBeNull();
    const visits = visitsOf(laisso, ticket.id);
    expect(visits.map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["ci", "walk"], ["ship", "walk"]]);
    expect(JSON.parse(visits[1]!.check_result!)).toMatchObject({ action: "check", result: "met" });
  });

  it("takes the Route a met check picked", async () => {
    const laisso = await laissoWith();
    await check(laisso, 'laisso route back --note "lint failed"; echo "red"', 'echo "green"');
    const ticket = await add(laisso);
    const shipped = await at(laisso, ticket.id, "ship");
    expect(shipped.flag).toBeNull();
    const visits = visitsOf(laisso, ticket.id);
    expect(visits.map((v) => v.stage)).toEqual(["implement", "ci", "implement", "ci", "ship"]);
    expect(visits[2]).toMatchObject({ arrived_by: "route", route: "back", chosen_by: "check", note: "lint failed" });
    const prompts = (await laisso.runner.calls()).map((c) => c.argv.join("\n"));
    expect(prompts[1]).toContain("Do the work.\n\nFix what CI found.");
  });

  it("holds after a met check when advance is false", async () => {
    const laisso = await laissoWith(WAIT.replace("wait: action check\n", "wait: action check\n    advance: false\n"));
    await check(laisso);
    const ticket = await add(laisso);
    const holding = await waitFor(async () => {
      await checkNow(laisso);
      const d = await detailOf(laisso, ticket.id);
      return d.display.state === "holding" ? d : null;
    }, "ci to hold");
    expect(holding.triggers.map((t) => t.action)).toEqual(["start", "skip", "abandon"]);
  });

  it("holds before the Route its check picked when advance is false; Start takes it, Skip declines it", async () => {
    const HOLDS = WAIT.replace("wait: action check\n", "wait: action check\n    advance: false\n");
    const holdAt = (laisso: Laisso, id: string) =>
      waitFor(async () => {
        await checkNow(laisso);
        const d = await detailOf(laisso, id);
        return d.display.state === "holding" ? d : null;
      }, "ci to hold");

    for (const lever of ["start", "skip"] as const) {
      const laisso = await laissoWith(HOLDS);
      await check(laisso, 'laisso route back --note "lint failed"', ...notMet(20));
      const ticket = await add(laisso);
      const held = await holdAt(laisso, ticket.id);
      expect(held).toMatchObject({ stage: { name: "ci" }, display: { why: "Start implement via back when ready" } });
      expect(held.triggers.map((t) => t.label)).toEqual(["Start implement via back", "Skip ci", "Abandon"]);

      const pulled = await pull(laisso, ticket.id, lever);
      const visits = visitsOf(laisso, ticket.id);
      if (lever === "start") {
        expect(visits[2]).toMatchObject({ stage: "implement", arrived_by: "route", route: "back", chosen_by: "check", note: "lint failed" });
      } else {
        // Skip walks on as if met, taking no Route, and does not hold again.
        expect(pulled).toMatchObject({ stage: { name: "ship" }, display: { state: "needs_you" } });
        expect(visits.map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["ci", "walk"], ["ship", "walk"]]);
      }
    }
  });

  it("Flags artifact.error when its check breaks, and Retry Watches again", async () => {
    const laisso = await laissoWith();
    await check(laisso, 'echo "no credentials"; exit 3');
    const ticket = await add(laisso);
    const flagged = await at(laisso, ticket.id, "ci");
    expect(flagged.flag).toMatchObject({ reason: "artifact.error", detail: "action check: check exited 3: no credentials" });
    expect(flagged.triggers.map((t) => t.action)).toEqual(["retry", "extend", "skip", "abandon"]);
    // Flagged, the check does not run on the Tick.
    await checkNow(laisso);
    expect(await runsOf(laisso)).toBe(1);

    await pull(laisso, ticket.id, "retry");
    expect((await at(laisso, ticket.id, "ship")).flag).toBeNull();
    expect(await runsOf(laisso)).toBe(2);
  });

  it("Flags budget.wall_time when it Watches past its wallTime", async () => {
    const laisso = await laissoWith(WAIT.replace("wait: action check\n", "wait: action check\n    budget: { wallTime: 1s }\n"));
    await check(laisso, ...notMet(50));
    const ticket = await add(laisso);
    const flagged = await waitFor(async () => {
      await checkNow(laisso);
      const d = await detailOf(laisso, ticket.id);
      return d.flag ? d : null;
    }, "the wall time to run out", 20_000);
    expect(flagged.stage.name).toBe("ci");
    expect(flagged.flag).toMatchObject({ reason: "budget.wall_time", detail: "ci: action check not met within 1s" });
  });

  it("Skips as if met without taking a Route, and refuses Mark done", async () => {
    const laisso = await laissoWith();
    await check(laisso, 'laisso route back; echo "red"; exit 1', ...notMet(20));
    const ticket = await add(laisso);
    await at(laisso, ticket.id, "ci");
    await expect(pull(laisso, ticket.id, "done")).rejects.toThrow("ci is a wait Stage; it has no Mark done. Skip advances it as if its check were met");

    const skipped = await pull(laisso, ticket.id, "skip");
    expect(skipped.stage.name).toBe("ship");
    const visits = visitsOf(laisso, ticket.id);
    expect(visits.map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["ci", "walk"], ["ship", "walk"]]);
    expect(visits[1]!.skipped_at).not.toBeNull();
  });
});

describe("Send to Stage with a wait Stage", () => {
  const send = (laisso: Laisso, id: string, body: Record<string, unknown>) => pull(laisso, id, "send", body);

  it("sends a Ticket into a wait Stage and out of one", async () => {
    const laisso = await laissoWith();
    const green = await gated(laisso);
    const ticket = await add(laisso);
    await at(laisso, ticket.id, "ci");
    // Out of a wait Stage: back to implement, which runs and walks on to ci again, Watching there.
    await send(laisso, ticket.id, { stage: "implement", instructions: "Fix the flaky test." });
    await waitFor(async () => {
      await checkNow(laisso);
      return visitsOf(laisso, ticket.id).length === 4 ? true : null;
    }, "implement to walk on to ci");
    expect((await laisso.runner.calls()).length).toBe(2);
    expect((await detailOf(laisso, ticket.id)).display.state).toBe("watching");
    // Met, it goes on to ship; sent back into ci from there, it Watches again and, still met, returns.
    await writeFile(green, "");
    await at(laisso, ticket.id, "ship");
    await send(laisso, ticket.id, { stage: "ci" });
    await at(laisso, ticket.id, "ship");
    expect(visitsOf(laisso, ticket.id).map((v) => [v.stage, v.arrived_by])).toEqual([
      ["implement", "intake"],
      ["ci", "walk"],
      ["implement", "send"],
      ["ci", "walk"],
      ["ship", "walk"],
      ["ci", "send"],
      ["ship", "walk"],
    ]);
  });

  it("keeps a check's result on the Visit it ran for when the Ticket is sent mid-run", async () => {
    const laisso = await laissoWith();
    const release = path.join(laisso.pathDir, "release");
    const started = path.join(laisso.pathDir, "started");
    await check(laisso, `touch "${started}"; while [ ! -f "${release}" ]; do sleep 0.1; done; echo "green at last"`, ...notMet(20));
    const ticket = await add(laisso);
    // The check blocks the Tick that runs it, so nothing here waits on a Tick until it is released.
    const ticks: Array<Promise<unknown>> = [];
    await waitFor(async () => {
      if (await access(started).then(() => true, () => false)) return true;
      if (ticks.length < 200) ticks.push(checkNow(laisso));
      return null;
    }, "the check to start");

    // Sent back into ci while its check runs: the new Visit is there before the check ends.
    const sent = send(laisso, ticket.id, { stage: "ci", instructions: "Look again." });
    await waitFor(async () => (visitsOf(laisso, ticket.id).length === 3 ? true : null), "the send to land");
    await writeFile(release, "");
    await Promise.all([sent, ...ticks]);

    const detail = await detailOf(laisso, ticket.id);
    expect(detail.stage.name).toBe("ci");
    const visits = visitsOf(laisso, ticket.id);
    expect(visits.map((v) => [v.stage, v.arrived_by])).toEqual([["implement", "intake"], ["ci", "walk"], ["ci", "send"]]);
    expect(JSON.parse(visits[1]!.check_result!)).toMatchObject({ result: "met", line: "green at last" });
    expect(visits[2]!.check_result).toBeNull();
    expect(detail.display.why).toBe("action check: not checked yet");
  });
});

