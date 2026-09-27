import type { DatabaseSync } from "node:sqlite";
import type { FeedbackItem, FeedbackKind } from "../review/feedback.ts";

/** One Feedback item as a Round saw it, plus the evidence it was addressed once the Round ended (spec: feedback_item). */
export interface FeedbackRow {
  id: number;
  session: string;
  kind: FeedbackKind;
  source_id: string;
  name: string | null;
  url: string | null;
  summary: string;
  path: string | null;
  line: number | null;
  at: string;
  head: string | null;
  body: string | null;
  log: string | null;
  /** How Lasso saw it addressed after the Round, or null while it stands. */
  addressed: string | null;
}

export class Feedback {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** The snapshot a Round starts with: one row per item, in the order the prompt lists them. */
  insert(session: string, items: FeedbackItem[]): FeedbackRow[] {
    const stmt = this.db.prepare(
      `INSERT INTO feedback_item (session, kind, source_id, name, url, summary, path, line, at, head, body, log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) stmt.run(session, item.kind, item.id, item.name, item.url, item.summary, item.path, item.line, item.at, item.head, item.body, item.log);
    return this.forSession(session);
  }

  forSession(session: string): FeedbackRow[] {
    return this.db.prepare(`SELECT * FROM feedback_item WHERE session = ? ORDER BY id`).all(session) as unknown as FeedbackRow[];
  }

  /** Every item any Session of the Stage has seen, newest Session first; what "seen before" means for a check. */
  forStage(ticket: string, stage: string): Array<FeedbackRow & { round: number | null }> {
    return this.db
      .prepare(
        `SELECT f.*, s.round FROM feedback_item f JOIN sessions s ON s.id = f.session WHERE s.ticket = ? AND s.stage = ? ORDER BY s.started_at DESC, f.id`,
      )
      .all(ticket, stage) as unknown as Array<FeedbackRow & { round: number | null }>;
  }

  setAddressed(id: number, evidence: string | null): void {
    this.db.prepare(`UPDATE feedback_item SET addressed = ? WHERE id = ?`).run(evidence, id);
  }
}

/** A stored row back as the item a retry re-runs. */
export function itemOf(row: FeedbackRow): FeedbackItem {
  return { kind: row.kind, id: row.source_id, name: row.name, url: row.url, summary: row.summary, path: row.path, line: row.line, at: row.at, head: row.head, body: row.body, log: row.log };
}
