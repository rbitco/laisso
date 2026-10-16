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
  fetchedAt: string | null;
  /** Why the list has no rows to show: it cannot search, or its last fetch failed. */
  error: string | null;
}

/** GET /api/pr-lists: every PR List in config order. */
export interface PrListsView {
  lists: PrListView[];
}

export interface PrListsDeps {
  /** The PR Lists config has now; read at each read, so an edit applies at once. */
  lists: () => PrListSetting[];
  /** The GitHub owner/name of each configured repo, by its name in config.yaml, for scoping and Ticket matching. */
  repos: () => Promise<Record<string, GitHubRepo>>;
  /** Lasso's Tickets as they are now, matched to the rows at each read; none when left out. */
  tickets?: () => TicketRow[];
  search: PrSearchClient;
  now?: () => number;
}

/**
 * What the cache holds for one list: the search it ran, its last good search results, and any fetch under way. It
 * keeps GitHub's nodes rather than rows, so each read matches them to the Tickets as they are then.
 */
interface Entry {
  key: string;
  nodes: PrNode[];
  total: number;
  fetchedAt: string | null;
  error: string | null;
  fetched: boolean;
  inflight: Promise<void> | null;
}

/**
 * The PR Lists, held in server memory and shared by every tab. For now a read
 * fetches each list that has not been fetched yet (or whose search changed,
 * or whose last fetch failed) and waits for it; concurrent reads share one
 * fetch per list. Lists config no longer names are dropped.
 */
export class PrLists {
  private deps: PrListsDeps;
  private now: () => number;
  private entries = new Map<string, Entry>();

  constructor(deps: PrListsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async read(): Promise<PrListsView> {
    const settings = this.deps.lists();
    const repos = settings.length ? await this.deps.repos() : {};
    const shown: { setting: PrListSetting; search: string | null; url: string | null; problem: string | null; entry: Entry | null }[] = [];
    for (const setting of settings) {
      const built = buildSearch(setting.query, Object.values(repos));
      if ("problem" in built) {
        shown.push({ setting, search: null, url: null, problem: built.problem, entry: null });
        continue;
      }
      const key = `${built.search}\n${setting.limit}`;
      let entry = this.entries.get(setting.name);
      if (!entry || entry.key !== key) {
        entry = { key, nodes: [], total: 0, fetchedAt: null, error: null, fetched: false, inflight: null };
        this.entries.set(setting.name, entry);
      }
      if (!entry.fetched) entry.inflight ??= this.fetch(entry, built.search, setting.limit);
      shown.push({ setting, search: built.search, url: built.url, problem: null, entry });
    }
    const names = new Set(settings.map((s) => s.name));
    for (const name of [...this.entries.keys()]) if (!names.has(name)) this.entries.delete(name);
    await Promise.all(shown.map((s) => s.entry?.inflight));
    // Tickets are read after the fetches, so a row links the Ticket as it is now, not as it was at the fetch.
    const tickets = (this.deps.tickets?.() ?? []).map((t) => ticketForPr(t, repos[t.repo] ?? null)).filter((t): t is TicketForPr => t !== null);
    const match = ticketMatcher(tickets);
    return {
      lists: shown.map(({ setting, search, url, problem, entry }) => ({
        name: setting.name,
        query: setting.query,
        search,
        url,
        limit: setting.limit,
        rows: (entry?.nodes ?? []).map((node) => prRow(node, match)).filter((row): row is PrRow => row !== null),
        total: entry?.total ?? 0,
        fetchedAt: entry?.fetchedAt ?? null,
        error: problem ?? entry?.error ?? null,
      })),
    };
  }

  /** One fetch of one list. A failure keeps the results it had and is tried again on the next read. */
  private async fetch(entry: Entry, search: string, limit: number): Promise<void> {
    try {
      const result = await this.deps.search(search, limit);
      if (result.ok) {
        entry.nodes = result.nodes;
        entry.total = result.total;
        entry.fetchedAt = new Date(this.now()).toISOString();
        entry.error = null;
        entry.fetched = true;
      } else {
        entry.error = result.message;
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    } finally {
      entry.inflight = null;
    }
  }
}
