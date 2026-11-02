import { buildSearch, type GitHubRepo, type SearchSyntax } from "./query.ts";
import type { TicketRow } from "../store/tickets.ts";
import { prRow, ticketForPr, ticketMatcher, type PrNode, type PrRow, type TicketForPr, type TicketWithOwned } from "./rows.ts";
import type { PrSearchClient, SearchProblem } from "./search.ts";
import type { PrPageLayout } from "../server/config.ts";

/** One PR List as config.yaml names it, in page order. */
export interface PrListSetting {
  name: string;
  query: string;
  limit: number;
  /** GitHub's advanced search, with AND, OR and parentheses; legacy when left out. */
  search?: SearchSyntax;
  hide_when_empty?: boolean;
}

/** A PR List as the Pull Requests page shows it. */
export interface PrListView {
  name: string;
  /** The query as config.yaml has it. */
  query: string;
  /** The search sent to GitHub, and the same search on github.com; null when the list cannot search. */
  search: string | null;
  url: string | null;
  limit: number;
  rows: PrRow[];
  /** How many PRs match on GitHub, which may be more than the rows shown. */
  total: number;
  /** When the rows were fetched; null before the list's first good fetch, when the page shows placeholder rows. */
  fetchedAt: string | null;
  /** A fetch of this list is under way. */
  fetching: boolean;
  /** Why the list cannot search, or why its last fetch failed; null when it is fine. */
  error: PrListError | null;
  /**
   * hide_when_empty is set and its last fetch succeeded with no PRs, so the page leaves it out. Never before the first
   * fetch or after a failed one, and a refresh under way keeps the last answer, so the list doesn't flicker.
   */
  hidden: boolean;
}

/**
 * What is wrong with one list. no-github-repos: it is scoped to the configured repos and none is on GitHub, so it never
 * searches. rejected: GitHub refused its query. failed and rate-limited: its last fetch did not come back, and the next
 * due refresh tries again.
 */
export interface PrListError {
  kind: "no-github-repos" | "rejected" | "failed" | "rate-limited";
  message: string;
}

/** A problem with gh itself, which every list shares: it is not installed, or not logged in. */
export interface GhProblem {
  kind: "gh-missing" | "not-logged-in";
  message: string;
}

/** GET /api/pr-lists: every PR List in config order. */
export interface PrListsView {
  lists: PrListView[];
  /** pr_page_layout: the layout a browser that hasn't picked one for itself shows. */
  layout: PrPageLayout;
  /** While GitHub points are low, no list refreshes until this time; null when lists refresh as usual. */
  pausedUntil: string | null;
  /** gh is missing or logged out, so no list can fetch; the page shows this in place of the lists. Cleared by the next fetch gh answers. */
  ghProblem: GhProblem | null;
  /** With no lists configured, the default pr_lists: block as YAML, for the page to show as an example; null otherwise. */
  example: string | null;
}

/** GET /api/pr-lists/status: whether anything on the Pull Requests page needs a look, for the nav's dot. */
export interface PrListsStatus {
  /** gh is missing or logged out, or some list's last fetch failed. A rate-limit pause and an empty list don't count. */
  failing: boolean;
}

export interface PrListsDeps {
  /** The PR Lists config has now; read at each use, so an edit applies at once. */
  lists: () => PrListSetting[];
  /** The GitHub owner/name of each configured repo, by its name in config.yaml, for scoping and Ticket matching. */
  repos: () => Promise<Record<string, GitHubRepo>>;
  /** Laisso's Tickets as they are now, matched to the rows at each read; none when left out. */
  tickets?: () => Array<TicketRow & TicketWithOwned>;
  search: PrSearchClient;
  /** The Tick's length in ms: the page is open while it has read within two of them, and opening it refreshes lists older than one. */
  tickMs: () => number;
  /** pr_list_refresh in ms: while the page is open, each Tick refreshes lists older than this. */
  refreshMs: () => number;
  /** Hears whenever a list starts or finishes fetching, or the rate-limit pause ends: a read would answer differently. */
  changed?: () => void;
  /** The default pr_lists: block as YAML, shown when config has no lists. */
  example?: string;
  /** pr_page_layout as config has it now; stacked when left out. */
  layout?: () => PrPageLayout;
  now?: () => number;
}

