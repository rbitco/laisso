import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLassoWithRepos, waitFor, claudeFixture, type Lasso, type LassoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";
import { PR_URL, setScene, sceneFile, marker, type Scene } from "./scenes.ts";

// Routes and Review Rounds together (LASSO-200): a Round whose agent picks a Route leaves the repeating Stage at
// once, what it left standing is owed by the next Visit's first Round, and arriving by Route (or a human's send)
// starts a Round at once. The gh shim plays the PR; the fake agent swaps scenes and runs `lasso route`.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const BIN = path.join(import.meta.dirname, "..", "bin", "lasso.js");

const LOOP = `stages:
  - name: implement
    prompt: Do the work.
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
    agentRoutes: true
    budget: { rounds: 1 }
    routes:
      rework:
        to: implement
        when: The Feedback needs a bigger change than a Round can make.
        append: Rework what review found.
  - name: ship
    prompt: Ship it.
    human: true
`;

/** implement picks a Route into review, whose end condition is a check Action that runs after each Round. */
const RECHECK = (artifact: string) => `stages:
  - name: implement
    prompt: Do the work.
    agentRoutes: true
    routes:
      recheck:
        to: review
        append: This is a re-review. Check each earlier finding is fixed.
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: ${artifact}
  - name: ship
    prompt: Ship it.
    human: true
`;

const CHECKED = `
      action: grep-file
      with: { file: REVIEWED, pattern: "yes" }`;

const GREP: LassoConfig["actions"] = {
  "grep-file": { params: ["file", "pattern"], run: 'if grep -q "$LASSO_PATTERN" "$LASSO_FILE" 2>/dev/null; then echo "found"; else echo "no $LASSO_PATTERN in $LASSO_FILE"; exit 1; fi' },
};

async function lassoWith(pipeline: string) {
  const { lasso } = await startLassoWithRepos({ app: { pipeline: "work" } }, { actions: GREP }, { work: pipeline });
  running.push(lasso);
  await writeFile(path.join(lasso.pathDir, "lasso"), `#!/bin/sh\nexec '${process.execPath}' '${BIN}' --port ${lasso.port} "$@"\n`, { mode: 0o755 });
  return lasso;
}

/** Run n of a Stage does the n-th line given for it; past the last, nothing. `scene <name>` makes the PR play that scene. */
async function agent(lasso: Lasso, byStage: Record<string, string[]>) {
  const cases = Object.entries(byStage).map(([stage, runs]) => `${stage}) case $n in\n${runs.map((r, i) => `${i + 1}) ${r} ;;`).join("\n")}\nesac ;;`);
  const file = path.join(lasso.pathDir, "agent.sh");
  await writeFile(
    file,
    `dir=$(dirname "$(command -v lasso)")\nn=$(( $(cat "$dir/count-$LASSO_STAGE" 2>/dev/null || echo 0) + 1 ))\necho $n > "$dir/count-$LASSO_STAGE"\nroute() { lasso route "$@" >> "$dir/calls.txt" 2>&1; }\nscene() { cp "$dir/scene-$1.json" "$dir/tracker-replies.json"; }\ncase $LASSO_STAGE in\n${cases.join("\n")}\nesac\n`,
  );
  await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["sh", file]] });
}

const add = (lasso: Lasso) => lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "work" }) });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pull = (lasso: Lasso, id: string, lever: string, body: object = {}) => lasso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: JSON.stringify(body) });
const prompts = async (lasso: Lasso) => (await lasso.runner.calls()).map((c) => c.argv.join("\n"));

/** Tick until the Ticket has had `count` Sessions, none running, or rests at ship, or is Flagged. */
const settled = (lasso: Lasso, id: string, count: number) =>
  waitFor(async () => {
    await checkNow(lasso);
    const d = await detailOf(lasso, id);
    if (d.sessions.some((s) => s.running)) return null;
    return d.flag || d.stage.name === "ship" || d.sessions.length >= count ? d : null;
  }, `${count} Sessions to end`, 20_000);

const flagged = (lasso: Lasso, id: string) =>
  waitFor(async () => {
    await checkNow(lasso);
    const d = await detailOf(lasso, id);
    return d.flag ? d : null;
  }, "the Flag", 20_000);

