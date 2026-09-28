import type { DatabaseSync } from "node:sqlite";

export type TicketState = "active" | "done" | "abandoned";

export interface TicketRow {
  id: string;
  repo: string;
  reference: string | null;
  origin: "tracker" | "prompt";
  prompt: string | null;
  title: string;
  body: string | null;
  pipeline: string;
  /** The Version of the Pipeline this Ticket runs (ADR 0009); null only for a Ticket from before Versions whose file could not be pinned. */
  pipeline_version: number | null;
  stage: string;
  state: TicketState;
  flagged_at: string | null;
  flag_reason: string | null;
  flag_detail: string | null;
  unflagged_at: string | null;
  /** Set while the Ticket waits at a Stage for the Start trigger (the previous Stage said advance: false). */
  holding_since: string | null;
  pr: string | null;
  branch: string;
  worktree: string;
  /** The newest PR activity a Round has seen; Feedback after it is new (spec: Review loop). */
  feedback_watermark: string | null;
  /** The Feedback snapshot of a Round that is due to start, as JSON; null when nothing is outstanding. */
  feedback_due: string | null;
  /** What the last poll saw of the PR, as JSON, for the displayed state. */
  pr_status: string | null;
  mirror_pending: string | null;
  /** The Ticket layer of the Budget: Extend sets these; null defers to the Pipeline and the global default. */
  budget_rounds: number | null;
  budget_attempts: number | null;
  budget_wall_time: string | null;
  budget_spend: number | null;
  /** When a tick first found a headless Stage of this Ticket ready to start; the queue is ordered by it. Cleared when a Session starts or the Ticket stops being runnable. */
  runnable_since: string | null;
  /** When the Ticket became done or Abandoned; the retention sweep counts from it. */
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The tail of the ULID humans quote when a Ticket has no tracker reference. */
export function shortId(id: string): string {
  return id.slice(-8);
}

export type NewTicket = Pick<TicketRow, "id" | "repo" | "reference" | "origin" | "prompt" | "title" | "body" | "pipeline" | "pipeline_version" | "stage" | "branch" | "worktree">;

/** Current-state rows for Tickets; Sessions are the history (spec: Store). */
export class Tickets {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insert(ticket: NewTicket, now: string = new Date().toISOString()): TicketRow {
    this.db
      .prepare(
        `INSERT INTO tickets (id, repo, reference, origin, prompt, title, body, pipeline, pipeline_version, stage, state, branch, worktree, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(ticket.id, ticket.repo, ticket.reference, ticket.origin, ticket.prompt, ticket.title, ticket.body, ticket.pipeline, ticket.pipeline_version, ticket.stage, ticket.branch, ticket.worktree, now, now);
    return this.get(ticket.id)!;
  }

  get(id: string): TicketRow | null {
    return (this.db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as TicketRow | undefined) ?? null;
  }

  /** Look a Ticket up by ULID, by tracker reference, or by a unique ULID suffix. */
  find(key: string): TicketRow | null {
    const exact = this.get(key) ?? (this.db.prepare(`SELECT * FROM tickets WHERE reference = ? ORDER BY created_at DESC LIMIT 1`).get(key) as TicketRow | undefined);
    if (exact) return exact;
    const rows = this.db.prepare(`SELECT * FROM tickets WHERE id LIKE ?`).all("%" + key.toUpperCase()) as unknown as TicketRow[];
    return rows.length === 1 ? rows[0]! : null;
  }

  activeByReference(reference: string): TicketRow | null {
    return (this.db.prepare(`SELECT * FROM tickets WHERE reference = ? AND state = 'active'`).get(reference) as TicketRow | undefined) ?? null;
  }

  list(opts: { all?: boolean } = {}): TicketRow[] {
    const sql = opts.all ? `SELECT * FROM tickets ORDER BY created_at DESC` : `SELECT * FROM tickets WHERE state = 'active' ORDER BY created_at DESC`;
    return this.db.prepare(sql).all() as unknown as TicketRow[];
  }

  /** Tickets from before Pipeline Versions, not yet pinned to one. */
  unpinned(): TicketRow[] {
    return this.db.prepare(`SELECT * FROM tickets WHERE pipeline_version IS NULL`).all() as unknown as TicketRow[];
  }

  /** Migration bookkeeping only: not activity on the Ticket, so updated_at is left alone. */
  pinVersion(id: string, version: number): void {
    this.db.prepare(`UPDATE tickets SET pipeline_version = ? WHERE id = ?`).run(version, id);
  }

  /** Mirror bookkeeping only: it is not activity on the Ticket, so updated_at is left alone. */
  setMirrorPending(id: string, since: string | null): void {
    this.db.prepare(`UPDATE tickets SET mirror_pending = ? WHERE id = ?`).run(since, id);
  }

  /** Queue bookkeeping only: not activity on the Ticket, so updated_at is left alone. */
  setRunnableSince(id: string, since: string | null): void {
    this.db.prepare(`UPDATE tickets SET runnable_since = ? WHERE id = ?`).run(since, id);
  }

  update(id: string, patch: Partial<Omit<TicketRow, "id" | "created_at">>, now: string = new Date().toISOString()): TicketRow {
    const entries = Object.entries({ ...patch, updated_at: now });
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE tickets SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v as string | number | null), id);
    return this.get(id)!;
  }
}
