import { describe, it, expect } from "vitest";
import { buildSearch, searchUrl, NO_GITHUB_REPOS, type GitHubRepo } from "../src/prs/query.ts";
import { parseGitHubRemote } from "../src/prs/origins.ts";
import { PrLists, type PrListSetting } from "../src/prs/lists.ts";
import type { PrSearchClient, SearchResult } from "../src/prs/search.ts";
import { prRow, type PrNode, type Verdict } from "../src/prs/rows.ts";
import { checksLabel } from "../src/dashboard/app/prs/PrsPage.tsx";

// PR Lists (LASSO-138): the search each list's query becomes, the repos it is scoped to, and the cache the page reads.
// PR rows (LASSO-132): each row's verdict and check counts, and the checks cell's words.

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
