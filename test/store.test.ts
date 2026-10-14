import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeHome, freePort, runCli } from "./harness.ts";
import { Store, StoreTooNew, SCHEMA_VERSION, KEEP_BACKUPS } from "../src/store/store.ts";

// The store across upgrades and downgrades (LASSO-95): refuse one a newer Lasso migrated, back one up before migrating it.
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "lasso-store-"));
  dirs.push(dir);
  return dir;
}

const schemaOf = (file: string): number => {
  const db = new DatabaseSync(file);
  try {
    return Number((db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value);
  } finally {
    db.close();
  }
};

const hashOf = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A fully migrated store, then stamped with another schema version. */
function storeAt(file: string, schema: number): void {
  new Store(file).close();
  const db = new DatabaseSync(file);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(schema));
  db.close();
}

/** A store one migration behind: the last migration (a Ticket's name) undone. */
function storeOneBehind(file: string): DatabaseSync {
  new Store(file).close();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("ALTER TABLE tickets DROP COLUMN name");
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 1));
  return db;
}

const backupsIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("a store a newer Lasso migrated", () => {
  it("is refused with the schema it was left at, and left unmodified", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "lasso.db");
    storeAt(file, SCHEMA_VERSION + 1);
    const before = hashOf(file);
    let refused: unknown;
    try {
      new Store(file, { backupsDir: path.join(dir, "backups") }).close();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(StoreTooNew);
    expect((refused as Error).message).toBe(`this Lasso home was last used by a newer Lasso (schema ${SCHEMA_VERSION + 1}); install that version or newer`);
    expect(hashOf(file)).toBe(before);
    expect(schemaOf(file)).toBe(SCHEMA_VERSION + 1);
    expect(backupsIn(path.join(dir, "backups"))).toEqual([]);
  });

  it("stops lasso at startup with that message", async () => {
    const { home, pathDir } = await makeHome();
    dirs.push(path.dirname(home));
    storeAt(path.join(home, "lasso.db"), SCHEMA_VERSION + 3);
    const result = await runCli([], { home, pathDir, port: await freePort() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`this Lasso home was last used by a newer Lasso (schema ${SCHEMA_VERSION + 3}); install that version or newer`);
    expect(schemaOf(path.join(home, "lasso.db"))).toBe(SCHEMA_VERSION + 3);
  });
});

describe("the store backup before migrating", () => {
  it("writes exactly one copy, with uncheckpointed WAL writes, named with the old schema and date", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "lasso.db");
    const backups = path.join(dir, "backups");
    // An open connection keeps this write in the WAL, not yet in lasso.db.
    const old = storeOneBehind(file);
    old.exec(`INSERT INTO pipeline_versions (pipeline, version, definition, created_at) VALUES ('work', 1, '{}', '2026-10-13')`);
    try {
      new Store(file, { backupsDir: backups, now: () => new Date("2026-10-13T09:30:00.123Z") }).close();
    } finally {
      old.close();
    }
    expect(backupsIn(backups)).toEqual([`lasso-2026-10-13T09-30-00Z-schema${SCHEMA_VERSION - 1}.db`]);
    const copy = path.join(backups, backupsIn(backups)[0]!);
    expect(schemaOf(copy)).toBe(SCHEMA_VERSION - 1);
    const db = new DatabaseSync(copy);
    try {
      expect(db.prepare(`SELECT pipeline FROM pipeline_versions`).all()).toEqual([{ pipeline: "work" }]);
      const columns = (db.prepare(`PRAGMA table_info(tickets)`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).not.toContain("name");
    } finally {
      db.close();
    }
    expect(schemaOf(file)).toBe(SCHEMA_VERSION);
  });

  it("is not taken when nothing migrates, or for a brand-new store", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "lasso.db");
    const backups = path.join(dir, "backups");
    new Store(file, { backupsDir: backups }).close();
    new Store(file, { backupsDir: backups }).close();
    expect(backupsIn(backups)).toEqual([]);
  });

  it("keeps only the newest five", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "lasso.db");
    const backups = path.join(dir, "backups");
    await mkdir(backups);
    // Something else in backups/ is not Lasso's to prune.
    await writeFile(path.join(backups, "notes.txt"), "mine");
    for (let day = 1; day <= KEEP_BACKUPS + 2; day++) {
      storeOneBehind(file).close();
      new Store(file, { backupsDir: backups, now: () => new Date(`2026-10-0${day}T12:00:00Z`) }).close();
    }
    const old = SCHEMA_VERSION - 1;
    expect(backupsIn(backups)).toEqual([...[3, 4, 5, 6, 7].map((day) => `lasso-2026-10-0${day}T12-00-00Z-schema${old}.db`), "notes.txt"]);
  });
});
