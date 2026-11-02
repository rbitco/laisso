import { describe, it, expect, afterEach } from "vitest";
import { startLaissoWithRepos, runCli, type Laisso, type TrackerReply } from "./harness.ts";
import type { IntakeResult, TicketDetail } from "../src/api/views.ts";
import { checkArtifact, type OwnedPr } from "../src/artifact/check.ts";

// The pr-* Artifacts judge every Owned PR, and Referenced PRs never count (LASSO-166).
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const pr = (number: number, state: OwnedPr["state"], reviewed = false): OwnedPr => ({ number, state, reviewed });

const VERDICTS: Array<[string, string, OwnedPr[], string | null]> = [
  ["pr-exists with no Owned PR", "pr-exists", [], "no Owned PR for the Ticket"],
  ["pr-exists with one", "pr-exists", [pr(12, "OPEN")], null],
  ["pr-exists with several", "pr-exists", [pr(12, "OPEN"), pr(15, "MERGED")], null],
  ["pr-review with no Owned PR", "pr-review", [], "no Owned PR for the Ticket"],
  ["pr-review with one unreviewed", "pr-review", [pr(12, "OPEN")], "nobody has reviewed PR #12"],
  ["pr-review with one reviewed", "pr-review", [pr(12, "OPEN", true)], null],
  ["pr-review naming every unreviewed open PR", "pr-review", [pr(12, "OPEN"), pr(13, "OPEN", true), pr(15, "OPEN")], "nobody has reviewed PR #12, #15"],
  ["pr-review over merged and closed PRs, which need no review", "pr-review", [pr(12, "MERGED"), pr(15, "CLOSED"), pr(16, "OPEN", true)], null],
  ["pr-merged with no Owned PR", "pr-merged", [], "no Owned PR for the Ticket"],
  ["pr-merged with one open", "pr-merged", [pr(12, "OPEN", true)], "PR #12 not merged"],
  ["pr-merged with one merged", "pr-merged", [pr(12, "MERGED")], null],
  ["pr-merged naming every PR not merged, closed ones too", "pr-merged", [pr(12, "OPEN"), pr(13, "MERGED"), pr(15, "CLOSED")], "PR #12, #15 not merged"],
  ["pr-merged with several merged", "pr-merged", [pr(12, "MERGED"), pr(15, "MERGED")], null],
];

describe("a pr-* artifact over the Owned PRs", () => {
  it.each(VERDICTS)("%s", async (_name, artifact, owned, detail) => {
    const verdict = await checkArtifact(artifact, "/nowhere", async () => owned);
    expect(verdict).toEqual({ present: detail === null, detail });
  });
});

// Two human Stages: Mark done checks each one's Artifact with warn-and-override, and nothing launches.
const PIPELINE = `stages:
  - name: code-review
    human: true
    prompt: Review each Owned PR.
    artifact: pr-review
  - name: merge
    human: true
    prompt: Merge them.
    artifact: pr-merged
  - name: ship
    human: true
    prompt: Ship it.
`;

const url = (n: number) => `https://github.com/owner/app/pull/${n}`;

/** gh's answer to the lookup `laisso pr link` makes. */
const lookup = (n: number): TrackerReply => ({
  tool: "gh",
  match: ["pr view", url(n), "--json"],
  stdout: JSON.stringify({ number: n, url: url(n), title: `PR ${n}`, state: "OPEN", headRefName: `feat-${n}`, baseRefName: "main", author: { login: "alice" } }),
});

/** gh's answer to the GraphQL read of one PR: its state and whether it has a review. */
const read = (n: number, state: OwnedPr["state"], reviewed = false): TrackerReply => ({
  tool: "gh",
  match: ["api graphql", `n=${n}`],
  stdout: JSON.stringify({
    data: { repository: { pullRequest: { number: n, url: url(n), state, headRefOid: "aaaaaaa1", reviewDecision: null, reviewCount: { totalCount: reviewed ? 1 : 0 }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } } } },
  }),
});