/** Below this many GitHub points, PR Lists stop refreshing until GitHub resets the count, so Ticket PR polling keeps working. */
export const RATE_LIMIT_FLOOR = 500;

/**
 * How early a list counts as due. A Tick's timer and the work before this step drift by a few ms from one Tick to the
 * next, so a list fetched one Tick ago may be a hair younger than the Tick and would wait a whole extra one.
 */
const DRIFT_MS = 1000;

/** Search problems that are gh's, not one list's. */
const GH_PROBLEMS = new Set<SearchProblem>(["gh-missing", "not-logged-in"]);

/**
 * What the cache holds for one list: the search it ran, its last good search results, and any fetch under way. It
 * keeps GitHub's nodes rather than rows, so each read matches them to the Tickets as they are then.
 */
interface Entry {
  key: string;
  search: string;
  syntax: SearchSyntax;
  limit: number;
  nodes: PrNode[];
  total: number;
  fetchedAt: string | null;
  error: PrListError | null;
  /** When the last fetch started, good or not; what "older than" measures, so a failing list waits its turn like the rest. */
  triedAt: number | null;
  inflight: Promise<void> | null;
}

/** One list as config has it now, with its cache entry; no entry when it cannot search. */
interface Current {
  setting: PrListSetting;
  url: string | null;
  problem: PrListError | null;
  entry: Entry | null;
}

/**
 * The PR Lists, held in server memory and shared by every tab. A read answers at once from the cache, and marks the
 * page open; it never waits on GitHub. Lists refresh only while the page is open:
 *
 * - a read after the page was closed refreshes lists older than one Tick, and one that has never fetched;
 * - each Tick refreshes lists older than pr_list_refresh;
 * - Check now refreshes every list.
 *
 * A list already fetching is joined, not fetched twice. A fetch that leaves fewer than RATE_LIMIT_FLOOR GitHub points
 * pauses all of them until GitHub's reset; the first Tick after it resumes them. Lists config no longer names are
 * dropped, and an edited one starts afresh.
 */
export class PrLists {
  private deps: PrListsDeps;
  private now: () => number;
  private entries = new Map<string, Entry>();
  private lastRead: number | null = null;
  private pausedUntil: number | null = null;
  private ghProblem: GhProblem | null = null;

