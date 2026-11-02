import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLaissoWithRepos, runCli, waitFor, claudeFixture, runnerFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult, PipelineListing, PipelineFile } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// An opted-in agent chooses a Route (LASSO-193): a Runner Stage with `agentRoutes: true` lists its Routes in the
// preamble, its agent runs `laisso route` from inside the Session, and the pick is taken only when the Session ends
// as one that would otherwise advance. The fakes on PATH stand in for each Runner and Terminal.app.
const running: Laisso[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const BIN = path.join(import.meta.dirname, "..", "bin", "laisso.js");

const WORK = `stages:
  - name: implement
    prompt: Do the work.
    routes:
      again: { to: implement }
  - name: review
    prompt: Review the work.
    agentRoutes: true
    routes:
      fix:
        to: implement
        when: The work has a fault to fix.
        append: Fix what review found.
        budget: 1
      ship: { to: ship }
  - name: polish
    prompt: Polish.
    human: true
  - name: ship
    prompt: Ship it.
    human: true
`;

const PROFILES: LaissoConfig["profiles"] = { claude: { runner: "claude" }, codex: { runner: "codex" }, pi: { runner: "pi" } };
const SUCCESS = { claude: claudeFixture("success.json"), codex: runnerFixture("codex", "success.jsonl"), pi: runnerFixture("pi", "success.jsonl") };

async function laissoWith(pipelines: Record<string, string> = { work: WORK }, env?: Record<string, string>) {
  const repos = Object.fromEntries(Object.keys(pipelines).map((name) => [name, { pipeline: name }]));
  const { laisso } = await startLaissoWithRepos(repos, { profiles: PROFILES }, pipelines, env);
  running.push(laisso);
  // `laisso` inside a Session is this checkout's CLI, talking to this server.
  await writeFile(path.join(laisso.pathDir, "laisso"), `#!/bin/sh\nexec '${process.execPath}' '${BIN}' --port ${laisso.port} "$@"\n`, { mode: 0o755 });
  return laisso;
}

/**
 * What the fake agent does in each Session: run n of a Stage does the n-th line given for it (counting from 1),
 * past the last nothing. What `laisso route` prints, and its exit code, go to calls.txt beside the shim.
 */
async function agent(laisso: Laisso, byStage: Record<string, string[]>, stdout: { stdout?: string; stdoutByRunner?: Record<string, string> } = { stdoutByRunner: SUCCESS }) {
  const cases = Object.entries(byStage).map(([stage, runs]) => `${stage}) case $n in\n${runs.map((r, i) => `${i + 1}) ${r} ;;`).join("\n")}\nesac ;;`);
  const file = path.join(laisso.pathDir, "agent.sh");
  await writeFile(
    file,
    `dir=$(dirname "$(command -v laisso)")\nn=$(( $(cat "$dir/count-$LAISSO_STAGE" 2>/dev/null || echo 0) + 1 ))\necho $n > "$dir/count-$LAISSO_STAGE"\nroute() { laisso route "$@" >> "$dir/calls.txt" 2>&1; echo "exit $?" >> "$dir/calls.txt"; }\ncase $LAISSO_STAGE in\n${cases.join("\n")}\nesac\n`,
  );
  await laisso.runner.script({ ...stdout, commands: [["sh", file]] });
}

const json = (body: unknown) => JSON.stringify(body);
const add = (laisso: Laisso, repo = "work") => laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input: "Add dark mode", repo, pipeline: repo }) });
const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (laisso: Laisso, id: string, lever: string, body: object = {}) => laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: json(body) });
const callsOf = async (laisso: Laisso) => readFile(path.join(laisso.pathDir, "calls.txt"), "utf8").catch(() => "");
/** Each launch's argv as one text, the prompt in it wherever the Runner takes it. */
const prompts = async (laisso: Laisso) => (await laisso.runner.calls()).map((c) => c.argv.join("\n"));

