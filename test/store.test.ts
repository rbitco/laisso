import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeHome, freePort, runCli } from "./harness.ts";
import { Store, StoreTooNew, SCHEMA_VERSION, KEEP_BACKUPS } from "../src/store/store.ts";
import { Tickets, type TicketRow } from "../src/store/tickets.ts";
import { PrLinks } from "../src/store/links.ts";

const PR = "https://github.com/owner/app/pull/7";

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

/** A store one migration behind: the last migration (the upgrades table) undone. */
function storeOneBehind(file: string): DatabaseSync {
  new Store(file).close();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`DROP TABLE upgrades;`);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 1));
  return db;
}

/** A store from before the Route Budget: the last two migrations undone. */
function storeBeforeRouteBudget(file: string): DatabaseSync {
  const db = storeOneBehind(file);
  db.exec(`ALTER TABLE tickets DROP COLUMN budget_routes;
           ALTER TABLE visits DROP COLUMN picked_by;`);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 2));
  return db;
}

/** A store from before a Visit's replaces: the last three migrations undone. */
function storeBeforeReplaces(file: string): DatabaseSync {
  const db = storeBeforeRouteBudget(file);
  db.exec(`ALTER TABLE visits DROP COLUMN replaces;`);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 3));
  return db;
}

/** A store from before Visits: the last four migrations undone, so checks and Skips are kept on the Ticket again. */
function storeBeforeVisits(file: string): DatabaseSync {
  const db = storeBeforeReplaces(file);
  db.exec(`DROP INDEX sessions_visit;
           ALTER TABLE sessions DROP COLUMN visit;
           DROP TABLE visits;
           ALTER TABLE tickets ADD COLUMN artifact_checks TEXT;
           ALTER TABLE tickets ADD COLUMN skipped_stages TEXT;`);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 4));
  return db;
}

/** A store from before each Feedback item named its PR: the last five migrations undone. */
function storeBeforeItemPrs(file: string): DatabaseSync {
  const db = storeBeforeVisits(file);
  db.exec(`ALTER TABLE feedback_item DROP COLUMN pr;`);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 5));
  return db;
}

