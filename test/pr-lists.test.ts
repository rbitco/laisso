import { describe, it, expect } from "vitest";
import { buildSearch, searchUrl, NO_GITHUB_REPOS, type GitHubRepo } from "../src/prs/query.ts";
import { parseGitHubRemote } from "../src/prs/origins.ts";
import { PrLists, type PrListSetting } from "../src/prs/lists.ts";
import type { PrSearchClient, SearchResult } from "../src/prs/search.ts";
import { prRow, teamInitials, type PrNode, type Verdict } from "../src/prs/rows.ts";
import { checksLabel } from "../src/dashboard/app/prs/PrsPage.tsx";

// PR Lists (LASSO-138): the search each list's query becomes, the repos it is scoped to, and the cache the page reads.
// PR rows (LASSO-132): each row's verdict and check counts, and the checks cell's words.
// Reviewers (LASSO-133): who reviews a PR, in what state, worst first, and who "Needs review" waits on.

const LASSO: GitHubRepo = { owner: "rbitco", name: "lasso" };
const SITE: GitHubRepo = { owner: "rbitco", name: "site" };

describe("a PR List's search", () => {
  const cases: { what: string; query: string; repos: GitHubRepo[]; search: string }[] = [
    { what: "adds is:pr, the repo and the default sort", query: "is:open author:@me", repos: [LASSO], search: "is:pr is:open author:@me repo:rbitco/lasso sort:updated-desc" },
    { what: "adds one repo: per configured repo", query: "is:open", repos: [LASSO, SITE], search: "is:pr is:open repo:rbitco/lasso repo:rbitco/site sort:updated-desc" },
    { what: "names a repo once when two configured repos share it", query: "is:open", repos: [LASSO, { owner: "RBITCO", name: "Lasso" }], search: "is:pr is:open repo:rbitco/lasso sort:updated-desc" },
    { what: "does not add is:pr twice", query: "is:pr is:open", repos: [LASSO], search: "is:pr is:open repo:rbitco/lasso sort:updated-desc" },
    { what: "leaves a query naming repo: unscoped", query: "is:open repo:nodejs/node", repos: [LASSO], search: "is:pr is:open repo:nodejs/node sort:updated-desc" },
    { what: "leaves a query naming org: unscoped", query: "is:open org:example", repos: [LASSO], search: "is:pr is:open org:example sort:updated-desc" },
    { what: "leaves a query naming user: unscoped", query: "is:open user:matt", repos: [LASSO], search: "is:pr is:open user:matt sort:updated-desc" },
    { what: "keeps a sort: the query names", query: "is:open sort:created-asc", repos: [LASSO], search: "is:pr is:open sort:created-asc repo:rbitco/lasso" },
    { what: "takes a quoted repo: as text, not scope", query: 'is:open "repo:nodejs/node"', repos: [LASSO], search: 'is:pr is:open "repo:nodejs/node" repo:rbitco/lasso sort:updated-desc' },
    { what: "keeps a quoted qualifier value as one term", query: 'is:open label:"needs review"', repos: [LASSO], search: 'is:pr is:open label:"needs review" repo:rbitco/lasso sort:updated-desc' },
    { what: "searches with no GitHub repos when the query names its own scope", query: "is:open org:example", repos: [], search: "is:pr is:open org:example sort:updated-desc" },
  ];
  for (const c of cases) {
    it(c.what, () => {
      expect(buildSearch(c.query, c.repos)).toEqual({ search: c.search, url: searchUrl(c.search) });
    });
  }

  it("does not search all of GitHub when a scoped list has no GitHub repos, and says why", () => {
    expect(buildSearch("is:open author:@me", [])).toEqual({ problem: NO_GITHUB_REPOS });
  });

  it("links the same search on github.com", () => {
    expect(searchUrl("is:pr is:open author:@me repo:rbitco/lasso sort:updated-desc")).toBe("https://github.com/pulls?q=is%3Apr%20is%3Aopen%20author%3A%40me%20repo%3Arbitco%2Flasso%20sort%3Aupdated-desc");
    const built = buildSearch('label:"needs review"', [LASSO]);
    expect("url" in built && new URL(built.url).searchParams.get("q")).toBe('is:pr label:"needs review" repo:rbitco/lasso sort:updated-desc');
  });
});