/** Tick until the Ticket rests: at a human Stage, or Flagged, with nothing running. */
const rested = (laisso: Laisso, id: string) =>
  waitFor(async () => {
    await checkNow(laisso);
    const d = await detailOf(laisso, id);
    return !d.sessions.some((s) => s.running) && (d.flag || d.stage.name === "polish" || d.stage.name === "ship") ? d : null;
  }, "the Ticket to rest", 20_000);

interface Visit {
  stage: string;
  arrived_by: string;
  route: string | null;
  chosen_by: string | null;
  text: string | null;
  note: string | null;
  picked_route: string | null;
  picked_note: string | null;
  picked_by: string | null;
}

function visitsOf(laisso: Laisso, ticket: string): Visit[] {
  const db = new DatabaseSync(path.join(laisso.home, "laisso.db"));
  try {
    return db.prepare(`SELECT stage, arrived_by, route, chosen_by, text, note, picked_route, picked_note, picked_by FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as Visit[];
  } finally {
    db.close();
  }
}

const NO_CALL = "With no call, the Ticket continues to the next Stage as usual.";
const block = (fix: string, ship = "used 0/3") =>
  [
    "This Stage lets you choose a Route, which sends the Ticket to another Stage instead of the next one:",
    `- fix -> implement (${fix}): The work has a fault to fix.`,
    `- ship -> ship (${ship})`,
    `To choose one, run \`laisso route <name> [--note "..."]\` before you finish; the note goes with the Ticket to say why. The last call wins, and \`laisso route --clear\` drops your choice. ${NO_CALL} Laisso takes the Route only if this Stage finishes with its work done.`,
  ].join("\n");

describe("agentRoutes validation", () => {
  const BAD: Array<[string, string, RegExp]> = [
    ["without routes", "  - name: review\n    prompt: Review.\n    agentRoutes: true\n", /stage 1: agentRoutes needs routes for the agent to choose from/],
    ["on an action Stage", "  - action: gate\n    agentRoutes: true\n    routes:\n      back: { to: gate }\n", /stage 1: agentRoutes belongs to a Runner Stage/],
    ["that is not true or false", "  - name: review\n    prompt: Review.\n    agentRoutes: yes please\n    routes:\n      back: { to: review }\n", /stage 1: agentRoutes must be true or false/],
  ];
  const pipeline = (stage: string) => `stages:\n${stage}`;

  it("refuses a dashboard save, reports a hand-written file when it loads, and Intake takes no Version of it", async () => {
    const laisso = await laissoWith();
    for (const [what, stage, problem] of BAD) {
      await expect(laisso.api("/api/pipelines/work", { method: "PUT", body: json({ text: pipeline(stage) }) }), what).rejects.toThrow(problem);
    }
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { agentRoutes: true, routes: null } } }) })).rejects.toThrow(/agentRoutes needs routes/);
    expect(await readFile(path.join(laisso.home, "pipelines", "work.yaml"), "utf8")).toBe(WORK);

    for (const [what, stage, problem] of BAD) {
      await writeFile(path.join(laisso.home, "pipelines", "work.yaml"), pipeline(stage));
      const listing = await laisso.api<PipelineListing[]>("/api/pipelines");
      expect(listing.find((p) => p.name === "work")?.problem, what).toMatch(problem);
      await expect(add(laisso), what).rejects.toThrow(problem);
    }
  });

  it("saves on a Runner Stage with routes, human ones included, and leaves it out where it is not written", async () => {
    const laisso = await laissoWith();
    const saved = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PUT", body: json({ text: WORK.replace("    human: true\n", "    human: true\n    agentRoutes: true\n    routes:\n      back: { to: review }\n") }) });
    expect(saved.pipeline!.stages.map((s) => (s.kind === "runner" ? (s.agentRoutes ?? null) : null))).toEqual([null, true, true, null]);
  });
});