  constructor(deps: PrListsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** A snapshot of every list. It starts any fetch now due, and does not wait for it. */
  async read(): Promise<PrListsView> {
    const opening = !this.open();
    this.lastRead = this.now();
    const { current, repos } = await this.current();
    this.refresh(current, opening ? this.deps.tickMs() : Infinity);
    const tickets = (this.deps.tickets?.() ?? []).map((t) => ticketForPr(t, repos[t.repo] ?? null)).filter((t): t is TicketForPr => t !== null);
    const match = ticketMatcher(tickets);
    return {
      layout: this.deps.layout?.() ?? "stacked",
      lists: current.map(({ setting, url, problem, entry }) => ({
        name: setting.name,
        query: setting.query,
        search: entry?.search ?? null,
        url,
        limit: setting.limit,
        rows: (entry?.nodes ?? []).map((node) => prRow(node, match)).filter((row): row is PrRow => row !== null),
        total: entry?.total ?? 0,
        fetchedAt: entry?.fetchedAt ?? null,
        fetching: entry?.inflight != null,
        error: problem ?? entry?.error ?? null,
        hidden: !!setting.hide_when_empty && !problem && !!entry && entry.fetchedAt !== null && entry.error === null && entry.total === 0,
      })),
      pausedUntil: this.pausedUntil === null ? null : new Date(this.pausedUntil).toISOString(),
      ghProblem: current.length ? this.ghProblem : null,
      example: current.length ? null : (this.deps.example ?? null),
    };
  }

  /**
   * Whether a gh problem stands or some configured list's last fetch failed, from the cache alone. Unlike read() it
   * does not mark the page open, start a fetch or look up repos, so the nav can ask on every page.
   */
  status(): PrListsStatus {
    const names = new Set(this.deps.lists().map((l) => l.name));
    if (!names.size) return { failing: false };
    if (this.ghProblem) return { failing: true };
    return { failing: [...this.entries].some(([name, e]) => names.has(name) && (e.error?.kind === "rejected" || e.error?.kind === "failed")) };
  }

  /** The Tick's step: with the page open, refresh lists older than pr_list_refresh. It starts the fetches and does not wait for them. */
  async onTick(): Promise<void> {
    this.resume();
    if (!this.open()) return;
    this.refresh((await this.current()).current, this.deps.refreshMs());
  }

  /** Check now: with the page open, refresh every list. */
  async checkNow(): Promise<void> {
    this.resume();
    if (!this.open()) return;
    this.refresh((await this.current()).current, 0);
  }

  /** Resolves once every fetch under way is through. */
  async settle(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.inflight));
  }

  /** The page counts as open while some tab has read within the last two Ticks. */
  private open(): boolean {
    return this.lastRead !== null && this.now() - this.lastRead <= 2 * this.deps.tickMs();
  }

  /** The first Tick (or Check now) after GitHub's reset lifts a rate-limit pause. */
  private resume(): void {
    if (this.pausedUntil === null || this.now() < this.pausedUntil) return;
    this.pausedUntil = null;
    this.deps.changed?.();
  }

  /** Each list config names now, with its entry: a new or edited list gets a fresh one, and a removed one is dropped. */
  private async current(): Promise<{ current: Current[]; repos: Record<string, GitHubRepo> }> {
    const settings = this.deps.lists();
    const repos = settings.length ? await this.deps.repos() : {};
    const current: Current[] = [];
    for (const setting of settings) {
      const syntax = setting.search ?? "legacy";
      const built = buildSearch(setting.query, Object.values(repos), syntax);
      if ("problem" in built) {
        current.push({ setting, url: null, problem: { kind: "no-github-repos", message: built.problem }, entry: null });
        continue;
      }
      const key = `${syntax}\n${built.search}\n${setting.limit}`;
      let entry = this.entries.get(setting.name);
      if (!entry || entry.key !== key) {
        entry = { key, search: built.search, syntax, limit: setting.limit, nodes: [], total: 0, fetchedAt: null, error: null, triedAt: null, inflight: null };
        this.entries.set(setting.name, entry);
      }
      current.push({ setting, url: built.url, problem: null, entry });
    }
    const names = new Set(settings.map((s) => s.name));
    for (const name of [...this.entries.keys()]) if (!names.has(name)) this.entries.delete(name);
    return { current, repos };
  }

  /** Start a fetch of each list not fetching that has never been tried or was last tried at least `olderThan` ms ago; none while paused. */
  private refresh(current: Current[], olderThan: number): void {
    if (this.pausedUntil !== null) return;
    const at = this.now();
    const due = current.flatMap(({ entry }) => (entry && !entry.inflight && (entry.triedAt === null || at - entry.triedAt >= olderThan - DRIFT_MS) ? [entry] : []));
    if (!due.length) return;
    for (const entry of due) {
      entry.triedAt = at;
      entry.inflight = this.fetch(entry);
    }
    this.deps.changed?.();
  }

  /**
   * One fetch of one list. A temporary failure keeps the results it had; a rejected query drops them, since they no
   * longer answer it. gh missing or logged out is the page's problem rather than the list's, and any answer gh gives
   * clears it. Either way the list is tried again when next due.
   */
  private async fetch(entry: Entry): Promise<void> {
    try {
      const result = await this.deps.search(entry.search, entry.limit, entry.syntax);
      const gh = !result.ok && GH_PROBLEMS.has(result.problem);
      if (!gh) this.ghProblem = null;
      if (result.ok) {
        entry.nodes = result.nodes;
        entry.total = result.total;
        entry.fetchedAt = new Date(this.now()).toISOString();
        entry.error = null;
        if (result.rateLimit && result.rateLimit.remaining < RATE_LIMIT_FLOOR) {
          const reset = Date.parse(result.rateLimit.resetAt);
          if (Number.isFinite(reset)) this.pausedUntil = Math.max(this.pausedUntil ?? 0, reset);
        }
      } else if (gh) {
        this.ghProblem = { kind: result.problem as GhProblem["kind"], message: result.message };
      } else if (result.problem === "rejected") {
        entry.error = { kind: "rejected", message: result.message };
        entry.nodes = [];
        entry.total = 0;
        entry.fetchedAt = null;
      } else {
        entry.error = { kind: result.problem === "rate-limited" ? "rate-limited" : "failed", message: result.message };
      }
    } catch (error) {
      entry.error = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      entry.inflight = null;
      this.deps.changed?.();
    }
  }
}
