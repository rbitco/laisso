import type { DatabaseSync } from "node:sqlite";
import { ticketLabel, type TicketRow } from "./tickets.ts";
import type { PrState } from "../review/feedback.ts";

/** Owned: the Ticket's own work, which Laisso drives. Referenced: context only, never acted on (CONTEXT.md). */
export type PrRole = "owned" | "referenced";
/** Who linked the PR: the Tick finding it on the Ticket's branch, a human at the CLI, or an agent in a Session. */
export type PrSource = "branch" | "human" | "agent";

/** One PR linked to a Ticket, with what Laisso last saw of it and the Review state kept per PR. */
export interface PrLinkRow {
  ticket: string;
  /** The PR's canonical URL; one link per Ticket and URL. */
  url: string;
  role: PrRole;
  source: PrSource;
  /** Links are listed in this order. */
  added_at: string;
  /** The tombstone: an unlinked PR stays hidden, and the Tick does not link it again from the branch. */
  unlinked_at: string | null;
  /** What the last read of the PR saw; null until something has read it. */
  title: string | null;
  head: string | null;
  base: string | null;
  author: string | null;
  state: PrState | null;
  /** What the last poll saw of the PR, as JSON (PrStatus), for the displayed state. */
  status: string | null;
  /** The newest PR activity a Round has seen; Feedback after it is new (spec: Review loop). */
  feedback_watermark: string | null;
  /** The Feedback snapshot of a Round that is due to start, as JSON; null when nothing is outstanding. */
  feedback_due: string | null;
}

/** What the last read of a PR saw of it: the facts shown beside the link. */
export type PrLinkFacts = Partial<Pick<PrLinkRow, "title" | "head" | "base" | "author" | "state">>;
/** The per-PR Review state the poll and a Round keep on the link. */
export type PrLinkReview = Partial<Pick<PrLinkRow, "status" | "feedback_watermark" | "feedback_due">>;

/** The GitHub owner/name a Ticket's repo lives at, when Laisso knows it. */
export type GitHubOf = (repo: string) => { owner: string; name: string } | null;

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i;

/**
 * A Ticket's PR links. `link` holds every linking rule; `autoLink` is the
 * Tick's way in, which never revives an unlinked PR. Readers see only live
 * links: a tombstoned row exists only to keep the branch PR from coming back.
 */
export class PrLinks {
  private db: DatabaseSync;
  private changed: (ticket: string) => void;
  private githubOf: GitHubOf;

  /** `changed` hears the Ticket whose links were written; `githubOf` lets `link` hold an Owned PR to the Ticket's repo, and is skipped when it does not know the repo. */
  constructor(db: DatabaseSync, changed: (ticket: string) => void = () => undefined, githubOf: GitHubOf = () => null) {
    this.db = db;
    this.changed = changed;
    this.githubOf = githubOf;
  }

  /**
   * Link a PR, or say why not: an Abandoned Ticket takes no links, an Owned PR
   * must be in the Ticket's repo and owned by no other active Ticket. Linking a
   * linked PR again switches its role; linking an unlinked one revives it.
   */
  link(ticket: TicketRow, url: string, role: PrRole, source: PrSource, now: string = new Date().toISOString()): { link: PrLinkRow } | { refused: string } {
    if (ticket.state === "abandoned") return { refused: `${ticketLabel(ticket)} is Abandoned` };
    if (role === "owned") {
      const github = this.githubOf(ticket.repo);
      const m = PR_URL.exec(url);
      if (github && m && `${m[1]}/${m[2]}`.toLowerCase() !== `${github.owner}/${github.name}`.toLowerCase()) {
        return { refused: `an Owned PR must be in ${github.owner}/${github.name}, the repo of ${ticketLabel(ticket)}; link it with --referenced` };
      }
      const owner = this.ownerOf(url);
      if (owner && owner.id !== ticket.id) return { refused: `${ticketLabel(owner)} owns this PR; link it with --referenced` };
    }
    const had = this.row(ticket.id, url);
    if (!had) {
      this.db.prepare(`INSERT INTO ticket_prs (ticket, url, role, source, added_at) VALUES (?, ?, ?, ?, ?)`).run(ticket.id, url, role, source, now);
    } else if (had.unlinked_at) {
      this.db.prepare(`UPDATE ticket_prs SET role = ?, source = ?, added_at = ?, unlinked_at = NULL WHERE ticket = ? AND url = ?`).run(role, source, now, ticket.id, url);
    } else if (had.role !== role) {
      this.db.prepare(`UPDATE ticket_prs SET role = ? WHERE ticket = ? AND url = ?`).run(role, ticket.id, url);
    }
    this.changed(ticket.id);
    return { link: this.row(ticket.id, url)! };
  }

