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
  /**
   * The Route this run picked with `lasso route`, and its `--note` (LASSO-192). Kept only when the run was met; a
   * not-met or broken run's pick is discarded. The run's id is the Visit's check_run.
   */
  route?: string;
  note?: string | null;
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
  /** 1 when `text` replaces the Stage's prompt text (a Route's replace:), 0 when it follows it (append:). */
  replaces: number;
  /** The Route picked for leaving, pending or overridden, its note, and who picked it. */
  picked_route: string | null;
  picked_note: string | null;
  picked_by: ChosenBy | null;
  /** The latest check Action run here, as JSON (ADR 0014), and the id of that run (its LASSO_SESSION). */
  check_result: string | null;
  check_run: string | null;
  /** When a human skipped the Stage on this Visit (LASSO-159). */
  skipped_at: string | null;
}

/** What a new Visit records of how it began, beyond the Stage. */
export type Arrival = Pick<VisitRow, "stage" | "arrived_by"> & Partial<Pick<VisitRow, "route" | "chosen_by" | "text" | "note">> & { replaces?: boolean };

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
        `INSERT INTO visits (ticket, stage, number, version, arrived_at, arrived_by, from_visit, route, chosen_by, text, note, replaces)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ticket, arrival.stage, number, version, now, arrival.arrived_by, from?.id ?? null, arrival.route ?? null, arrival.chosen_by ?? null, arrival.text ?? null, arrival.note ?? null, arrival.replaces ? 1 : 0);
    this.changed(ticket);
    return this.db.prepare(`SELECT * FROM visits WHERE id = ?`).get(lastInsertRowid) as unknown as VisitRow;
  }

  /**
   * Keep the latest check on the Visit the run checked for, over the one before (ADR 0014). A run that began on a
   * Visit the Ticket has since left (a send, a Skip) writes there, never onto the Visit that replaced it.
   */
  setCheck(ticket: string, visit: number, check: ArtifactCheck, run: string | null = null): void {
    this.db.prepare(`UPDATE visits SET check_result = ?, check_run = ? WHERE id = ? AND ticket = ?`).run(JSON.stringify(check), run, visit, ticket);
    this.changed(ticket);
  }

  /** Record the Route picked for leaving the current Visit, and who picked it, over any picked before; null drops the pick. */
  pick(ticket: string, route: string | null, note: string | null = null, by: ChosenBy | null = null): VisitRow | null {
    this.db
      .prepare(`UPDATE visits SET picked_route = ?, picked_note = ?, picked_by = ? WHERE ticket = ? AND left_at IS NULL`)
      .run(route, route === null ? null : note, route === null ? null : by, ticket);
    this.changed(ticket);
    return this.current(ticket);
  }

  /**
   * How many times each Route of a Stage was taken for the Ticket by an agent, Action or check: the Visits that
   * arrived by that Route from a Visit to the Stage, matched by name so counts carry across Versions. Never reset.
   */
  routeCounts(ticket: string, stage: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT v.route AS route, COUNT(*) AS n FROM visits v JOIN visits f ON f.id = v.from_visit
         WHERE v.ticket = ? AND v.arrived_by = 'route' AND f.stage = ? AND v.chosen_by IS NOT 'human' GROUP BY v.route`,
      )
      .all(ticket, stage) as Array<{ route: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.route, Number(r.n)]));
  }

  /** Record that a human skipped the Stage on the current Visit. */
  setSkipped(ticket: string, now: string = new Date().toISOString()): void {
    this.db.prepare(`UPDATE visits SET skipped_at = ? WHERE ticket = ? AND left_at IS NULL`).run(now, ticket);
    this.changed(ticket);
  }
}
