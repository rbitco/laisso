import { buildSearch, type GitHubRepo } from "./query.ts";
import type { TicketRow } from "../store/tickets.ts";
import { prRow, ticketForPr, ticketMatcher, type PrNode, type PrRow, type TicketForPr } from "./rows.ts";
import type { PrSearchClient } from "./search.ts";

/** One PR List as config.yaml names it, in page order. */
export interface PrListSetting {
  name: string;
  query: string;
  limit: number;
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
  /** Why the list has no rows to show: it cannot search, or its last fetch failed. */
  error: string | null;
}

/** GET /api/pr-lists: every PR List in config order. */
export interface PrListsView {
  lists: PrListView[];
  /** While GitHub points are low, no list refreshes until this time; null when lists refresh as usual. */
  pausedUntil: string | null;
}

export interface PrListsDeps {
  /** The PR Lists config has now; read at each use, so an edit applies at once. */
  lists: () => PrListSetting[];
  /** The GitHub owner/name of each configured repo, by its name in config.yaml, for scoping and Ticket matching. */
  repos: () => Promise<Record<string, GitHubRepo>>;
  /** Lasso's Tickets as they are now, matched to the rows at each read; none when left out. */
  tickets?: () => TicketRow[];
  search: PrSearchClient;
  /** The Tick's length in ms: the page is open while it has read within two of them, and opening it refreshes lists older than one. */
  tickMs: () => number;
  /** pr_list_refresh in ms: while the page is open, each Tick refreshes lists older than this. */
  refreshMs: () => number;
  /** Hears whenever a list starts or finishes fetching, or the rate-limit pause ends: a read would answer differently. */
  changed?: () => void;
  now?: () => number;
}

/** Below this many GitHub points, PR Lists stop refreshing until GitHub resets the count, so Ticket PR polling keeps working. */
export const RATE_LIMIT_FLOOR = 500;

/**
 * How early a list counts as due. A Tick's timer and the work before this step drift by a few ms from one Tick to the
 * next, so a list fetched one Tick ago may be a hair younger than the Tick and would wait a whole extra one.
 */
const DRIFT_MS = 1000;

/**
 * What the cache holds for one list: the search it ran, its last good search results, and any fetch under way. It
 * keeps GitHub's nodes rather than rows, so each read matches them to the Tickets as they are then.
 */
interface Entry {
  key: string;
  search: string;
  limit: number;
  nodes: PrNode[];
  total: number;
  fetchedAt: string | null;
  error: string | null;
  /** When the last fetch started, good or not; what "older than" measures, so a failing list waits its turn like the rest. */
  triedAt: number | null;
  inflight: Promise<void> | null;
}

/** One list as config has it now, with its cache entry; no entry when it cannot search. */
interface Current {
  setting: PrListSetting;
  url: string | null;
  problem: string | null;
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
      })),
      pausedUntil: this.pausedUntil === null ? null : new Date(this.pausedUntil).toISOString(),
    };
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
      const built = buildSearch(setting.query, Object.values(repos));
      if ("problem" in built) {
        current.push({ setting, url: null, problem: built.problem, entry: null });
        continue;
      }
      const key = `${built.search}\n${setting.limit}`;
      let entry = this.entries.get(setting.name);
      if (!entry || entry.key !== key) {
        entry = { key, search: built.search, limit: setting.limit, nodes: [], total: 0, fetchedAt: null, error: null, triedAt: null, inflight: null };
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

  /** One fetch of one list. A failure keeps the results it had; the list is tried again when next due. */
  private async fetch(entry: Entry): Promise<void> {
    try {
      const result = await this.deps.search(entry.search, entry.limit);
      if (result.ok) {
        entry.nodes = result.nodes;
        entry.total = result.total;
        entry.fetchedAt = new Date(this.now()).toISOString();
        entry.error = null;
        if (result.rateLimit && result.rateLimit.remaining < RATE_LIMIT_FLOOR) {
          const reset = Date.parse(result.rateLimit.resetAt);
          if (Number.isFinite(reset)) this.pausedUntil = Math.max(this.pausedUntil ?? 0, reset);
        }
      } else {
        entry.error = result.message;
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    } finally {
      entry.inflight = null;
      this.deps.changed?.();
    }
  }
}