  /** Unlink a PR; the row stays as a tombstone. False when the PR was not linked. */
  unlink(ticket: string, url: string, now: string = new Date().toISOString()): boolean {
    const done = this.db.prepare(`UPDATE ticket_prs SET unlinked_at = ? WHERE ticket = ? AND url = ? AND unlinked_at IS NULL`).run(now, ticket, url);
    if (done.changes) this.changed(ticket);
    return done.changes > 0;
  }

  /** Whether this PR was unlinked from the Ticket and not linked again: what keeps Laisso's hands off it. */
  unlinked(ticket: string, url: string): boolean {
    return this.row(ticket, url)?.unlinked_at != null;
  }

  /** The Ticket's live links, in the order they were added. */
  links(ticket: string): PrLinkRow[] {
    return this.db.prepare(`SELECT * FROM ticket_prs WHERE ticket = ? AND unlinked_at IS NULL ORDER BY added_at, rowid`).all(ticket) as unknown as PrLinkRow[];
  }

  /** The Ticket's Owned PRs not known to be merged or closed. */
  ownedOpen(ticket: string): PrLinkRow[] {
    return this.links(ticket).filter((l) => l.role === "owned" && l.state !== "MERGED" && l.state !== "CLOSED");
  }

  /** The active Ticket that owns this PR, or null. */
  ownerOf(url: string): TicketRow | null {
    return (
      (this.db
        .prepare(`SELECT t.* FROM ticket_prs l JOIN tickets t ON t.id = l.ticket WHERE l.url = ? AND l.role = 'owned' AND l.unlinked_at IS NULL AND t.state = 'active' ORDER BY l.added_at LIMIT 1`)
        .get(url) as TicketRow | undefined) ?? null
    );
  }

  /** The active and done Tickets that reference this PR. */
  referencersOf(url: string): TicketRow[] {
    return this.db
      .prepare(`SELECT t.* FROM ticket_prs l JOIN tickets t ON t.id = l.ticket WHERE l.url = ? AND l.role = 'referenced' AND l.unlinked_at IS NULL AND t.state != 'abandoned' ORDER BY l.added_at`)
      .all(url) as unknown as TicketRow[];
  }

  /**
   * The Tick's link for the PR on the Ticket's own branch: Owned, source
   * branch. Null, linking nothing, when the PR was unlinked, the Ticket is not
   * active, or another active Ticket owns it. A PR already linked is left as it is.
   */
  autoLink(ticket: TicketRow, url: string, now: string = new Date().toISOString()): PrLinkRow | null {
    const had = this.row(ticket.id, url);
    if (had) return had.unlinked_at ? null : had;
    if (ticket.state !== "active") return null;
    const owner = this.ownerOf(url);
    if (owner && owner.id !== ticket.id) return null;
    this.db.prepare(`INSERT INTO ticket_prs (ticket, url, role, source, added_at) VALUES (?, ?, 'owned', 'branch', ?)`).run(ticket.id, url, now);
    this.changed(ticket.id);
    return this.row(ticket.id, url);
  }

  /** Keep what a read of the PR saw, or its Review state; only a change is written. Not activity on the Ticket, so its updated_at is left alone. */
  update(ticket: string, url: string, patch: PrLinkFacts & PrLinkReview): PrLinkRow | null {
    const had = this.row(ticket, url);
    if (!had) return null;
    const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && had[k as keyof PrLinkRow] !== v);
    if (entries.length) {
      const sets = entries.map(([k]) => `${k} = ?`).join(", ");
      this.db.prepare(`UPDATE ticket_prs SET ${sets} WHERE ticket = ? AND url = ?`).run(...entries.map(([, v]) => v ?? null), ticket, url);
      this.changed(ticket);
    }
    return this.row(ticket, url);
  }

  private row(ticket: string, url: string): PrLinkRow | null {
    return (this.db.prepare(`SELECT * FROM ticket_prs WHERE ticket = ? AND url = ?`).get(ticket, url) as PrLinkRow | undefined) ?? null;
  }
}

/** The Owned PR Review works among these links: the first open one, else the latest, whose merge may still end a Stage. */
export function ownedOf(links: PrLinkRow[]): PrLinkRow | null {
  const owned = links.filter((l) => l.role === "owned");
  return owned.find((l) => l.state !== "MERGED" && l.state !== "CLOSED") ?? owned.at(-1) ?? null;
}

/** Whether any of these links holds the snapshot of a Round due to start. */
export function roundDue(links: PrLinkRow[]): boolean {
  return links.some((l) => l.feedback_due !== null);
}
