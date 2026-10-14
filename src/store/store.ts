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
];

/** The schema version this Lasso migrates a store up to. */
export const SCHEMA_VERSION = MIGRATIONS.length;