function visitsOf(lasso: Lasso, ticket: string): Array<{ stage: string; arrived_by: string; route: string | null; picked_route: string | null; check_result: string | null }> {
  const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
  try {
    return db.prepare(`SELECT stage, arrived_by, route, picked_route, check_result FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as never;
  } finally {
    db.close();
  }
}

const T1 = "2026-10-20T10:05:00Z";
const T1b = "2026-10-20T10:06:00Z";
const T2 = "2026-10-20T10:10:00Z";
const T3 = "2026-10-20T11:00:00Z";

const green: Scene = { tag: "green", checks: [{ id: 1, name: "test", status: "completed", conclusion: "success", at: T1 }] };

describe("a routing Round", () => {
  it("leaves at once, keeps the watermark while away, and owes what it left standing to the next Visit's first Round", async () => {
    const lasso = await lassoWith(LOOP);
    const ticket = await add(lasso);
    const asked: Scene = { ...green, tag: "asked", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }, { id: 203, author: "carol", body: "Split the module.", at: T1b }] };
    // Round 1 answers bob, then routes back for the split, leaving carol's comment standing.
    const partly: Scene = { ...asked, tag: "partly", comments: [...asked.comments!, { id: 202, author: "lasso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    // While the Ticket is away at implement, dave comments.
    const away: Scene = { ...partly, tag: "away", comments: [...partly.comments!, { id: 204, author: "dave", body: "Also update the docs.", at: T3 }] };
    await setScene(lasso, ticket.branch, asked);
    await sceneFile(lasso, ticket.branch, "partly", partly);
    await sceneFile(lasso, ticket.branch, "away", away);
    const mark2 = marker(ticket.id, 2);
    await sceneFile(lasso, ticket.branch, "done", { ...away, tag: "done", comments: [...away.comments!, { id: 205, author: "lasso-bot", body: `Split.\n${mark2}`, at: "2026-10-20T12:00:00Z" }, { id: 206, author: "lasso-bot", body: `Updated.\n${mark2}`, at: "2026-10-20T12:01:00Z" }] });
    await agent(lasso, { implement: ["", "scene away"], review: ['scene partly; route rework --note "the module needs splitting first"', "scene done"] });

    const d = await settled(lasso, ticket.id, 4);
    expect(d.flag).toBeNull();
    expect(visitsOf(lasso, ticket.id).map((v) => [v.stage, v.arrived_by, v.route, v.picked_route])).toEqual([
      ["implement", "intake", null, null],
      ["review", "walk", null, "rework"],
      ["implement", "route", "rework", null],
      ["review", "walk", null, null],
    ]);

    // Round 1 recorded what it addressed and left without the addressed-all check: carol's comment stood.
    const rounds = d.sessions.filter((s) => s.stage === "review").reverse();
    expect(rounds.map((s) => [s.round, s.outcome])).toEqual([[1, "succeeded"], [2, "succeeded"]]);
    expect(rounds[0]!.feedback.map((f) => [f.id, f.addressed])).toEqual([["201", `replied ${PR_URL}#issuecomment-202`], ["203", null]]);

    const [, review1, implement2, review2] = await prompts(lasso);
    expect(review1).toContain("Round 1: 2 items.");
    expect(implement2).toContain("Do the work.\n\nRework what review found.\n\nLasso sent this Ticket here by Route rework, chosen by the agent, with this note: the module needs splitting first");
    // Back by walking forward, the Round starts on dave's comment, new since the watermark kept while away, and
    // carries carol's, which Round 1 owed. Its number runs on, and the Rounds cap of 1 is this Visit's own.
    expect(review2).toContain("Round 2: 2 items.");
    expect(review2).toContain("[comment 203] comment by carol");
    expect(review2).toContain("[comment 204] comment by dave");
    expect(review2).not.toContain("[comment 201]");
    expect(review2).toContain(marker(ticket.id, 2));
    expect(review2).not.toContain("Rework what review found.");
    expect(d.budget.rounds).toEqual({ used: 1, limit: 1, source: "pipeline" });
  });
});