describe("an opted-in agent that picks a Route", () => {
  it("lists the Routes with counts, takes the pick when the Session succeeds, and Flags budget.routes for a spent one", async () => {
    const laisso = await laissoWith();
    await agent(laisso, { implement: ["route again", ""], review: ['route fix --note "tests fail"', "route fix"] });
    const ticket = await add(laisso);
    const detail = await rested(laisso, ticket.id);
    expect(detail.flag).toMatchObject({ reason: "budget.routes", detail: "Route fix to implement: 1 of 1 used; Extend to take it" });
    expect(detail.stage.name).toBe("review");

    // implement does not opt in: its agent's call is refused, while review's spent pick is still accepted.
    expect(await callsOf(laisso)).toBe("Stage implement does not let its agent choose a Route\nexit 1\npicked Route fix to implement: tests fail\nexit 0\npicked Route fix to implement\nexit 0\n");
    const visits = visitsOf(laisso, ticket.id);
    expect(visits.map((v) => v.stage)).toEqual(["implement", "review", "implement", "review"]);
    expect(visits[2]).toMatchObject({ arrived_by: "route", route: "fix", chosen_by: "agent", text: "Fix what review found.", note: "tests fail" });
    expect(visits[3]).toMatchObject({ picked_route: "fix", picked_by: "agent" });

    // Only review's prompt carries the block; the second shows fix spent, still listed.
    const [implement1, review1, implement2, review2] = await prompts(laisso);
    expect(implement1).not.toContain("laisso route");
    expect(review1).toContain(`Review the work.`);
    expect(review1).toContain(block("used 0/1"));
    expect(implement2).toContain("Do the work.\n\nFix what review found.\n\nLaisso sent this Ticket here by Route fix, chosen by the agent, with this note: tests fail");
    expect(review2).toContain(block("used 1/1: choosing it Flags the Ticket for a human"));

    // Extend takes the pending Route as the agent's.
    await pull(laisso, ticket.id, "extend", { routes: 2 });
    await waitFor(async () => (visitsOf(laisso, ticket.id).length === 5 ? true : null), "the pending Route");
    expect(visitsOf(laisso, ticket.id)[4]).toMatchObject({ stage: "implement", route: "fix", chosen_by: "agent" });
  });

  it("walks forward with no call, and after --clear", async () => {
    const laisso = await laissoWith();
    await agent(laisso, { review: ["route ship; route --clear"] });
    const ticket = await add(laisso);
    const detail = await rested(laisso, ticket.id);
    expect(detail.flag).toBeNull();
    expect(detail.stage.name).toBe("polish");
    expect(visitsOf(laisso, ticket.id).map((v) => [v.stage, v.arrived_by, v.picked_route])).toEqual([["implement", "intake", null], ["review", "walk", null], ["polish", "walk", null]]);
  });

  it("Flags a failed Session without routing, and a retry picks afresh", async () => {
    const laisso = await laissoWith({ work: EACH("claude") });
    await agent(laisso, { review: ['route ship --note "looks fine"'] }, { stdout: claudeFixture("failed.jsonl") });
    const ticket = await add(laisso);
    const flagged = await rested(laisso, ticket.id);
    expect(flagged.flag).toMatchObject({ reason: "outcome.failed" });
    expect(flagged.stage.name).toBe("review");
    expect(visitsOf(laisso, ticket.id)).toEqual([expect.objectContaining({ stage: "review", picked_route: "ship", picked_note: "looks fine", picked_by: "agent" })]);

    // The retry makes no call: the failed Session's pick is not its own, so the Ticket walks forward.
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    await pull(laisso, ticket.id, "retry");
    const detail = await waitFor(async () => { await checkNow(laisso); const d = await detailOf(laisso, ticket.id); return d.stage.name === "publish" ? d : null; }, "publish");
    expect(detail.flag).toBeNull();
    expect(visitsOf(laisso, ticket.id).map((v) => [v.stage, v.arrived_by, v.picked_route])).toEqual([["review", "intake", null], ["publish", "walk", null]]);
  });
});

// One Pipeline per Runner: review headless, then a human Stage worked in a terminal, both opted in.
const EACH = (profile: string) => `profile: ${profile}
stages:
  - name: review
    prompt: Review the work.
    skills: [code-review]
    agentRoutes: true
    routes:
      fix: { to: review, when: The work has a fault to fix. }
      ship: { to: ship }
  - name: publish
    prompt: Publish the review.
    human: true
    agentRoutes: true
    routes:
      fix: { to: review, when: The work has a fault to fix. }
      ship: { to: ship }
  - name: polish
    prompt: Polish.
    human: true
  - name: ship
    prompt: Ship it.
    human: true
`;

