import { describe, it, expect } from "vitest";
import { buildSearch, searchUrl, NO_GITHUB_REPOS, type GitHubRepo } from "../src/prs/query.ts";
import { parseGitHubRemote } from "../src/prs/origins.ts";
import { PrLists, type PrListSetting } from "../src/prs/lists.ts";
import type { PrSearchClient, SearchResult } from "../src/prs/search.ts";
import { prRow, teamInitials, ticketForPr, ticketMatcher, type PrNode, type TicketForPr, type TicketWithOwned, type Verdict } from "../src/prs/rows.ts";
import { checksLabel } from "../src/dashboard/app/prs/PrsPage.tsx";
import type { TicketRow } from "../src/store/tickets.ts";
import type { PrPageLayout } from "../src/server/config.ts";

// PR Lists (LASSO-138): the search each list's query becomes, the repos it is scoped to, and the cache the page reads.
// PR rows (LASSO-132): each row's verdict and check counts, and the checks cell's words.
// Reviewers (LASSO-133): who reviews a PR, in what state, worst first, and who "Needs review" waits on.
// Tickets on rows (LASSO-137): the Lasso Ticket each PR matches, by PR URL or by repo and branch, and its Flag.
// Refresh on the Tick (LASSO-134): when the cache fetches, over a fake clock and a fake GitHub.

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

  // Advanced search (LASSO-161): the query in parentheses, the repos in one OR group, the sort outside both.
  const advanced: { what: string; query: string; repos: GitHubRepo[]; search: string }[] = [
    { what: "groups the query and the repos so the query's OR stays its own", query: "is:open (author:@me OR assignee:@me) (-status:success OR -review:approved)", repos: [LASSO, SITE], search: "is:pr (is:open (author:@me OR assignee:@me) (-status:success OR -review:approved)) (repo:rbitco/lasso OR repo:rbitco/site) sort:updated-desc" },
    { what: "adds a lone repo without a group", query: "is:open author:@me OR assignee:@me", repos: [LASSO], search: "is:pr (is:open author:@me OR assignee:@me) repo:rbitco/lasso sort:updated-desc" },
    { what: "moves the query's sort: outside the parentheses", query: "is:open sort:created-asc", repos: [LASSO], search: "is:pr (is:open) repo:rbitco/lasso sort:created-asc" },
    { what: "reads a scope inside parentheses as the query's own", query: "is:open (repo:nodejs/node OR org:example)", repos: [LASSO], search: "is:pr (is:open (repo:nodejs/node OR org:example)) sort:updated-desc" },
    { what: "does not add is:pr twice, in parentheses or not", query: "(is:pr is:open)", repos: [LASSO], search: "((is:pr is:open)) repo:rbitco/lasso sort:updated-desc" },
  ];
  for (const c of advanced) {
    it(`advanced: ${c.what}`, () => {
      expect(buildSearch(c.query, c.repos, "advanced")).toEqual({ search: c.search, url: searchUrl(c.search) });
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
  const TICK = 60_000;
  const REFRESH = 5 * TICK;
  const START = Date.parse("2026-10-15T12:00:00Z");
  const node = (n: number) => ({ number: n, title: `PR ${n}`, url: `https://github.com/rbitco/lasso/pull/${n}`, updatedAt: "2026-10-15T12:00:00Z", repository: { nameWithOwner: "rbitco/lasso" }, author: { login: "matt" } });
  const ok = (total: number, ...ns: number[]): SearchResult => ({ ok: true, total, nodes: ns.map(node), rateLimit: { remaining: 4990, resetAt: "2026-10-15T13:00:00Z" } });
  const MINE: PrListSetting = { name: "Mine", query: "is:open author:@me", limit: 25 };
  const REVIEW: PrListSetting = { name: "Review requested", query: "is:open review-requested:@me", limit: 2 };

  /**
   * A cache over a fake clock and a fake GitHub. Searches answer at once unless `hold` is set, when they wait for
   * `release`. `calls` is every search sent; `changes` counts change callbacks.
   */
  function setup(opts: { lists?: PrListSetting[]; repos?: Record<string, GitHubRepo>; answer?: (search: string) => SearchResult; layout?: () => PrPageLayout } = {}) {
    let now = START;
    let lists = opts.lists ?? [MINE, REVIEW];
    let answer = opts.answer ?? ((s: string) => (s.includes("review-requested") ? ok(31, 1, 2) : ok(1, 3)));
    const calls: string[] = [];
    const syntaxes: string[] = [];
    let held: Promise<void> | null = null;
    let release = () => undefined as void;
    const search: PrSearchClient = async (s, _limit, syntax = "legacy") => {
      calls.push(s);
      syntaxes.push(syntax);
      if (held) await held;
      return answer(s);
    };
    const t = {
      calls,
      syntaxes,
      changes: 0,
      cache: null as unknown as PrLists,
      advance: (ms: number) => void (now += ms),
      now: () => now,
      setLists: (next: PrListSetting[]) => void (lists = next),
      setAnswer: (next: (search: string) => SearchResult) => void (answer = next),
      hold: () => void (held = new Promise<void>((r) => (release = () => ((held = null), r())))),
      release: () => release(),
      /** Reads once a Tick for `ticks` Ticks, as an open page does, running each Tick's step after the read. */
      async openFor(ticks: number) {
        for (let i = 0; i < ticks; i++) {
          t.advance(TICK);
          await t.cache.read();
          await t.cache.onTick();
          await t.cache.settle();
        }
      },
    };
    t.cache = new PrLists({ lists: () => lists, repos: async () => opts.repos ?? { lasso: LASSO }, search, tickMs: () => TICK, refreshMs: () => REFRESH, changed: () => t.changes++, example: "pr_lists: ...", layout: opts.layout, now: () => now });
    return t;
  }

  it("answers a read at once, fetching in the background, and shows the rows once fetched, in config order", async () => {
    const t = setup({ lists: [REVIEW, MINE] });
    t.hold();
    const first = await t.cache.read();
    // Before the first fetch: no rows, no age, fetching.
    expect(first.lists.map((l) => [l.name, l.rows, l.fetchedAt, l.fetching])).toEqual([
      ["Review requested", [], null, true],
      ["Mine", [], null, true],
    ]);
    expect(first.pausedUntil).toBeNull();
    expect(t.changes).toBe(1);
    t.release();
    await t.cache.settle();
    expect(t.changes).toBe(3);
    const fetched = await t.cache.read();
    expect(fetched.lists.map((l) => [l.name, l.rows.map((r) => r.number), l.total, l.fetchedAt, l.fetching])).toEqual([
      ["Review requested", [1, 2], 31, "2026-10-15T12:00:00.000Z", false],
      ["Mine", [3], 1, "2026-10-15T12:00:00.000Z", false],
    ]);
    expect(fetched.lists[0]!.url).toBe(searchUrl("is:pr is:open review-requested:@me repo:rbitco/lasso sort:updated-desc"));
    expect(t.calls).toHaveLength(2);
  });

  it("shares one fetch per list between reads, Ticks and Check now that overlap", async () => {
    const t = setup();
    t.hold();
    await Promise.all([t.cache.read(), t.cache.read()]);
    t.advance(REFRESH + TICK);
    await t.cache.read();
    await t.cache.onTick();
    await t.cache.checkNow();
    expect(t.calls).toHaveLength(2);
    t.release();
    await t.cache.settle();
    expect((await t.cache.read()).lists.every((l) => l.rows.length > 0)).toBe(true);
  });

  it("refreshes on the Tick only lists older than pr_list_refresh, and only while the page is open", async () => {
    const t = setup();
    // Nobody has opened the page: a Tick searches nothing.
    await t.cache.onTick();
    expect(t.calls).toHaveLength(0);
    await t.cache.read();
    await t.cache.settle();
    expect(t.calls).toHaveLength(2);
    // Read each Tick, the page stays open; the lists are younger than pr_list_refresh for four Ticks.
    await t.openFor(4);
    expect(t.calls).toHaveLength(2);
    await t.openFor(1);
    expect(t.calls).toHaveLength(4);
    expect((await t.cache.read()).lists[0]!.fetchedAt).toBe(new Date(START + REFRESH).toISOString());
    // Unread for more than two Ticks, the page is closed: stale lists stay as they are.
    t.advance(2 * TICK + 1);
    t.advance(REFRESH);
    await t.cache.onTick();
    await t.cache.settle();
    expect(t.calls).toHaveLength(4);
  });

  it("refreshes lists older than one Tick when the page opens again", async () => {
    const t = setup();
    await t.cache.read();
    await t.cache.settle();
    // Closed for three Ticks: opening it again refreshes both lists.
    t.advance(3 * TICK);
    await t.cache.read();
    await t.cache.settle();
    expect(t.calls).toHaveLength(4);
    // The page now open, a read refreshes nothing more.
    t.advance(TICK);
    await t.cache.read();
    expect(t.calls).toHaveLength(4);
  });

  it("does not refresh a list fetched under a Tick ago when the page opens", async () => {
    const t = setup();
    await t.cache.read();
    await t.cache.settle();
    await t.openFor(3);
    // Last read at 3T. At 5T the page is open (read 2T ago) and the Tick refreshes the 5T-old lists.
    t.advance(2 * TICK);
    await t.cache.onTick();
    await t.cache.settle();
    expect(t.calls).toHaveLength(4);
    // Half a Tick on, the page counts as closed; opening it finds lists half a Tick old, fresh enough.
    t.advance(TICK / 2);
    await t.cache.read();
    expect(t.calls).toHaveLength(4);
  });

  it("refreshes every list on Check now, however fresh, while the page is open", async () => {
    const t = setup();
    await t.cache.read();
    await t.cache.settle();
    t.advance(1000);
    await t.cache.checkNow();
    await t.cache.settle();
    expect(t.calls).toHaveLength(4);
    // A Check now with the page closed spends nothing.
    t.advance(3 * TICK);
    await t.cache.checkNow();
    expect(t.calls).toHaveLength(4);
  });

  it("keeps a list's rows when a refresh fails, retries when next due, and clears the error when it succeeds", async () => {
    const t = setup({ lists: [MINE] });
    await t.cache.read();
    await t.cache.settle();
    const good = (await t.cache.read()).lists[0]!;
    t.setAnswer(() => ({ ok: false, problem: "failed", message: "timed out" }));
    await t.cache.checkNow();
    await t.cache.settle();
    const failed = (await t.cache.read()).lists[0]!;
    expect([failed.error, failed.rows, failed.fetchedAt]).toEqual([{ kind: "failed", message: "timed out" }, good.rows, good.fetchedAt]);
    expect(t.cache.status()).toEqual({ failing: true });
    // Reads while the page is open don't retry it; the next due Tick does.
    await t.openFor(4);
    expect(t.calls).toHaveLength(2);
    t.setAnswer(() => ok(2, 4, 5));
    await t.openFor(1);
    const recovered = (await t.cache.read()).lists[0]!;
    expect([recovered.error, recovered.rows.map((r) => r.number), t.calls.length]).toEqual([null, [4, 5], 3]);
    expect(t.cache.status()).toEqual({ failing: false });
  });

  it("hides a hide_when_empty list only once a search succeeds with no PRs, never while loading or failed, and without flicker", async () => {
    const TRAIN: PrListSetting = { name: "Pending train", query: "is:open label:train", limit: 25, hide_when_empty: true };
    const EMPTY_TOO: PrListSetting = { ...MINE, name: "Empty, shown" };
    const t = setup({ lists: [TRAIN, EMPTY_TOO], answer: () => ok(0) });
    const hidden = async () => (await t.cache.read()).lists.map((l) => [l.name, l.hidden]);
    t.hold();
    // Loading: shown, like any list, until its first answer.
    expect(await hidden()).toEqual([["Pending train", false], ["Empty, shown", false]]);
    t.release();
    await t.cache.settle();
    // Empty: hidden. A list without the setting stays, empty.
    expect(await hidden()).toEqual([["Pending train", true], ["Empty, shown", false]]);
    // A refresh under way keeps the last answer, so it stays hidden while fetching.
    t.hold();
    await t.cache.checkNow();
    expect((await t.cache.read()).lists[0]).toMatchObject({ hidden: true, fetching: true });
    t.setAnswer(() => ok(1, 7));
    t.release();
    await t.cache.settle();
    // PRs found: back on the page.
    expect((await t.cache.read()).lists[0]).toMatchObject({ hidden: false, total: 1 });
    // A failed search shows the list with its error, even over an empty last answer.
    t.setAnswer(() => ok(0));
    await t.cache.checkNow();
    await t.cache.settle();
    t.setAnswer(() => ({ ok: false, problem: "failed", message: "timed out" }));
    await t.cache.checkNow();
    await t.cache.settle();
    expect((await t.cache.read()).lists[0]).toMatchObject({ hidden: false, total: 0, error: { kind: "failed" } });
  });

  it("never hides a list that cannot search", async () => {
    const t = setup({ lists: [{ name: "Elsewhere", query: "is:open", limit: 25, hide_when_empty: true }], repos: {} });
    expect((await t.cache.read()).lists[0]).toMatchObject({ hidden: false, error: { kind: "no-github-repos" } });
  });

  it("reports a list it cannot search without fetching it", async () => {
    const t = setup({ lists: [MINE, { name: "Elsewhere", query: "org:example", limit: 25 }], repos: {} });
    const view = await t.cache.read();
    await t.cache.settle();
    expect(view.lists.map((l) => [l.error, l.fetching])).toEqual([
      [{ kind: "no-github-repos", message: NO_GITHUB_REPOS }, false],
      [null, true],
    ]);
    expect(t.calls).toEqual(["is:pr org:example sort:updated-desc"]);
    // A list that cannot search is a config problem, not a failed fetch: it does not light the nav's dot.
    expect(t.cache.status()).toEqual({ failing: false });
  });

  it("holds gh missing as the page's problem, not a list's, keeping the rows, and clears it on the next fetch gh answers", async () => {
    const t = setup();
    await t.cache.read();
    await t.cache.settle();
    t.setAnswer(() => ({ ok: false, problem: "gh-missing", message: "gh is not installed" }));
    await t.cache.checkNow();
    await t.cache.settle();
    const missing = await t.cache.read();
    expect(missing.ghProblem).toEqual({ kind: "gh-missing", message: "gh is not installed" });
    expect(missing.lists.map((l) => [l.error, l.rows.length])).toEqual([
      [null, 1],
      [null, 2],
    ]);
    expect(t.cache.status()).toEqual({ failing: true });
    t.setAnswer(() => ok(1, 3));
    await t.cache.checkNow();
    await t.cache.settle();
    expect((await t.cache.read()).ghProblem).toBeNull();
    expect(t.cache.status()).toEqual({ failing: false });
  });

  it("holds gh logged out as the page's problem before any good fetch", async () => {
    const t = setup({ answer: () => ({ ok: false, problem: "not-logged-in", message: "gh is not logged in" }) });
    await t.cache.read();
    await t.cache.settle();
    const view = await t.cache.read();
    expect([view.ghProblem, view.lists.map((l) => l.error)]).toEqual([{ kind: "not-logged-in", message: "gh is not logged in" }, [null, null]]);
  });

  it("fails only the list whose query GitHub rejects, dropping its rows, and the others load", async () => {
    const t = setup();
    await t.cache.read();
    await t.cache.settle();
    t.setAnswer((s) => (s.includes("review-requested") ? { ok: false, problem: "rejected", message: "The listed users cannot be searched" } : ok(1, 3)));
    await t.cache.checkNow();
    await t.cache.settle();
    const view = await t.cache.read();
    expect(view.lists.map((l) => [l.name, l.error, l.rows.length, l.fetchedAt])).toEqual([
      ["Mine", null, 1, "2026-10-15T12:00:00.000Z"],
      ["Review requested", { kind: "rejected", message: "The listed users cannot be searched" }, 0, null],
    ]);
    expect([view.ghProblem, t.cache.status()]).toEqual([null, { failing: true }]);
  });

  it("does not count a rate-limited fetch, a pause or an empty list as failing", async () => {
    const t = setup({ answer: (s) => (s.includes("review-requested") ? { ok: false, problem: "rate-limited", message: "GitHub rate limit" } : ok(0)) });
    await t.cache.read();
    await t.cache.settle();
    const view = await t.cache.read();
    expect(view.lists.map((l) => [l.error, l.rows.length])).toEqual([
      [null, 0],
      [{ kind: "rate-limited", message: "GitHub rate limit" }, 0],
    ]);
    expect(t.cache.status()).toEqual({ failing: false });
  });

  it("gives pr_page_layout as config has it at each read, stacked when not given one", async () => {
    expect((await setup().cache.read()).layout).toBe("stacked");
    let layout: PrPageLayout = "side-by-side";
    const t = setup({ layout: () => layout });
    expect((await t.cache.read()).layout).toBe("side-by-side");
    layout = "stacked";
    expect((await t.cache.read()).layout).toBe("stacked");
  });

  it("answers its status without opening the page or fetching", async () => {
    const t = setup();
    expect(t.cache.status()).toEqual({ failing: false });
    await t.cache.onTick();
    expect(t.calls).toEqual([]);
  });

  it("gives the example to show when config has no lists, and never fails then", async () => {
    const t = setup({ answer: () => ({ ok: false, problem: "gh-missing", message: "gh is not installed" }) });
    await t.cache.read();
    await t.cache.settle();
    expect(t.cache.status()).toEqual({ failing: true });
    t.setLists([]);
    expect(await t.cache.read()).toEqual({ layout: "stacked", lists: [], pausedUntil: null, ghProblem: null, example: "pr_lists: ..." });
    expect(t.cache.status()).toEqual({ failing: false });
  });

  it("pauses every list below 500 GitHub points until the reset, keeping the rows, and resumes on the first Tick after it", async () => {
    const reset = START + 30 * 60_000;
    const t = setup({ answer: () => ({ ...ok(1, 3), rateLimit: { remaining: 499, resetAt: new Date(reset).toISOString() } }) });
    await t.cache.read();
    await t.cache.settle();
    const paused = await t.cache.read();
    expect([paused.pausedUntil, paused.lists.map((l) => l.rows.length)]).toEqual([new Date(reset).toISOString(), [1, 1]]);
    // Nothing refreshes while paused: not Check now, not a stale Tick, not opening the page.
    await t.cache.checkNow();
    await t.openFor(10);
    t.advance(3 * TICK);
    await t.cache.read();
    expect(t.calls).toHaveLength(2);
    // Past the reset, the pause holds until a Tick, which resumes and refreshes the stale lists.
    t.advance(reset - t.now() + 1);
    expect((await t.cache.read()).pausedUntil).toBe(new Date(reset).toISOString());
    expect(t.calls).toHaveLength(2);
    t.setAnswer(() => ok(1, 3));
    const before = t.changes;
    await t.cache.onTick();
    await t.cache.settle();
    expect(t.changes).toBeGreaterThan(before);
    expect([(await t.cache.read()).pausedUntil, t.calls.length]).toEqual([null, 4]);
  });

  it("fetches a list added or edited in config afresh, drops a removed one, and leaves the rest", async () => {
    const t = setup();
    await t.cache.read();
    await t.cache.settle();
    const drafts: PrListSetting = { name: "Drafts", query: "is:open draft:true author:@me", limit: 5 };
    t.setLists([{ ...MINE, query: "is:open author:@me draft:false" }, drafts]);
    t.hold();
    const edited = await t.cache.read();
    // The edited list starts again with no rows; the removed one is gone.
    expect(edited.lists.map((l) => [l.name, l.rows.length, l.fetchedAt, l.fetching])).toEqual([
      ["Mine", 0, null, true],
      ["Drafts", 0, null, true],
    ]);
    t.release();
    await t.cache.settle();
    expect(t.calls.slice(2)).toEqual(["is:pr is:open author:@me draft:false repo:rbitco/lasso sort:updated-desc", "is:pr is:open draft:true author:@me repo:rbitco/lasso sort:updated-desc"]);
    // Once fetched, the edited list is not fetched again by a read.
    t.setLists([{ ...MINE, query: "is:open author:@me draft:false" }]);
    await t.cache.read();
    expect(t.calls).toHaveLength(4);
  });

  it("runs a list on advanced search when it says so, and fetches afresh when that changes (LASSO-161)", async () => {
    const t = setup({ lists: [{ ...MINE, query: "is:open author:@me OR assignee:@me", search: "advanced" }] });
    await t.cache.read();
    await t.cache.settle();
    expect(t.calls).toEqual(["is:pr (is:open author:@me OR assignee:@me) repo:rbitco/lasso sort:updated-desc"]);
    expect(t.syntaxes).toEqual(["advanced"]);
    // Back on legacy: the same words make a different search, so the list starts again.
    t.setLists([{ ...MINE, query: "is:open author:@me OR assignee:@me" }]);
    await t.cache.read();
    await t.cache.settle();
    expect(t.calls[1]).toBe("is:pr is:open author:@me OR assignee:@me repo:rbitco/lasso sort:updated-desc");
    expect(t.syntaxes).toEqual(["advanced", "legacy"]);
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
      verdict: { word: "Ready to merge", reason: "approved", tone: "good" },
      checks: {},
      reviewers: [],
      ticket: null,
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
      [pr({ reviewDecision: null }, [["SUCCESS", 3]]), { word: "Ready to merge", reason: "checks green", tone: "good" }],
      [pr({ reviewDecision: null }), { word: "Ready to merge", reason: "no checks or reviews required", tone: "good" }],
      [pr({ state: "MERGED" }), { word: "Merged", reason: "merged into the base branch", tone: "muted" }],
      [pr({ state: "CLOSED" }), { word: "Closed", reason: "closed without merging", tone: "muted" }],
    ];
    for (const [node, verdict] of cases) expect(prRow(node)!.verdict).toEqual(verdict);
  });

  it("takes the first verdict that matches, worst first", () => {
    const failing: Counts = [["FAILURE", 1]];
    const running: Counts = [["QUEUED", 1]];
    expect(word(pr({ state: "MERGED", isDraft: true, mergeable: "CONFLICTING" }, failing))).toBe("Merged");
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

describe("a PR row's Ticket", () => {
  const ID = "01TICKET0000000000000000AB";
  const node = (fields: Partial<PrNode> = {}): PrNode => ({
    number: 7,
    title: "Add the PR page",
    url: "https://github.com/rbitco/lasso/pull/7",
    repository: { nameWithOwner: "rbitco/lasso" },
    author: { login: "matt" },
    headRefName: "lasso-7-pr-page",
    reviewDecision: "APPROVED",
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: [{ state: "IN_PROGRESS", count: 1 }] } } } }] },
    ...fields,
  });
  type Row = Parameters<typeof ticketForPr>[0];
  const row = (fields: Partial<Row> = {}): Row => ({ id: ID, name: null, reference: "LASSO-7", stage: "review", state: "active", flagged_at: null, flag_reason: null, owned: [], branch: "lasso-7-pr-page", ...fields });
  const one = (fields: Partial<Row> = {}, github: GitHubRepo | null = LASSO) => ticketForPr(row(fields), github)!;
  const ticketOf = (pr: PrNode, ...tickets: TicketForPr[]) => prRow(pr, ticketMatcher(tickets))!.ticket;

  it("matches by PR URL, ignoring case and trailing slashes", () => {
    expect(ticketOf(node(), one({ owned: ["https://GitHub.com/rbitco/Lasso/pull/7/"], branch: "something-else" }, null))).toEqual({ id: ID, ref: "LASSO-7", stage: "review", flag: null });
    expect(ticketOf(node(), one({ owned: ["https://github.com/rbitco/lasso/pull/8"], branch: "something-else" }))).toBeNull();
  });

  it("matches by GitHub repo and head branch when no Ticket has the PR's URL", () => {
    expect(ticketOf(node(), one({}, { owner: "RBITCO", name: "lasso" }))?.ref).toBe("LASSO-7");
    // The same branch in another repo, a repo not on github.com, or a PR with no head branch: no match.
    expect(ticketOf(node(), one({}, SITE))).toBeNull();
    expect(ticketOf(node(), one({}, null))).toBeNull();
    expect(ticketOf(node({ headRefName: null }), one())).toBeNull();
  });

  it("prefers a URL match over a branch match, and an active Ticket over a done one", () => {
    const byBranch = one({ id: "BRANCH", reference: "LASSO-1" });
    const byUrl = one({ id: "URL", reference: "LASSO-2", branch: "other", owned: ["https://github.com/rbitco/lasso/pull/7"] });
    expect(ticketOf(node(), byBranch, byUrl)?.id).toBe("URL");
    const done = one({ id: "DONE", state: "done" });
    expect(ticketOf(node(), done, one({ id: "ACTIVE" }))?.id).toBe("ACTIVE");
    // A done Ticket still links its PR, with "done" in place of a Stage.
    expect(ticketOf(node(), done)).toMatchObject({ id: "DONE", stage: "done" });
  });

  it("leaves Abandoned Tickets out, and a row with no Ticket empty", () => {
    expect(ticketForPr(row({ state: "abandoned" }), LASSO)).toBeNull();
    expect(ticketOf(node())).toBeNull();
  });

  it("names the Ticket as the Ledger does, and adds its Flag to the verdict's reason", () => {
    expect(one({ name: "PR page" }).ref).toBe("PR page");
    expect(one({ reference: null }).ref).toBe("000000AB");
    const flagged = prRow(node(), ticketMatcher([one({ flagged_at: "2026-10-15T12:00:00Z", flag_reason: "review.unaddressed" })]))!;
    expect(flagged.verdict).toEqual({ word: "Checks running", reason: "waiting on CI · Flagged: review.unaddressed", tone: "run" });
    // A Flag that has been cleared leaves its reason behind, which is not shown.
    expect(prRow(node(), ticketMatcher([one({ flag_reason: "review.unaddressed" })]))!.verdict.reason).toBe("waiting on CI");
  });

  it("is matched at each read of the cache, so a Ticket's changes show without a fetch", async () => {
    let tickets: Array<TicketRow & TicketWithOwned> = [];
    let fetches = 0;
    const cache = new PrLists({
      lists: () => [{ name: "Mine", query: "is:open", limit: 25 }],
      repos: async () => ({ lasso: LASSO }),
      tickets: () => tickets,
      search: async () => {
        fetches++;
        return { ok: true, total: 1, nodes: [node()], rateLimit: null };
      },
      tickMs: () => 60_000,
      refreshMs: () => 300_000,
    });
    await cache.read();
    await cache.settle();
    expect((await cache.read()).lists[0]!.rows[0]!.ticket).toBeNull();
    // A Ticket in a repo with no GitHub origin can't match by branch.
    tickets = [{ ...row({ id: "ELSEWHERE" }), repo: "elsewhere" } as TicketRow & TicketWithOwned, { ...row({ stage: "implement" }), repo: "lasso" } as TicketRow & TicketWithOwned];
    expect((await cache.read()).lists[0]!.rows[0]!.ticket).toMatchObject({ id: ID, stage: "implement" });
    expect(fetches).toBe(1);
  });
});