/** A Ticket with these PRs linked: Owned unless listed in `referenced`. */
async function ticketWith(owned: number[], referenced: number[]) {
  const started = await startLaissoWithRepos({ app: { pipeline: "prs" } }, {}, { prs: PIPELINE });
  running.push(started.laisso);
  const { laisso } = started;
  const ticket = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "prs" }) });
  // After intake, which needs the real origin: bare PR numbers resolve against this one.
  started.repos.app!.git(["remote", "set-url", "origin", "https://github.com/owner/app.git"]);
  for (const n of [...owned, ...referenced]) await laisso.tracker.reply(lookup(n));
  for (const n of owned) expect((await runCli(["pr", "link", String(n), ticket.id], laisso)).code).toBe(0);
  for (const n of referenced) expect((await runCli(["pr", "link", String(n), ticket.id, "--referenced"], laisso)).code).toBe(0);
  // Every Referenced PR is open and unreviewed: it would block both Artifacts if it counted.
  for (const n of referenced) await laisso.tracker.reply(read(n, "OPEN"));
  return { laisso, ticket };
}

/** Mark done without override: the Stage it reached, or the warning's detail. */
async function markDone(laisso: Laisso, id: string): Promise<{ stage: string } | { detail: string }> {
  const res = await laisso.api<Response>(`/api/tickets/${id}/done`, { method: "POST", raw: true, body: "{}" });
  if (res.status === 409) return { detail: ((await res.json()) as { detail: string }).detail };
  return { stage: ((await res.json()) as TicketDetail).stage.name };
}

const readsOf = async (laisso: Laisso, n: number) => (await laisso.tracker.calls()).filter((c) => c.args.includes("graphql") && c.args.includes(`n=${n}`)).length;

describe("a Ticket's pr-* artifacts", () => {
  it("are missing with only a Referenced PR, and never read it", async () => {
    const { laisso, ticket } = await ticketWith([], [30]);
    expect(await markDone(laisso, ticket.id)).toEqual({ detail: "no Owned PR for the Ticket" });
    expect(await readsOf(laisso, 30)).toBe(0);
  });

  it("judge one Owned PR beside an open, unreviewed Referenced PR", async () => {
    const { laisso, ticket } = await ticketWith([12], [30]);
    await laisso.tracker.reply(read(12, "OPEN"));
    expect(await markDone(laisso, ticket.id)).toEqual({ detail: "nobody has reviewed PR #12" });

    await laisso.tracker.reply(read(12, "OPEN", true), true);
    expect(await markDone(laisso, ticket.id)).toEqual({ stage: "merge" });
    expect(await markDone(laisso, ticket.id)).toEqual({ detail: "PR #12 not merged" });

    await laisso.tracker.reply(read(12, "MERGED", true), true);
    expect(await markDone(laisso, ticket.id)).toEqual({ stage: "ship" });
    expect(await readsOf(laisso, 30)).toBe(0);
  });

  it("judge several Owned PRs, naming every one that falls short", async () => {
    const { laisso, ticket } = await ticketWith([12, 13, 15], [30]);
    await laisso.tracker.reply(read(12, "OPEN"));
    await laisso.tracker.reply(read(13, "MERGED"));
    await laisso.tracker.reply(read(15, "OPEN"));
    expect(await markDone(laisso, ticket.id)).toEqual({ detail: "nobody has reviewed PR #12, #15" });

    await laisso.tracker.reply(read(15, "OPEN", true), true);
    expect(await markDone(laisso, ticket.id)).toEqual({ detail: "nobody has reviewed PR #12" });

    await laisso.tracker.reply(read(12, "OPEN", true), true);
    expect(await markDone(laisso, ticket.id)).toEqual({ stage: "merge" });
    expect(await markDone(laisso, ticket.id)).toEqual({ detail: "PR #12, #15 not merged" });

    await laisso.tracker.reply(read(12, "MERGED", true), true);
    expect(await markDone(laisso, ticket.id)).toEqual({ detail: "PR #15 not merged" });

    await laisso.tracker.reply(read(15, "MERGED", true), true);
    expect(await markDone(laisso, ticket.id)).toEqual({ stage: "ship" });
    expect(await readsOf(laisso, 30)).toBe(0);
  });
});
