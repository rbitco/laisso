import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** How many store backups to keep in the backups directory; older ones are deleted. */
export const KEEP_BACKUPS = 5;

export interface StoreOptions {
  /** Where to copy the store before migrating it. Without one, nothing is backed up. */
  backupsDir?: string;
  now?: () => Date;
}

/** The store was migrated by a newer Lasso than this one; opening it would run code against a schema it does not know. */
export class StoreTooNew extends Error {
  readonly schema: number;

  constructor(schema: number) {
    super(`this Lasso home was last used by a newer Lasso (schema ${schema}); install that version or newer`);
    this.name = "StoreTooNew";
    this.schema = schema;
  }
}

/** The one SQLite store. Only the running lasso process opens it for writing (ADR 0008). */
export class Store {
  db: DatabaseSync;

  constructor(file: string, opts: StoreOptions = {}) {
    this.db = new DatabaseSync(file);
    // Read the schema before anything writes, so a refused store is left exactly as it was.
    const version = this.schemaVersion();
    if (version > MIGRATIONS.length) {
      this.db.close();
      throw new StoreTooNew(version);
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // A brand-new store (schema 0) has nothing to lose, so only an existing one is copied aside.
    if (version > 0 && version < MIGRATIONS.length && opts.backupsDir) this.backup(opts.backupsDir, version, (opts.now ?? (() => new Date()))());
    this.migrate(version);
  }

  private schemaVersion(): number {
    const meta = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
    if (!meta) return 0;
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /** A consistent copy, WAL included, named so the newest sort last; keeps the newest KEEP_BACKUPS. */
  private backup(dir: string, version: number, at: Date): void {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `lasso-${at.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}-schema${version}.db`);
    rmSync(file, { force: true });
    this.db.prepare("VACUUM INTO ?").run(file);
    const backups = readdirSync(dir)
      .filter((name) => BACKUP_NAME.test(name))
      .sort();
    for (const name of backups.slice(0, -KEEP_BACKUPS)) rmSync(path.join(dir, name), { force: true });
  }

  private migrate(from: number): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    let version = from;
    for (const migration of MIGRATIONS.slice(version)) {
      this.db.exec("BEGIN");
      try {
        migration(this.db);
        version += 1;
        this.db
          .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(String(version));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

const BACKUP_NAME = /^lasso-.+-schema\d+\.db$/;

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        reference TEXT,
        origin TEXT NOT NULL CHECK (origin IN ('tracker', 'prompt')),
        prompt TEXT,
        title TEXT NOT NULL,
        body TEXT,
        pipeline TEXT NOT NULL,
        stage TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'done', 'abandoned')),
        flagged_at TEXT,
        flag_reason TEXT,
        flag_detail TEXT,
        unflagged_at TEXT,
        pr TEXT,
        branch TEXT NOT NULL,
        worktree TEXT NOT NULL,
        feedback_watermark TEXT,
        mirror_pending TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX tickets_active_reference ON tickets (reference) WHERE state = 'active' AND reference IS NOT NULL;
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        ticket TEXT NOT NULL REFERENCES tickets (id),
        stage TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        stage_snapshot TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('headless', 'terminal', 'action')),
        started_by TEXT NOT NULL CHECK (started_by IN ('auto', 'human')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        ended_by TEXT CHECK (ended_by IN ('outcome', 'human')),
        ended_reason TEXT CHECK (ended_reason IN ('shutdown', 'wall_time', 'abandon', 'stop')),
        outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'exhausted', 'interrupted')),
        final_message TEXT,
        usage TEXT,
        cost_usd REAL,
        limits_honoured TEXT,
        stdout_path TEXT,
        transcript_path TEXT,
        pid INTEGER
      );
      CREATE INDEX sessions_ticket ON sessions (ticket, started_at);
      CREATE INDEX sessions_running ON sessions (ended_at) WHERE ended_at IS NULL;
    `);
  },
  (db) => {
    db.exec(`
      ALTER TABLE tickets ADD COLUMN holding_since TEXT;
      ALTER TABLE sessions ADD COLUMN opened_at TEXT;
    `);
  },
  (db) => {
    db.exec(`ALTER TABLE sessions ADD COLUMN runner_session_id TEXT;`);
  },
  (db) => {
    db.exec(`
      ALTER TABLE tickets ADD COLUMN budget_rounds INTEGER;
      ALTER TABLE tickets ADD COLUMN budget_attempts INTEGER;
      ALTER TABLE tickets ADD COLUMN budget_wall_time TEXT;
      ALTER TABLE tickets ADD COLUMN budget_spend REAL;
    `);
  },
  (db) => {
    db.exec(`ALTER TABLE tickets ADD COLUMN runnable_since TEXT;`);
  },
  // The Review loop (LASSO-36): a Round's Feedback snapshot, one row per item, with the evidence it was addressed.
  (db) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN round INTEGER;
      ALTER TABLE tickets ADD COLUMN feedback_due TEXT;
      ALTER TABLE tickets ADD COLUMN pr_status TEXT;
      CREATE TABLE feedback_item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT NOT NULL REFERENCES sessions (id),
        kind TEXT NOT NULL CHECK (kind IN ('check', 'thread', 'comment', 'verdict')),
        source_id TEXT NOT NULL,
        name TEXT,
        url TEXT,
        summary TEXT NOT NULL,
        path TEXT,
        line INTEGER,
        at TEXT NOT NULL,
        head TEXT,
        body TEXT,
        log TEXT,
        addressed TEXT
      );
      CREATE INDEX feedback_item_session ON feedback_item (session);
    `);
  },
  // End of life (LASSO-39): when the Ticket became done or Abandoned, for the retention sweep.
  (db) => {
    db.exec(`ALTER TABLE tickets ADD COLUMN ended_at TEXT;`);
  },
  // Pipeline Versions (LASSO-42, ADR 0009): a Ticket runs the frozen copy it was pinned to at Intake.
  (db) => {
    db.exec(`
      CREATE TABLE pipeline_versions (
        pipeline TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pipeline, version)
      );
      ALTER TABLE tickets ADD COLUMN pipeline_version INTEGER;
    `);
  },
  // Agent Profiles (LASSO-66, ADR 0011): the profile a Session ran under and its resolved settings, as JSON.
  (db) => {
    db.exec(`ALTER TABLE sessions ADD COLUMN profile TEXT;`);
  },
  // Per-Ticket profile overrides (LASSO-75): a human's choice of profile for one Stage of one Ticket, as JSON keyed by Stage name.
  (db) => {
    db.exec(`ALTER TABLE tickets ADD COLUMN profile_overrides TEXT;`);
  },
  // A Ticket's name (LASSO-108): what a human calls it, shown in place of its reference or short id.
  (db) => {
    db.exec(`ALTER TABLE tickets ADD COLUMN name TEXT;`);
  },
  // Check Action artifacts (LASSO-116, ADR 0014): the latest check per Stage name, as JSON.
  (db) => {
    db.exec(`ALTER TABLE tickets ADD COLUMN artifact_checks TEXT;`);
  },
  // Latest Message (LASSO-153): the newest thing a running Session's agent said, kept as it streams.
  (db) => {
    db.exec(`ALTER TABLE sessions ADD COLUMN latest_message TEXT;`);
  },
  // Skipped Stages (LASSO-159): when a human skipped each Stage, as JSON keyed by Stage name.
  (db) => {
    db.exec(`ALTER TABLE tickets ADD COLUMN skipped_stages TEXT;`);
  },
  // PR links (LASSO-172): a Ticket's PRs in a table, each with its own Review state; the Ticket's one PR becomes its first Owned link.
  (db) => {
    db.exec(`
      CREATE TABLE ticket_prs (
        ticket TEXT NOT NULL REFERENCES tickets (id),
        url TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owned', 'referenced')),
        source TEXT NOT NULL CHECK (source IN ('branch', 'human', 'agent')),
        added_at TEXT NOT NULL,
        unlinked_at TEXT,
        title TEXT,
        head TEXT,
        base TEXT,
        author TEXT,
        state TEXT,
        status TEXT,
        feedback_watermark TEXT,
        feedback_due TEXT,
        PRIMARY KEY (ticket, url)
      );
      CREATE INDEX ticket_prs_url ON ticket_prs (url);
      INSERT INTO ticket_prs (ticket, url, role, source, added_at, state, status, feedback_watermark, feedback_due)
        SELECT id, pr, 'owned', 'branch', created_at, json_extract(pr_status, '$.state'), pr_status, feedback_watermark, feedback_due FROM tickets WHERE pr IS NOT NULL;
      ALTER TABLE tickets DROP COLUMN pr;
      ALTER TABLE tickets DROP COLUMN pr_status;
      ALTER TABLE tickets DROP COLUMN feedback_watermark;
      ALTER TABLE tickets DROP COLUMN feedback_due;
    `);
  },
  // Rounds across Owned PRs (LASSO-165): each Feedback item names the PR it is on; earlier items were on their Ticket's one PR.
  (db) => {
    db.exec(`
      ALTER TABLE feedback_item ADD COLUMN pr TEXT;
      UPDATE feedback_item SET pr = (
        SELECT l.url FROM sessions s JOIN ticket_prs l ON l.ticket = s.ticket AND l.role = 'owned' WHERE s.id = feedback_item.session ORDER BY l.added_at LIMIT 1
      );
    `);
  },
  // Visits (LASSO-189): each arrival at a Stage, with the check and Skip kept per Visit; Sessions belong to one.
  (db) => {
    db.exec(`
      CREATE TABLE visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket TEXT NOT NULL REFERENCES tickets (id),
        stage TEXT NOT NULL,
        number INTEGER NOT NULL,
        version INTEGER,
        arrived_at TEXT NOT NULL,
        left_at TEXT,
        arrived_by TEXT NOT NULL CHECK (arrived_by IN ('walk', 'route', 'send', 'intake', 'upgrade')),
        from_visit INTEGER REFERENCES visits (id),
        route TEXT,
        chosen_by TEXT CHECK (chosen_by IN ('agent', 'action', 'check', 'human')),
        text TEXT,
        note TEXT,
        picked_route TEXT,
        picked_note TEXT,
        check_result TEXT,
        check_run TEXT,
        skipped_at TEXT,
        UNIQUE (ticket, stage, number)
      );
      CREATE UNIQUE INDEX visits_current ON visits (ticket) WHERE left_at IS NULL;
      ALTER TABLE sessions ADD COLUMN visit INTEGER;
    `);
    backfillVisits(db);
    db.exec(`
      CREATE INDEX sessions_visit ON sessions (visit);
      ALTER TABLE tickets DROP COLUMN artifact_checks;
      ALTER TABLE tickets DROP COLUMN skipped_stages;
    `);
  },
];