describe("a repo's GitHub origin", () => {
  it("reads github.com SSH and HTTPS URLs, and leaves other hosts out", () => {
    for (const url of ["git@github.com:rbitco/lasso.git", "git@github.com:rbitco/lasso", "ssh://git@github.com/rbitco/lasso.git", "https://github.com/rbitco/lasso.git", "https://github.com/rbitco/lasso", "https://token@github.com/rbitco/lasso.git\n"]) {
      expect(parseGitHubRemote(url)).toEqual(LASSO);
    }
    for (const url of ["git@gitlab.com:rbitco/lasso.git", "https://github.example.com/rbitco/lasso.git", "/srv/git/lasso.git"]) expect(parseGitHubRemote(url)).toBeNull();
  });
});

describe("the PR List cache", () => {
  const node = (n: number) => ({ number: n, title: `PR ${n}`, url: `https://github.com/rbitco/lasso/pull/${n}`, updatedAt: "2026-10-15T12:00:00Z", repository: { nameWithOwner: "rbitco/lasso" }, author: { login: "matt" } });
  const fake = (answer: (search: string) => SearchResult) => {
    const calls: string[] = [];
    const search: PrSearchClient = async (s) => {
      calls.push(s);
      return answer(s);
    };
    return { calls, search };
  };
  const ok = (total: number, ...ns: number[]): SearchResult => ({ ok: true, total, nodes: ns.map(node), rateLimit: { remaining: 4990, resetAt: "2026-10-15T13:00:00Z" } });

  it("fetches each list once, in config order, with its total and the GitHub link", async () => {
    let lists: PrListSetting[] = [
      { name: "Review requested", query: "is:open review-requested:@me", limit: 2 },
      { name: "Mine", query: "is:open author:@me", limit: 25 },
    ];
    const { calls, search } = fake((s) => (s.includes("review-requested") ? ok(31, 1, 2) : ok(1, 3)));
    const cache = new PrLists({ lists: () => lists, repos: async () => [LASSO], search, now: () => Date.parse("2026-10-15T12:05:00Z") });
    const [a, b] = await Promise.all([cache.read(), cache.read()]);
    expect(a).toEqual(b);
    expect(a.lists.map((l) => [l.name, l.rows.map((r) => r.number), l.total, l.fetchedAt])).toEqual([
      ["Review requested", [1, 2], 31, "2026-10-15T12:05:00.000Z"],
      ["Mine", [3], 1, "2026-10-15T12:05:00.000Z"],
    ]);
    expect(a.lists[0]!.url).toBe(searchUrl("is:pr is:open review-requested:@me repo:rbitco/lasso sort:updated-desc"));
    await cache.read();
    expect(calls).toHaveLength(2);
    // An edited list is fetched afresh; a removed one is gone.
    lists = [{ name: "Mine", query: "is:open author:@me draft:false", limit: 25 }];
    const edited = await cache.read();
    expect(edited.lists.map((l) => l.name)).toEqual(["Mine"]);
    expect(calls).toHaveLength(3);
  });

  it("reports a list it cannot search or fetch, and tries a failed fetch again on the next read", async () => {
    let fail = true;
    const { calls, search } = fake(() => (fail ? { ok: false, problem: "failed", message: "timed out" } : ok(1, 1)));
    const cache = new PrLists({ lists: () => [{ name: "Mine", query: "is:open", limit: 25 }, { name: "Elsewhere", query: "org:example", limit: 25 }], repos: async () => [], search });
    const first = await cache.read();
    expect(first.lists.map((l) => l.error)).toEqual([NO_GITHUB_REPOS, "timed out"]);
    fail = false;
    const second = await cache.read();
    expect(second.lists.map((l) => [l.error, l.rows.length])).toEqual([[NO_GITHUB_REPOS, 0], [null, 1]]);
    expect(calls).toEqual(["is:pr org:example sort:updated-desc", "is:pr org:example sort:updated-desc"]);
  });
});