/** A store from before PR links: the last six migrations undone, so each Ticket holds its one PR again. */
function storeBeforeLinks(file: string): DatabaseSync {
  const db = storeBeforeItemPrs(file);
  db.exec(`DROP TABLE ticket_prs;
           ALTER TABLE tickets ADD COLUMN pr TEXT;
           ALTER TABLE tickets ADD COLUMN feedback_watermark TEXT;
           ALTER TABLE tickets ADD COLUMN feedback_due TEXT;
           ALTER TABLE tickets ADD COLUMN pr_status TEXT;`);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 6));
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
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'upgrades'`).all()).toEqual([]);
    } finally {
      db.close();
    }
    expect(schemaOf(file)).toBe(SCHEMA_VERSION);
  });

  it("moves each Ticket's PR into an Owned link from its branch, with its status, watermark and pending Round, and drops the old columns", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "lasso.db");
    const old = storeBeforeLinks(file);
    const status = JSON.stringify({ number: 7, url: PR, state: "OPEN", checks: "green", fresh: 1, outstanding: 1, at: "2026-10-13T10:00:00Z" });
    const due = JSON.stringify({ pr: { number: 7, url: PR }, headSha: "aaaaaaa1", items: [], watermark: "2026-10-13T10:00:00Z" });
    const insert = old.prepare(`INSERT INTO tickets (id, repo, origin, title, pipeline, stage, state, branch, worktree, pr, pr_status, feedback_watermark, feedback_due, created_at, updated_at)
                                VALUES (?, 'r', 'prompt', 't', 'work', 'review', 'active', 'b', 'w', ?, ?, ?, ?, '2026-10-13', '2026-10-13')`);
    insert.run("01T", PR, status, "2026-10-13T09:00:00Z", due);
    insert.run("02T", null, null, null, null);
    old.close();
    const store = new Store(file, { backupsDir: path.join(dir, "backups") });
    try {
      const links = new PrLinks(store.db);
      expect(links.links("01T")).toEqual([
        { ticket: "01T", url: PR, role: "owned", source: "branch", added_at: "2026-10-13", unlinked_at: null, title: null, head: null, base: null, author: null, state: "OPEN", status, feedback_watermark: "2026-10-13T09:00:00Z", feedback_due: due },
      ]);
      expect(links.links("02T")).toEqual([]);
      const columns = (store.db.prepare(`PRAGMA table_info(tickets)`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns.filter((c) => ["pr", "pr_status", "feedback_watermark", "feedback_due"].includes(c))).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("names the PR each Feedback item was on: its Ticket's one PR", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "lasso.db");
    const old = storeBeforeLinks(file);
    old.exec(`INSERT INTO tickets (id, repo, origin, title, pipeline, stage, state, branch, worktree, pr, created_at, updated_at)
              VALUES ('01T', 'r', 'prompt', 't', 'work', 'review', 'active', 'b', 'w', '${PR}', '2026-10-13', '2026-10-13');
              INSERT INTO sessions (id, ticket, stage, ordinal, stage_snapshot, mode, started_by, started_at) VALUES ('s1', '01T', 'review', 1, '{}', 'headless', 'auto', '2026-10-13');
              INSERT INTO feedback_item (session, kind, source_id, summary, at) VALUES ('s1', 'comment', '201', 'comment by bob', '2026-10-13');`);
    old.close();
    const store = new Store(file);
    try {
      expect(store.db.prepare(`SELECT pr FROM feedback_item`).all()).toEqual([{ pr: PR }]);
    } finally {
      store.close();
    }
  });

  it("backfills a Visit per Stage each Ticket reached, links its Sessions, and moves checks and Skips onto them (LASSO-189)", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "lasso.db");
    const old = storeBeforeVisits(file);
    const definition = JSON.stringify({ name: "work", stages: ["grill", "implement", "review", "ship"].map((name) => ({ name })) });
    old.prepare(`INSERT INTO pipeline_versions (pipeline, version, definition, created_at) VALUES ('work', 1, ?, 'T0')`).run(definition);
    const ticket = old.prepare(`INSERT INTO tickets (id, repo, origin, title, pipeline, pipeline_version, stage, state, branch, worktree, artifact_checks, skipped_stages, created_at, updated_at)
                                VALUES (?, 'r', 'prompt', 't', 'work', ?, ?, ?, 'b', 'w', ?, ?, 'T0', 'T0')`);
    const session = old.prepare(`INSERT INTO sessions (id, ticket, stage, ordinal, round, stage_snapshot, mode, started_by, started_at, ended_at) VALUES (?, ?, ?, ?, ?, '{}', 'headless', 'auto', ?, ?)`);
    const check = { action: "ci-green", result: "not_met", at: "T8", code: 1, line: "2 checks pending" };
    // Active at review: grill skipped, implement run twice, review two Rounds in with a check kept.
    ticket.run("01A", 1, "review", "active", JSON.stringify({ review: check }), JSON.stringify({ grill: "T1" }));
    session.run("a1", "01A", "implement", 1, null, "T2", "T3");
    session.run("a2", "01A", "implement", 2, null, "T4", "T5");
    session.run("a3", "01A", "review", 1, 1, "T6", "T7");
    session.run("a4", "01A", "review", 2, 2, "T9", null);
    // Done by skipping ship, its last Stage, which it reached with no Session.
    ticket.run("02D", 1, "ship", "done", null, JSON.stringify({ ship: "T5" }));
    session.run("d1", "02D", "implement", 1, null, "T2", "T3");
    // Abandoned at its first Stage, never pinned to a Version.
    ticket.run("03X", null, "grill", "abandoned", null, null);
    old.close();

    const store = new Store(file);
    try {
      const visits = store.db.prepare(`SELECT v.ticket, v.stage, v.number, v.version, v.arrived_at, v.left_at, v.arrived_by, f.stage AS from_stage, v.check_result, v.skipped_at
                                       FROM visits v LEFT JOIN visits f ON f.id = v.from_visit ORDER BY v.id`).all();
      const visit = (ticket: string, stage: string, version: number | null, arrived_at: string, left_at: string | null, arrived_by: string, from_stage: string | null, more: { check_result?: string; skipped_at?: string } = {}) =>
        ({ ticket, stage, number: 1, version, arrived_at, left_at, arrived_by, from_stage, check_result: null, skipped_at: null, ...more });
      expect(visits).toEqual([
        visit("01A", "grill", 1, "T0", "T1", "intake", null, { skipped_at: "T1" }),
        visit("01A", "implement", 1, "T2", "T5", "walk", "grill"),
        // The current Stage's Visit is not left; its check came with it.
        visit("01A", "review", 1, "T6", null, "walk", "implement", { check_result: JSON.stringify(check) }),
        visit("02D", "implement", 1, "T2", "T3", "intake", null),
        // No Session at ship: it was arrived at when implement was left.
        visit("02D", "ship", 1, "T3", null, "walk", "implement", { skipped_at: "T5" }),
        visit("03X", "grill", null, "T0", null, "intake", null),
      ]);
      const linked = store.db.prepare(`SELECT s.id, v.stage FROM sessions s JOIN visits v ON v.id = s.visit ORDER BY s.id`).all();
      expect(linked).toEqual([
        { id: "a1", stage: "implement" },
        { id: "a2", stage: "implement" },
        { id: "a3", stage: "review" },
        { id: "a4", stage: "review" },
        { id: "d1", stage: "implement" },
      ]);
      const columns = (store.db.prepare(`PRAGMA table_info(tickets)`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns.filter((c) => ["artifact_checks", "skipped_stages"].includes(c))).toEqual([]);
    } finally {
      store.close();
    }
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

describe("a Ticket's PR links", () => {
  async function linked(githubOf?: (repo: string) => { owner: string; name: string } | null) {
    const dir = await tempDir();
    const store = new Store(path.join(dir, "lasso.db"));
    const tickets = new Tickets(store.db);
    const links = new PrLinks(store.db, undefined, githubOf);
    const ticket = (id: string, reference: string): TicketRow =>
      tickets.insert({ id, repo: "app", reference, origin: "tracker", prompt: null, title: id, body: null, pipeline: "default", pipeline_version: 1, stage: "review", branch: `b-${id}`, worktree: `/wt/${id}` });
    return { store, tickets, links, a: ticket("01A", "APP-A"), b: ticket("01B", "APP-B") };
  }

  it("auto-links the branch PR as Owned, once, and never again after an unlink", async () => {
    const { store, links, a } = await linked();
    try {
      expect(links.autoLink(a, PR, "2026-10-13T10:00:00Z")).toMatchObject({ role: "owned", source: "branch", added_at: "2026-10-13T10:00:00Z" });
      expect(links.autoLink(a, PR, "2026-10-13T11:00:00Z")!.added_at).toBe("2026-10-13T10:00:00Z");
      expect(links.unlink(a.id, PR)).toBe(true);
      expect(links.links(a.id)).toEqual([]);
      expect(links.autoLink(a, PR)).toBeNull();
      expect(links.unlinked(a.id, PR)).toBe(true);
      // A person linking it again lifts the tombstone.
      const again = links.link(a, PR, "referenced", "human", "2026-10-14T10:00:00Z");
      expect(again).toEqual({ link: expect.objectContaining({ role: "referenced", source: "human", added_at: "2026-10-14T10:00:00Z", unlinked_at: null }) });
      expect(links.unlinked(a.id, PR)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("switches a live link's role, and lets only one active Ticket own a PR", async () => {
    const { store, tickets, links, a, b } = await linked();
    try {
      links.link(a, PR, "owned", "human");
      expect(links.link(b, PR, "owned", "agent")).toEqual({ refused: "APP-A owns this PR; link it with --referenced" });
      expect(links.autoLink(b, PR)).toBeNull();
      expect(links.link(b, PR, "referenced", "agent")).toEqual({ link: expect.objectContaining({ role: "referenced" }) });
      expect(links.ownerOf(PR)!.id).toBe(a.id);
      expect(links.referencersOf(PR).map((t) => t.id)).toEqual([b.id]);
      links.link(a, PR, "referenced", "human");
      expect(links.ownerOf(PR)).toBeNull();
      expect(links.link(b, PR, "owned", "human")).toEqual({ link: expect.objectContaining({ role: "owned" }) });
      expect(links.links(b.id)).toHaveLength(1);
      expect(links.ownedOpen(b.id).map((l) => l.url)).toEqual([PR]);
      links.update(b.id, PR, { state: "MERGED" });
      expect(links.ownedOpen(b.id)).toEqual([]);
      // An Abandoned Ticket neither takes links nor counts as referencing one; a done one still takes them.
      const abandoned = tickets.update(a.id, { state: "abandoned" });
      expect(links.link(abandoned, "https://github.com/owner/app/pull/8", "referenced", "human")).toEqual({ refused: "APP-A is Abandoned" });
      expect(links.referencersOf(PR)).toEqual([]);
      const done = tickets.update(b.id, { state: "done" });
      expect("link" in links.link(done, "https://github.com/owner/app/pull/9", "referenced", "human")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("holds an Owned PR to the Ticket's repo when it knows the repo, and a Referenced one to none", async () => {
    const { store, links, a } = await linked(() => ({ owner: "owner", name: "app" }));
    try {
      const other = "https://github.com/someone/lib/pull/3";
      expect(links.link(a, other, "owned", "human")).toEqual({ refused: "an Owned PR must be in owner/app, the repo of APP-A; link it with --referenced" });
      expect("link" in links.link(a, other, "referenced", "human")).toBe(true);
      expect("link" in links.link(a, PR, "owned", "human")).toBe(true);
    } finally {
      store.close();
    }
  });
});