/**
 * One Visit per Stage each Ticket reached (a Session, a check or a Skip) plus
 * its current Stage, in Pipeline order where its Version says, else in the
 * order they began. The first was Intake's, the rest walked; each began at its
 * first Session (else when the one before was left, or the Ticket was made)
 * and was left at its last Session's end, all but the current Stage's (LASSO-189).
 */
function backfillVisits(db: DatabaseSync): void {
  type Old = { id: string; stage: string; pipeline: string; pipeline_version: number | null; created_at: string; artifact_checks: string | null; skipped_stages: string | null };
  const tickets = db.prepare(`SELECT id, stage, pipeline, pipeline_version, created_at, artifact_checks, skipped_stages FROM tickets ORDER BY created_at`).all() as unknown as Old[];
  const spans = db.prepare(`SELECT stage, MIN(started_at) AS first, MAX(COALESCE(ended_at, started_at)) AS last FROM sessions WHERE ticket = ? GROUP BY stage`);
  const definition = db.prepare(`SELECT definition FROM pipeline_versions WHERE pipeline = ? AND version = ?`);
  const insert = db.prepare(
    `INSERT INTO visits (ticket, stage, number, version, arrived_at, left_at, arrived_by, from_visit, check_result, skipped_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const link = db.prepare(`UPDATE sessions SET visit = ? WHERE ticket = ? AND stage = ?`);
  for (const ticket of tickets) {
    const checks = ticket.artifact_checks ? (JSON.parse(ticket.artifact_checks) as Record<string, { at: string }>) : {};
    const skips = ticket.skipped_stages ? (JSON.parse(ticket.skipped_stages) as Record<string, string>) : {};
    const sessions = new Map((spans.all(ticket.id) as Array<{ stage: string; first: string; last: string }>).map((s) => [s.stage, s]));
    const reached = [...new Set([...sessions.keys(), ...Object.keys(checks), ...Object.keys(skips), ticket.stage])];
    const order = stageOrder(ticket.pipeline_version === null ? undefined : (definition.get(ticket.pipeline, ticket.pipeline_version) as { definition: string } | undefined)?.definition);
    const arrivedAt = (stage: string) => sessions.get(stage)?.first ?? ticket.created_at;
    reached.sort((a, b) => rank(order, a) - rank(order, b) || arrivedAt(a).localeCompare(arrivedAt(b)));
    let from: { id: number; left: string | null } | null = null;
    reached.forEach((stage, i) => {
      // A Stage with no Session was arrived at when the one before it was left.
      const arrived = sessions.get(stage)?.first ?? from?.left ?? ticket.created_at;
      const left = stage === ticket.stage ? null : (sessions.get(stage)?.last ?? skips[stage] ?? checks[stage]?.at ?? arrived);
      const check = checks[stage] ? JSON.stringify(checks[stage]) : null;
      const visit = Number(insert.run(ticket.id, stage, ticket.pipeline_version, arrived, left, i === 0 ? "intake" : "walk", from?.id ?? null, check, skips[stage] ?? null).lastInsertRowid);
      link.run(visit, ticket.id, stage);
      from = { id: visit, left };
    });
  }
}

/** The Stage names of a pinned Version's definition, in order; empty when there is none to read. */
function stageOrder(definition: string | undefined): string[] {
  try {
    return definition ? ((JSON.parse(definition) as { stages?: Array<{ name: string }> }).stages ?? []).map((s) => s.name) : [];
  } catch {
    return [];
  }
}

/** Where a Stage falls in Pipeline order; one the Pipeline no longer has sorts after every one it has. */
function rank(order: string[], stage: string): number {
  const index = order.indexOf(stage);
  return index < 0 ? order.length : index;
}

/** The schema version this Lasso migrates a store up to. */
export const SCHEMA_VERSION = MIGRATIONS.length;
