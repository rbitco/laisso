import type { DatabaseSync } from "node:sqlite";
import type { OutcomeStatus } from "../runner/adapter.ts";
import type { RunnerName } from "../pipeline/load.ts";
import type { Effort, Permission, ProfileSettings } from "../server/config.ts";

export type SessionMode = "headless" | "terminal" | "action";

/** The Agent Profile a Session ran under, by name, and what it resolved to then; profiles are live config, so this is the record. */
export interface SessionProfile {
  name: string;
  runner: RunnerName;
  model: string | null;
  /** Null when the profile left it unset, so the Runner's default applied. */
  effort: Effort | null;
  /** Null when the profile left it unset, so the adapter's baseline for the mode applied. */
  permission: Permission | null;
  args: string[];
}
export type EndedReason = "shutdown" | "wall_time" | "abandon" | "stop";

export interface SessionRow {
  id: string;
  ticket: string;
  stage: string;
  /** This Session's number within its Stage for its Ticket. */
  ordinal: number;
  /** The Round this Session worked, in a repeating Stage; a retry re-runs the same Round, so several Sessions share one. */
  round: number | null;
  stage_snapshot: string;
  mode: SessionMode;
  started_by: "auto" | "human";
  started_at: string;
  ended_at: string | null;
  ended_by: "outcome" | "human" | null;
  ended_reason: EndedReason | null;
  outcome: OutcomeStatus | null;
  final_message: string | null;
  usage: string | null;
  cost_usd: number | null;
  limits_honoured: string | null;
  stdout_path: string | null;
  transcript_path: string | null;
  pid: number | null;
  /** When a terminal Session's window was last opened (Open terminal, or Resume). */
  opened_at: string | null;
  /** The id the Runner gave this Session when it names its own (a Codex thread); null when it took Lasso's. */
  runner_session_id: string | null;
  /** A SessionProfile as JSON; null for action Sessions and those from before Agent Profiles. */
  profile: string | null;
}

export type NewSession = Pick<SessionRow, "id" | "ticket" | "stage" | "stage_snapshot" | "mode" | "started_by" | "stdout_path" | "limits_honoured"> & Partial<Pick<SessionRow, "transcript_path" | "round" | "profile">>;

export type SessionEnd = Pick<SessionRow, "ended_by" | "ended_reason" | "outcome" | "final_message" | "usage" | "cost_usd" | "transcript_path"> & Partial<Pick<SessionRow, "runner_session_id">>;

/** One row per Runner process (or action) that worked a Stage of a Ticket; the history the Ticket row lacks (spec: Store). */
export class Sessions {
  private db: DatabaseSync;
  private changed: (ticket: string) => void;

  /** `changed` hears the Ticket of every Session written, after the write lands. */
  constructor(db: DatabaseSync, changed: (ticket: string) => void = () => undefined) {
    this.db = db;
    this.changed = changed;
  }

  insert(session: NewSession, now: string = new Date().toISOString()): SessionRow {
    const ordinal = this.count(session.ticket, session.stage) + 1;
    this.db
      .prepare(
        `INSERT INTO sessions (id, ticket, stage, ordinal, stage_snapshot, mode, started_by, started_at, stdout_path, limits_honoured, transcript_path, round, profile)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(session.id, session.ticket, session.stage, ordinal, session.stage_snapshot, session.mode, session.started_by, now, session.stdout_path, session.limits_honoured, session.transcript_path ?? null, session.round ?? null, session.profile ?? null);
    this.changed(session.ticket);
    return this.get(session.id)!;
  }

  get(id: string): SessionRow | null {
    return (this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined) ?? null;
  }

  /** A Ticket's Sessions, newest first. */
  forTicket(ticket: string): SessionRow[] {
    return this.db.prepare(`SELECT * FROM sessions WHERE ticket = ? ORDER BY started_at DESC, ordinal DESC`).all(ticket) as unknown as SessionRow[];
  }

  /** The newest Session of a Ticket, running or not. */
  latest(ticket: string): SessionRow | null {
    return (this.db.prepare(`SELECT * FROM sessions WHERE ticket = ? ORDER BY started_at DESC, ordinal DESC LIMIT 1`).get(ticket) as SessionRow | undefined) ?? null;
  }

  running(ticket?: string): SessionRow[] {
    const sql = `SELECT * FROM sessions WHERE ended_at IS NULL` + (ticket ? ` AND ticket = ?` : ``) + ` ORDER BY started_at ASC`;
    const stmt = this.db.prepare(sql);
    return (ticket ? stmt.all(ticket) : stmt.all()) as unknown as SessionRow[];
  }

  setOpened(id: string, now: string = new Date().toISOString()): SessionRow {
    this.db.prepare(`UPDATE sessions SET opened_at = ? WHERE id = ?`).run(now, id);
    return this.touched(id);
  }

  setPid(id: string, pid: number | null): void {
    this.db.prepare(`UPDATE sessions SET pid = ? WHERE id = ?`).run(pid, id);
  }

  setRunnerSession(id: string, runnerSessionId: string): SessionRow {
    this.db.prepare(`UPDATE sessions SET runner_session_id = ? WHERE id = ?`).run(runnerSessionId, id);
    return this.touched(id);
  }

  end(id: string, end: SessionEnd, now: string = new Date().toISOString()): SessionRow {
    this.db
      .prepare(
        `UPDATE sessions SET ended_at = ?, ended_by = ?, ended_reason = ?, outcome = ?, final_message = ?, usage = ?, cost_usd = ?, transcript_path = ?,
           runner_session_id = COALESCE(?, runner_session_id), pid = NULL
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(now, end.ended_by, end.ended_reason, end.outcome, end.final_message, end.usage, end.cost_usd, end.transcript_path, end.runner_session_id ?? null, id);
    return this.touched(id);
  }

  /** The newest headless Session of the Stage that worked a Round, or null before the first. */
  latestRound(ticket: string, stage: string): SessionRow | null {
    return (this.db.prepare(`SELECT * FROM sessions WHERE ticket = ? AND stage = ? AND mode = 'headless' AND round IS NOT NULL ORDER BY started_at DESC, ordinal DESC LIMIT 1`).get(ticket, stage) as SessionRow | undefined) ?? null;
  }

  /** The highest Round any Session of the Stage worked, or 0 before the first. */
  lastRound(ticket: string, stage: string): number {
    const row = this.db.prepare(`SELECT MAX(round) AS n FROM sessions WHERE ticket = ? AND stage = ?`).get(ticket, stage) as { n: number | null };
    return row.n ?? 0;
  }

  private touched(id: string): SessionRow {
    const row = this.get(id)!;
    this.changed(row.ticket);
    return row;
  }

  private count(ticket: string, stage: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ticket = ? AND stage = ?`).get(ticket, stage) as { n: number };
    return row.n;
  }
}

/** The record of what a Session runs under, for its row. */
export function sessionProfile(name: string, profile: ProfileSettings): string {
  const record: SessionProfile = { name, runner: profile.runner, model: profile.model ?? null, effort: profile.effort ?? null, permission: profile.permission ?? null, args: profile.args ?? [] };
  return JSON.stringify(record);
}

/** The Runner a Session ran on: its profile record, else the Stage snapshot of a Session from before Agent Profiles; null for neither. */
export function runnerOf(row: SessionRow): RunnerName | null {
  if (row.profile) return (JSON.parse(row.profile) as SessionProfile).runner;
  try {
    const runner = (JSON.parse(row.stage_snapshot) as { runner?: unknown }).runner;
    return typeof runner === "string" ? (runner as RunnerName) : null;
  } catch {
    return null;
  }
}