describe("each Runner", () => {
  it.each(["claude", "codex", "pi"])("%s carries the Route block headless and in a terminal, and the terminal pick pre-selects Mark done", async (runner) => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "laisso-codex-"));
    dirs.push(codexHome);
    const laisso = await laissoWith({ [runner]: EACH(runner) }, { CODEX_HOME: codexHome });
    await agent(laisso, { review: ["route publish"] });
    const ticket = await add(laisso, runner);
    // The first review asks for a Route the Stage lacks: refused, it makes no pick, so the Ticket walks on to publish.
    const atPublish = await waitFor(async () => { await checkNow(laisso); const d = await detailOf(laisso, ticket.id); return d.stage.name === "publish" && !d.sessions.some((s) => s.running) ? d : null; }, `${runner} to reach publish`, 20_000);
    expect(atPublish.flag).toBeNull();
    const call = (await laisso.runner.calls()).at(-1)!;
    expect(call.argv[0]).toBe(runner);
    expect(call.argv.join("\n")).toContain("- fix -> review (used 0/3): The work has a fault to fix.\n- ship -> ship (used 0/3)\n");
    expect(call.argv.join("\n")).toContain(NO_CALL);
    expect(await callsOf(laisso)).toBe("no Route named publish on Stage review; it has fix, ship\nexit 1\n");

    // In the terminal the human works publish; the agent there picks fix, which the Mark done menu pre-selects, and
    // the human confirms it: a human's choice (LASSO-198), so it never counts.
    const opened = await pull(laisso, ticket.id, "terminal");
    const launcher = readFileSync((await laisso.terminals()).at(-1)!.launcher!, "utf8");
    expect(launcher).toContain(`exec '${runner}'`);
    expect(launcher).toContain("- fix -> review (used 0/3): The work has a fault to fix.\n- ship -> ship (used 0/3)\n");
    const picked = await runCli(["route", "fix", "--note", "missed a case"], { ...laisso, env: { LAISSO_SESSION: opened.session!.id } });
    expect(picked).toMatchObject({ code: 0, stdout: "picked Route fix to review: missed a case\n" });
    expect((await detailOf(laisso, ticket.id)).markDone).toEqual({ routes: [{ name: "fix", to: "review", text: null, replaces: false }, { name: "ship", to: "ship", text: null, replaces: false }], suggested: { route: "fix", note: "missed a case" } });
    const done = await pull(laisso, ticket.id, "done", { route: "fix", note: "missed a case" });
    expect(done.stage.name).toBe("review");
    expect(visitsOf(laisso, ticket.id).at(-2)).toMatchObject({ stage: "publish", picked_route: "fix", picked_by: "agent" });
    expect(visitsOf(laisso, ticket.id).at(-1)).toMatchObject({ stage: "review", arrived_by: "route", route: "fix", chosen_by: "human", note: "missed a case" });
    // The routed review is told why; back at publish, the next terminal shows the human's lap uncounted.
    const routed = await waitFor(async () => { await checkNow(laisso); const d = await detailOf(laisso, ticket.id); return d.stage.name === "publish" && !d.sessions.some((s) => s.running) ? d : null; }, `${runner} back at publish`, 20_000);
    expect(routed.flag).toBeNull();
    expect((await laisso.runner.calls()).at(-1)!.argv.join("\n")).toContain("Review the work.\n\nLaisso sent this Ticket here by Route fix, chosen by a human, with this note: missed a case");
    await pull(laisso, ticket.id, "terminal");
    expect(readFileSync((await laisso.terminals()).at(-1)!.launcher!, "utf8")).toContain("- fix -> review (used 0/3): The work has a fault to fix.\n- ship -> ship (used 0/3)\n");
  });
});