describe("arriving at a repeating Stage", () => {
  it("by Route starts a Round at once with the Route's text and note and nothing new on the PR; the check runs after it", async () => {
    const lasso = await lassoWith(RECHECK(CHECKED));
    const ticket = await add(lasso);
    await setScene(lasso, ticket.branch, green);
    // The check would be met before the Round, so a Round that runs at all ran ahead of it.
    await agent(lasso, { implement: ['echo yes > REVIEWED; route recheck --note "look again at the cache"'] });

    const d = await settled(lasso, ticket.id, 2);
    expect(d.flag).toBeNull();
    expect(d.stage.name).toBe("ship");
    const visits = visitsOf(lasso, ticket.id);
    expect(visits.map((v) => [v.stage, v.arrived_by, v.route])).toEqual([["implement", "intake", null], ["review", "route", "recheck"], ["ship", "walk", null]]);
    expect(JSON.parse(visits[1]!.check_result!)).toMatchObject({ action: "grep-file", result: "met" });
    expect(d.sessions.find((s) => s.stage === "review")).toMatchObject({ round: 1, outcome: "succeeded" });

    const [, review] = await prompts(lasso);
    expect(review).toContain("Address the Feedback.\n\nThis is a re-review. Check each earlier finding is fixed.\n\nLasso sent this Ticket here by Route recheck, chosen by the agent, with this note: look again at the cache");
    expect(review).toContain("Round 1: 0 items.");
    expect(review).toContain("Nothing stands on the PR right now; work from the instructions above.");
  });

  it("by Route carries everything standing on the PR, seen before or not", async () => {
    const lasso = await lassoWith(RECHECK("pr-merged"));
    const ticket = await add(lasso);
    const standing: Scene = { ...green, tag: "standing", comments: [{ id: 201, author: "bob", body: "Rename this.", at: T1 }] };
    const replied: Scene = { ...standing, tag: "replied", comments: [...standing.comments!, { id: 202, author: "lasso-bot", body: `Renamed.\n${marker(ticket.id, 1)}`, at: T2 }] };
    await setScene(lasso, ticket.branch, standing);
    await sceneFile(lasso, ticket.branch, "replied", replied);
    await agent(lasso, { implement: ["route recheck"], review: ["scene replied"] });
    const d = await settled(lasso, ticket.id, 2);
    expect(d.flag).toBeNull();
    const [, review] = await prompts(lasso);
    expect(review).toContain("Round 1: 1 item.");
    expect(review).toContain("[comment 201] comment by bob");
  });

  it("by Route with no open Owned PR Flags route.no_open_pr, and a merged one does not finish the Stage instead", async () => {
    const lasso = await lassoWith(RECHECK("pr-merged"));
    const ticket = await add(lasso);
    await agent(lasso, { implement: ["route recheck", "route recheck"] });
    const none = await flagged(lasso, ticket.id);
    expect(none.stage.name).toBe("review");
    expect(none.flag).toMatchObject({ reason: "route.no_open_pr", detail: "review: arrived by Route recheck with no open Owned PR to work on" });

    // A merged PR is no PR to work on either; later ticks leave the Flag for a human.
    const other = await add(lasso);
    await setScene(lasso, other.branch, { ...green, tag: "merged", state: "MERGED" });
    const merged = await flagged(lasso, other.id);
    expect(merged.flag).toMatchObject({ reason: "route.no_open_pr" });
    await checkNow(lasso);
    const after = await detailOf(lasso, other.id);
    expect(after.stage.name).toBe("review");
    expect(after.flag).toMatchObject({ reason: "route.no_open_pr" });
    expect((await lasso.runner.calls()).length).toBe(2);

    // Once the first Ticket's PR is open, Retry starts its arrival Round at once, the Route's text with it.
    await setScene(lasso, ticket.branch, { ...green, number: 8 });
    await pull(lasso, ticket.id, "retry");
    const calls = await waitFor(async () => { const c = await lasso.runner.calls(); return c.length === 3 ? c : null; }, "the arrival Round");
    expect(calls[2]!.argv.join("\n")).toContain("This is a re-review. Check each earlier finding is fixed.");
    expect(calls[2]!.env).toMatchObject({ LASSO_STAGE: "review", LASSO_ROUND: "1" });
  });

  it("by a human's send starts a Round at once with the instructions", async () => {
    const lasso = await lassoWith(LOOP);
    const ticket = await add(lasso);
    await setScene(lasso, ticket.branch, green);
    await agent(lasso, {});
    await pull(lasso, ticket.id, "send", { stage: "review", instructions: "Check the docs too." });
    const [call] = await waitFor(async () => { const c = await lasso.runner.calls(); return c.length ? c : null; }, "the Round to start");
    const prompt = call!.argv.join("\n");
    expect(prompt).toContain("Address the Feedback.\n\nA human sent this Ticket here, with these instructions: Check the docs too.");
    expect(prompt).toContain("Round 1: 0 items.");
    const d = await settled(lasso, ticket.id, 1);
    expect(d.flag).toBeNull();
    expect(d.stage.name).toBe("review");
    expect(d.display.state).toBe("quiet");
  });

  it("by walking forward waits for new Feedback as before", async () => {
    const lasso = await lassoWith(LOOP);
    const ticket = await add(lasso);
    await setScene(lasso, ticket.branch, green);
    await agent(lasso, { implement: [""] });
    const d = await settled(lasso, ticket.id, 1);
    expect(d.stage.name).toBe("review");
    await checkNow(lasso);
    expect((await detailOf(lasso, ticket.id)).display.state).toBe("quiet");
    expect(await lasso.runner.calls()).toHaveLength(1);
  });
});
