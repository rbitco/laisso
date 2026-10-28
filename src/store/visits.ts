import type { DatabaseSync } from "node:sqlite";

/** How a Visit began: the Ticket walked forward, took a Route, a human sent it, Intake admitted it, or a Version upgrade landed it. */
export type ArrivedBy = "walk" | "route" | "send" | "intake" | "upgrade";

/** Who chose the Route a Visit arrived by. */
export type ChosenBy = "agent" | "action" | "check" | "human";

/** How a check Action artifact last came out at a Stage: met (exit 0), not met (exit 1), or broken. */
export interface ArtifactCheck {
  action: string;
  result: "met" | "not_met" | "error";
  at: string;
  /** The exit code; null when it timed out or never started. */
  code: number | null;
  /** The last line of its output, or why it could not run. */
  line: string | null;
}

/**
 * A Ticket's stay at one Stage (CONTEXT.md: Visit; LASSO-189). The current
 * Visit is the one not yet left; it may have no Session, as when holding.
 */
export interface VisitRow {
  id: number;
  ticket: string;
  stage: string;
  /** This Visit's number among the Ticket's Visits to the Stage, from 1. */
  number: number;
  /** The Pipeline Version the Ticket ran when it arrived. */
  version: number | null;
  arrived_at: string;
  /** Null while the Ticket is still here, Done or Abandoned ones included. */
  left_at: string | null;
  arrived_by: ArrivedBy;
  /** The Visit the Ticket left to arrive here; null for the first. */
  from_visit: number | null;
  /** The Route taken to arrive, with who chose it and what it adds to the Stage prompt; null unless arrived by Route. */
  route: string | null;
  chosen_by: ChosenBy | null;
  text: string | null;
  note: string | null;
  /** The Route picked for leaving, pending or overridden, and its note. */
  picked_route: string | null;
  picked_note: string | null;
  /** The latest check Action run here, as JSON (ADR 0014), and the id of that run. */
  check_result: string | null;
  check_run: string | null;
  /** When a human skipped the Stage on this Visit (LASSO-159). */
  skipped_at: string | null;
}

/** What a new Visit records of how it began, beyond the Stage. */
export type Arrival = Pick<VisitRow, "stage" | "arrived_by"> & Partial<Pick<VisitRow, "route" | "chosen_by" | "text" | "note">>;

/** The latest check at a Visit, or null before any. */
export function checkOf(visit: Pick<VisitRow, "check_result"> | null): ArtifactCheck | null {
  return visit?.check_result ? (JSON.parse(visit.check_result) as ArtifactCheck) : null;
}

/** A Ticket's latest Visit to a Stage among its Visits, the highest numbered, or null when it never arrived there. */
export function latestVisit<T extends Pick<VisitRow, "stage" | "number">>(visits: T[], stage: string): T | null {
  return visits.reduce<T | null>((latest, v) => (v.stage === stage && (!latest || v.number > latest.number) ? v : latest), null);
}

/** Each arrival at a Stage, the Sessions that belong to it, and what is kept per Visit (LASSO-189). */
export class Visits {
  private db: DatabaseSync;
  private changed: (ticket: string) => void;

  /** `changed` hears the Ticket of every Visit written, after the write lands. */
  constructor(db: DatabaseSync, changed: (ticket: string) => void = () => undefined) {
    this.db = db;
    this.changed = changed;
  }

  /** The Visit the Ticket is on now: the one not yet left. */
  current(ticket: string): VisitRow | null {
    return (this.db.prepare(`SELECT * FROM visits WHERE ticket = ? AND left_at IS NULL`).get(ticket) as VisitRow | undefined) ?? null;
  }

  /** A Ticket's Visits, oldest first. */
  forTicket(ticket: string): VisitRow[] {
    return this.db.prepare(`SELECT * FROM visits WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as VisitRow[];
  }

  /** The latest Visit to a Stage: the current one when the Ticket is there. */
  latest(ticket: string, stage: string): VisitRow | null {
    return (this.db.prepare(`SELECT * FROM visits WHERE ticket = ? AND stage = ? ORDER BY number DESC LIMIT 1`).get(ticket, stage) as VisitRow | undefined) ?? null;
  }

  /**
   * The Ticket arrives at a Stage: the current Visit is left now and a new one
   * opened, numbered after the Stage's last. Callers move the Ticket row with it.
   */
  arrive(ticket: string, version: number | null, arrival: Arrival, now: string = new Date().toISOString()): VisitRow {
    const from = this.current(ticket);
    if (from) this.db.prepare(`UPDATE visits SET left_at = ? WHERE id = ?`).run(now, from.id);
    const number = (this.latest(ticket, arrival.stage)?.number ?? 0) + 1;
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO visits (ticket, stage, number, version, arrived_at, arrived_by, from_visit, route, chosen_by, text, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ticket, arrival.stage, number, version, now, arrival.arrived_by, from?.id ?? null, arrival.route ?? null, arrival.chosen_by ?? null, arrival.text ?? null, arrival.note ?? null);
    this.changed(ticket);
    return this.db.prepare(`SELECT * FROM visits WHERE id = ?`).get(lastInsertRowid) as unknown as VisitRow;
  }

  /** Keep the latest check on the Stage's latest Visit, over the one before (ADR 0014). */
  setCheck(ticket: string, stage: string, check: ArtifactCheck, run: string | null = null): void {
    const visit = this.latest(ticket, stage);
    if (!visit) return;
    this.db.prepare(`UPDATE visits SET check_result = ?, check_run = ? WHERE id = ?`).run(JSON.stringify(check), run, visit.id);
    this.changed(ticket);
  }

  /** Record that a human skipped the Stage on the current Visit. */
  setSkipped(ticket: string, now: string = new Date().toISOString()): void {
    this.db.prepare(`UPDATE visits SET skipped_at = ? WHERE ticket = ? AND left_at IS NULL`).run(now, ticket);
    this.changed(ticket);
  }
}