describe("a terminal agent", () => {
  it("suggests a Route the human confirms on a Stage that says advance: false, which holds before it, and Start takes it", async () => {
    const laisso = await laissoWith({ work: EACH("claude").replace("    human: true\n    agentRoutes: true\n", "    human: true\n    advance: false\n    agentRoutes: true\n") });
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    const ticket = await add(laisso);
    await waitFor(async () => { await checkNow(laisso); return (await detailOf(laisso, ticket.id)).stage.name === "publish" ? true : null; }, "publish");
    const opened = await pull(laisso, ticket.id, "terminal");
    expect((await runCli(["route", "fix", "--note", "missed a case"], { ...laisso, env: { LAISSO_SESSION: opened.session!.id } })).code).toBe(0);
    const held = await pull(laisso, ticket.id, "done", { route: "fix", note: "missed a case" });
    expect(held).toMatchObject({ stage: { name: "publish" }, display: { state: "holding", why: "Start review via fix when ready" } });
    const started = await pull(laisso, ticket.id, "start");
    expect(started.stage.name).toBe("review");
    expect(visitsOf(laisso, ticket.id).at(-1)).toMatchObject({ stage: "review", arrived_by: "route", route: "fix", chosen_by: "human", note: "missed a case" });
  });

  it("suggests its pick in the Mark done menu on a taken-over Stage; Skip, and a Stage that does not opt in, walk", async () => {
    const laisso = await laissoWith({ work: EACH("claude") });
    await laisso.runner.script({ hang: true });
    const ticket = await add(laisso);
    await checkNow(laisso);
    const headless = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.session?.running ? d.session : null; }, "review to run");
    // The headless agent picks before it is taken over: the terminal re-enters its session, so the pick stays.
    expect((await runCli(["route", "ship"], { ...laisso, env: { LAISSO_SESSION: headless.id } })).code).toBe(0);
    const taken = await pull(laisso, ticket.id, "takeover");
    expect(visitsOf(laisso, ticket.id).at(-1)).toMatchObject({ picked_route: "ship", picked_by: "agent" });
    expect((await runCli(["route", "fix", "--note", "one more pass"], { ...laisso, env: { LAISSO_SESSION: taken.session!.id } })).code).toBe(0);
    await laisso.runner.script({ stdout: claudeFixture("success.json") });
    expect((await detailOf(laisso, ticket.id)).markDone?.suggested).toEqual({ route: "fix", note: "one more pass" });
    const done = await pull(laisso, ticket.id, "done", { route: "fix", note: "one more pass" });
    expect(done.stage.name).toBe("review");
    expect(visitsOf(laisso, ticket.id).at(-1)).toMatchObject({ arrived_by: "route", route: "fix", chosen_by: "human", note: "one more pass" });

    // At publish, a human Stage, Skip walks forward, leaving the terminal agent's pick unused.
    await waitFor(async () => { await checkNow(laisso); const d = await detailOf(laisso, ticket.id); return d.stage.name === "publish" ? d : null; }, "publish");
    const first = await pull(laisso, ticket.id, "terminal");
    expect((await runCli(["route", "ship"], { ...laisso, env: { LAISSO_SESSION: first.session!.id } })).code).toBe(0);
    await pull(laisso, ticket.id, "skip");
    expect(visitsOf(laisso, ticket.id).at(-2)).toMatchObject({ stage: "publish", picked_route: "ship", picked_by: "agent" });
    // polish does not opt in: its agent is refused, and Mark done walks forward.
    const polish = await pull(laisso, ticket.id, "terminal");
    expect((await runCli(["route", "ship"], { ...laisso, env: { LAISSO_SESSION: polish.session!.id } })).stderr).toBe("Stage polish does not let its agent choose a Route\n");
    const walked = await pull(laisso, ticket.id, "done");
    expect(walked.stage.name).toBe("ship");
    expect(visitsOf(laisso, ticket.id).map((v) => [v.stage, v.arrived_by])).toEqual([
      ["review", "intake"],
      ["review", "route"],
      ["publish", "walk"],
      ["polish", "walk"],
      ["ship", "walk"],
    ]);
  });
});
