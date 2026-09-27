import { DatabaseSync } from "node:sqlite";

/** The one SQLite store. Only the running lasso process opens it for writing (ADR 0008). */
export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    let version = row ? Number(row.value) : 0;
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

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [];
