import { describe, it, expect } from "vitest";
import { buildSearch, searchUrl, NO_GITHUB_REPOS, type GitHubRepo } from "../src/prs/query.ts";
import { parseGitHubRemote } from "../src/prs/origins.ts";
import { PrLists, type PrListSetting } from "../src/prs/lists.ts";
import type { PrSearchClient, SearchResult } from "../src/prs/search.ts";

// PR Lists (LASSO-138): the search each list's query becomes, the repos it is scoped to, and the cache the page reads.

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