describe("a PR row", () => {
  type Counts = [state: string, count: number][];
  const pr = (fields: Partial<PrNode> = {}, runs: Counts = [], statuses: Counts = []): PrNode => ({
    number: 7,
    title: "Add the PR page",
    url: "https://github.com/rbitco/lasso/pull/7",
    updatedAt: "2026-10-15T12:00:00Z",
    repository: { nameWithOwner: "rbitco/lasso" },
    author: { login: "matt" },
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: runs.map(([state, count]) => ({ state, count })), statusContextCountsByState: statuses.map(([state, count]) => ({ state, count })) } } } }] },
    ...fields,
  });
  const word = (node: PrNode) => prRow(node)!.verdict.word;

  it("reads a node's fields, and skips a node that is not a PR", () => {
    expect(prRow(pr())).toEqual({
      title: "Add the PR page",
      repo: "rbitco/lasso",
      number: 7,
      url: "https://github.com/rbitco/lasso/pull/7",
      author: "matt",
      updatedAt: "2026-10-15T12:00:00Z",
      verdict: { word: "Ready to merge", reason: "checks green, approved", tone: "good" },
      checks: {},
      reviewers: [],
    });
    expect(prRow({})).toBeNull();
    expect(prRow(pr({ author: null }))!.author).toBe("ghost");
  });

  it("gives each verdict its reason and tone", () => {
    const cases: [PrNode, Verdict][] = [
      [pr({ isDraft: true }), { word: "Draft", reason: "not ready for review", tone: "muted" }],
      [pr({ mergeable: "CONFLICTING" }), { word: "Conflicts", reason: "needs a rebase onto the base branch", tone: "crit" }],
      [pr({}, [["FAILURE", 1]]), { word: "Checks failing", reason: "a required check failed", tone: "crit" }],
      [pr({ reviewDecision: "CHANGES_REQUESTED" }), { word: "Changes requested", reason: "a reviewer asked for changes", tone: "amber" }],
      [pr({}, [["IN_PROGRESS", 1]]), { word: "Checks running", reason: "waiting on CI", tone: "run" }],
      [pr({ reviewDecision: "REVIEW_REQUIRED" }), { word: "Needs review", reason: "no reviewer yet", tone: "amber" }],
      [pr({}, [["SUCCESS", 3]]), { word: "Ready to merge", reason: "checks green, approved", tone: "good" }],
    ];
    for (const [node, verdict] of cases) expect(prRow(node)!.verdict).toEqual(verdict);
  });

  it("takes the first verdict that matches, worst first", () => {
    const failing: Counts = [["FAILURE", 1]];
    const running: Counts = [["QUEUED", 1]];
    expect(word(pr({ isDraft: true, mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED" }, [...failing, ...running]))).toBe("Draft");
    expect(word(pr({ mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED" }, [...failing, ...running]))).toBe("Conflicts");
    expect(word(pr({ reviewDecision: "CHANGES_REQUESTED" }, [...failing, ...running]))).toBe("Checks failing");
    expect(word(pr({ reviewDecision: "CHANGES_REQUESTED" }, running))).toBe("Changes requested");
    expect(word(pr({ reviewDecision: "REVIEW_REQUIRED" }, running))).toBe("Checks running");
    expect(word(pr({ reviewDecision: "REVIEW_REQUIRED" }, [["SUCCESS", 2], ["SKIPPED", 1]]))).toBe("Needs review");
    // No review required, no checks, and mergeable not worked out yet: nothing stands in the way.
    expect(word(pr({ reviewDecision: null, mergeable: "UNKNOWN", commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }))).toBe("Ready to merge");
  });

  it("groups check runs and commit statuses together, dropping zero counts", () => {
    const runs: Counts = [["SUCCESS", 4], ["NEUTRAL", 1], ["COMPLETED", 1], ["FAILURE", 1], ["TIMED_OUT", 1], ["CANCELLED", 1], ["ACTION_REQUIRED", 1], ["STARTUP_FAILURE", 1], ["QUEUED", 1], ["IN_PROGRESS", 1], ["PENDING", 1], ["WAITING", 1], ["SKIPPED", 2], ["STALE", 1]];
    const statuses: Counts = [["SUCCESS", 2], ["FAILURE", 1], ["ERROR", 1], ["PENDING", 1], ["EXPECTED", 1]];
    expect(prRow(pr({}, runs, statuses))!.checks).toEqual({ passed: 8, failing: 7, running: 6, skipped: 3 });
    expect(prRow(pr({}, [["SUCCESS", 9], ["FAILURE", 0], ["IN_PROGRESS", 0], ["SKIPPED", 0]]))!.checks).toEqual({ passed: 9 });
    expect(prRow(pr({}, [], [["PENDING", 2], ["SUCCESS", 0]]))!.checks).toEqual({ running: 2 });
    expect(prRow(pr({ commits: null }))!.checks).toEqual({});
  });

  it("labels the checks cell, and leaves it empty with no checks", () => {
    expect(checksLabel({ passed: 9 })).toBe("9/9 passed");
    expect(checksLabel({ passed: 7, skipped: 2 })).toBe("7/7 passed");
    expect(checksLabel({ passed: 7, failing: 2 })).toBe("2 failing");
    expect(checksLabel({ passed: 5, running: 4 })).toBe("4 running");
    expect(checksLabel({ failing: 2, running: 4 })).toBe("2 failing · 4 running");
    expect(checksLabel({ skipped: 3 })).toBe("3 skipped");
    expect(checksLabel({})).toBeNull();
  });
});

describe("a PR's reviewers", () => {
  const HEAD = "c0ffee";
  const OLD = "dec0de";
  type Rv = { login: string; state: string; oid?: string; bot?: boolean };
  type Rq = { login?: string; team?: string; hidden?: true; bot?: true; owner?: true };
  const avatar = (login: string) => `https://avatars.githubusercontent.com/${login}`;
  const review = ({ login, state, oid = HEAD, bot }: Rv) => ({ author: { __typename: bot ? "Bot" : "User", login, avatarUrl: avatar(login) }, state, commit: { oid } });
  /** A PR by matt from its three review lists, as GitHub sends them. */
  const pr = ({ latest = [], opinionated = [], requests = [], decision = "REVIEW_REQUIRED" }: { latest?: Rv[]; opinionated?: Rv[]; requests?: Rq[]; decision?: string }): PrNode => ({
    number: 7,
    url: "https://github.com/rbitco/lasso/pull/7",
    repository: { nameWithOwner: "rbitco/lasso" },
    author: { login: "matt" },
    reviewDecision: decision,
    headRefOid: HEAD,
    latestReviews: { nodes: latest.map(review) },
    latestOpinionatedReviews: { nodes: opinionated.map(review) },
    reviewRequests: {
      nodes: requests.map((r) => ({
        asCodeOwner: r.owner === true,
        requestedReviewer: r.hidden ? null : r.team ? { __typename: "Team", name: r.team, slug: r.team.split("/")[1], combinedSlug: r.team } : r.bot ? { __typename: "Bot", login: r.login } : { __typename: "User", login: r.login, avatarUrl: avatar(r.login!) },
      })),
    },
  });
  const states = (node: PrNode) => prRow(node)!.reviewers.map((r) => [r.name, r.state]);

  it("reads a person's state from their latest opinionated review, with their picture and initials", () => {
    const row = prRow(pr({ latest: [{ login: "jo", state: "APPROVED" }], opinionated: [{ login: "jo", state: "APPROVED" }] }))!;
    expect(row.reviewers).toEqual([{ name: "jo", kind: "person", state: "approved", required: false, initials: "JO", avatarUrl: avatar("jo") }]);
  });

  it("asks for a re-review when commits came after the review", () => {
    expect(states(pr({ latest: [{ login: "jo", state: "APPROVED", oid: OLD }], opinionated: [{ login: "jo", state: "APPROVED", oid: OLD }] }))).toEqual([["jo", "rereview"]]);
  });

  it("asks for a re-review when the latest review was dismissed (node #66651)", () => {
    expect(states(pr({ latest: [{ login: "lpinca", state: "DISMISSED" }] }))).toEqual([["lpinca", "rereview"]]);
  });

  it("asks for a re-review when someone is asked again after reviewing (vscode #337719)", () => {
    // GitHub drops a re-requested reviewer from latestReviews but keeps their opinionated review.
    expect(states(pr({ opinionated: [{ login: "alexdima", state: "CHANGES_REQUESTED" }], requests: [{ login: "alexdima" }] }))).toEqual([["alexdima", "rereview"]]);
  });

  it("keeps changes requested when the reviewer comments afterwards (vscode #338231)", () => {
    expect(states(pr({ latest: [{ login: "sam", state: "COMMENTED" }], opinionated: [{ login: "sam", state: "CHANGES_REQUESTED" }] }))).toEqual([["sam", "changes"]]);
    // A comment alone, even on an older commit, never asks for a re-review.
    expect(states(pr({ latest: [{ login: "priya", state: "COMMENTED", oid: OLD }] }))).toEqual([["priya", "commented"]]);
  });

  it("never asks a bot to re-review", () => {
    const bot = "copilot-pull-request-reviewer";
    expect(states(pr({ latest: [{ login: bot, state: "COMMENTED", oid: OLD, bot: true }] }))).toEqual([[bot, "commented"]]);
    expect(states(pr({ latest: [{ login: "renovate", state: "APPROVED", oid: OLD, bot: true }], opinionated: [{ login: "renovate", state: "APPROVED", oid: OLD }] }))).toEqual([["renovate", "approved"]]);
    expect(states(pr({ opinionated: [{ login: "renovate", state: "APPROVED" }], latest: [{ login: "renovate", state: "APPROVED", bot: true }], requests: [{ login: "renovate", bot: true }] }))).toEqual([["renovate", "requested"]]);
  });

  it("leaves out the PR's author, whose replies to a review are COMMENTED reviews", () => {
    expect(states(pr({ latest: [{ login: "matt", state: "COMMENTED" }] }))).toEqual([]);
  });

  it("shows a requested team as a square of initials", () => {
    expect(prRow(pr({ requests: [{ team: "rbitco/web-platform" }] }))!.reviewers).toEqual([{ name: "rbitco/web-platform", kind: "team", state: "requested", required: false, initials: "WP" }]);
  });

  it("takes team initials from the name after the slash", () => {
    expect(teamInitials("example/web-platform")).toBe("WP");
    expect(teamInitials("example/payments")).toBe("PA");
    expect(teamInitials("a_b_c")).toBe("ABC");
    expect(teamInitials("example/payments-core_eu")).toBe("PCE");
  });

  it("shows a team the user can't see as a hidden team, still requested (elastic/kibana)", () => {
    expect(prRow(pr({ requests: [{ hidden: true, owner: true }, { hidden: true, owner: true }] }))!.reviewers).toEqual([
      { name: null, kind: "hidden-team", state: "requested", required: true, initials: "?" },
      { name: null, kind: "hidden-team", state: "requested", required: true, initials: "?" },
    ]);
  });

  it("marks code owner requests as required", () => {
    const row = prRow(pr({ requests: [{ login: "jo", owner: true }, { login: "sam" }, { team: "rbitco/payments", owner: true }] }))!;
    expect(row.reviewers.map((r) => [r.name, r.required])).toEqual([["jo", true], ["sam", false], ["rbitco/payments", true]]);
  });

  it("orders reviewers worst state first, people before teams within a state", () => {
    const node = pr({
      latest: [{ login: "ken", state: "APPROVED" }, { login: "priya", state: "COMMENTED" }, { login: "sam", state: "CHANGES_REQUESTED" }, { login: "lpinca", state: "DISMISSED" }],
      opinionated: [{ login: "ken", state: "APPROVED" }, { login: "sam", state: "CHANGES_REQUESTED" }],
      requests: [{ team: "rbitco/payments" }, { login: "jo" }],
    });
    expect(states(node)).toEqual([["sam", "changes"], ["lpinca", "rereview"], ["jo", "requested"], ["rbitco/payments", "requested"], ["priya", "commented"], ["ken", "approved"]]);
  });

  it("names who Needs review waits on, or says there is no reviewer yet", () => {
    const reason = (node: PrNode) => prRow(node)!.verdict.reason;
    expect(reason(pr({}))).toBe("no reviewer yet");
    // Someone who only commented is not waited on.
    expect(reason(pr({ latest: [{ login: "priya", state: "COMMENTED" }] }))).toBe("no reviewer yet");
    expect(reason(pr({ latest: [{ login: "lpinca", state: "DISMISSED" }], requests: [{ login: "jo" }, { team: "rbitco/web-platform" }] }))).toBe("waiting on lpinca, jo, @rbitco/web-platform");
    expect(reason(pr({ requests: [{ hidden: true }] }))).toBe("waiting on a team you can't see");
    expect(reason(pr({ requests: [{ login: "a" }, { login: "b" }, { login: "c" }, { login: "d" }, { login: "e" }] }))).toBe("waiting on a, b, c and 2 more");
  });
});
