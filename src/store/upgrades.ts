import type { DatabaseSync } from "node:sqlite";
import type { TicketRow } from "./tickets.ts";
import type { ChosenBy, VisitRow } from "./visits.ts";

/**
 * One Version upgrade of a Ticket (ADR 0009, LASSO-201). Visit rows are never rewritten by one: the Visit the
 * Ticket was on either continues (its Stage kept its name) or is left for a new one at the landing a human picked.
 */
export interface UpgradeRow {
  id: number;
  ticket: string;
  at: string;
  /** The Version the Ticket ran before; null for one from before Versions. */
  from_version: number | null;
  to_version: number;
  /** The Visit the Ticket was on when upgraded: the one that continues, or the one left for the landing. */
  visit: number;
  /** The upgrade Visit opened at the landing the human picked; null when the Visit continued. */
  landed: number | null;
  /** The Route a pending or held pick named, dropped because the new Version lost it or its target; null when none was. */
  dropped_route: string | null;
  /** Where the dropped Route went in the Version before. */
  dropped_to: string | null;
  dropped_note: string | null;
  dropped_by: ChosenBy | null;
}

export type NewUpgrade = Omit<UpgradeRow, "id">;

/** The upgrades of each Ticket, oldest first. Written only inside `Tickets.upgrade`, beside the move it records. */
export class Upgrades {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  forTicket(ticket: string): UpgradeRow[] {
    return this.db.prepare(`SELECT * FROM upgrades WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as UpgradeRow[];
  }

  insert(row: NewUpgrade): UpgradeRow {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO upgrades (ticket, at, from_version, to_version, visit, landed, dropped_route, dropped_to, dropped_note, dropped_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.ticket, row.at, row.from_version, row.to_version, row.visit, row.landed, row.dropped_route, row.dropped_to, row.dropped_note, row.dropped_by);
    return this.db.prepare(`SELECT * FROM upgrades WHERE id = ?`).get(lastInsertRowid) as unknown as UpgradeRow;
  }
}

/**
 * The Ticket holds at a source Stage whose held Route pick an upgrade dropped (LASSO-201): it stays holding, and
 * Start walks forward from the Stage, which has finished, rather than starting it again.
 */
export function holdDropped(ticket: Pick<TicketRow, "holding_since">, current: Pick<VisitRow, "id" | "picked_route"> | null, upgrades: UpgradeRow[]): boolean {
  if (!ticket.holding_since || !current || current.picked_route) return false;
  return upgrades.some((u) => u.visit === current.id && u.landed === null && u.dropped_route !== null && u.at >= ticket.holding_since!);
}
