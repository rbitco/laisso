import type { DatabaseSync } from "node:sqlite";
import { loadPipeline, pipelineFile, PipelineError, type Pipeline } from "../pipeline/load.ts";
import type { Tickets, TicketRow } from "./tickets.ts";

/** How the Pipeline file stands against a Ticket's Version: the same content, changed since, deleted, or not loading. */
export type Drift = "same" | "changed" | "deleted" | "broken";

export interface VersionRow {
  pipeline: string;
  version: number;
  created_at: string;
  /** Active Tickets pinned to it. */
  live: number;
}

/**
 * Frozen copies of Pipelines (ADR 0009). Intake pins a Ticket to one, so no
 * later edit to the file reaches a Ticket already under way. A Version is
 * numbered only when a Ticket first needs content that differs from the last.
 */
export class PipelineVersions {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** The Version number of this Pipeline's content: the last one when identical, otherwise the next. */
  pin(pipeline: Pipeline, now: string = new Date().toISOString()): number {
    const definition = JSON.stringify(pipeline);
    const last = this.db.prepare(`SELECT version, definition FROM pipeline_versions WHERE pipeline = ? ORDER BY version DESC LIMIT 1`).get(pipeline.name) as
      | { version: number; definition: string }
      | undefined;
    if (last && last.definition === definition) return last.version;
    const version = (last?.version ?? 0) + 1;
    this.db.prepare(`INSERT INTO pipeline_versions (pipeline, version, definition, created_at) VALUES (?, ?, ?, ?)`).run(pipeline.name, version, definition, now);
    return version;
  }

  /** A Version with how many active Tickets run it, or null when it was never numbered. */
  row(name: string, version: number): VersionRow | null {
    return (this.db.prepare(`${VERSION_ROWS} WHERE v.pipeline = ? AND v.version = ? GROUP BY v.version`).get(name, version) as VersionRow | undefined) ?? null;
  }

  /** The Versions of a Pipeline that active Tickets still run, oldest first. */
  live(name: string): VersionRow[] {
    return this.db.prepare(`${VERSION_ROWS} WHERE v.pipeline = ? GROUP BY v.version HAVING live > 0 ORDER BY v.version`).all(name) as unknown as VersionRow[];
  }

  /** Whether the Pipeline file has moved on from this Ticket's Version; null for a Ticket that runs the file itself. */
  drift(ticket: TicketRow, pipelinesDir: string): Drift | null {
    if (ticket.pipeline_version === null) return null;
    if (!pipelineFile(pipelinesDir, ticket.pipeline)) return "deleted";
    let current: Pipeline;
    try {
      current = loadPipeline(pipelinesDir, ticket.pipeline);
    } catch {
      return "broken";
    }
    const pinned = this.db.prepare(`SELECT definition FROM pipeline_versions WHERE pipeline = ? AND version = ?`).get(ticket.pipeline, ticket.pipeline_version) as { definition: string } | undefined;
    return pinned?.definition === JSON.stringify(current) ? "same" : "changed";
  }

  get(name: string, version: number): Pipeline | null {
    const row = this.db.prepare(`SELECT definition FROM pipeline_versions WHERE pipeline = ? AND version = ?`).get(name, version) as { definition: string } | undefined;
    return row ? (JSON.parse(row.definition) as Pipeline) : null;
  }

  /** The Pipeline a Ticket runs: its pinned Version, or the file for a Ticket that could not be pinned. */
  forTicket(ticket: TicketRow, pipelinesDir: string): Pipeline {
    if (ticket.pipeline_version === null) return loadPipeline(pipelinesDir, ticket.pipeline);
    const pipeline = this.get(ticket.pipeline, ticket.pipeline_version);
    if (!pipeline) throw new PipelineError(`Pipeline ${ticket.pipeline} v${ticket.pipeline_version} is not in the store`);
    return pipeline;
  }

  /** Pin every Ticket from before Versions to its Pipeline file as it is now; a Ticket whose file is gone or broken stays unpinned. */
  pinUnpinned(tickets: Tickets, pipelinesDir: string): void {
    for (const ticket of tickets.unpinned()) {
      let pipeline: Pipeline;
      try {
        pipeline = loadPipeline(pipelinesDir, ticket.pipeline);
      } catch {
        continue;
      }
      tickets.pinVersion(ticket.id, this.pin(pipeline));
    }
  }
}

const VERSION_ROWS = `SELECT v.pipeline, v.version, v.created_at, COUNT(t.id) AS live FROM pipeline_versions v
  LEFT JOIN tickets t ON t.pipeline = v.pipeline AND t.pipeline_version = v.version AND t.state = 'active'`;
