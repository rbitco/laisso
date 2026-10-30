import { Upgrades } from "../store/upgrades.ts";
import { VersionUpgrade } from "../session/upgrade.ts";
import { serve as listen } from "@hono/node-server";
import { resolveHome, ensureHome } from "./home.ts";
import { migrateConfigProfiles, migrateHome, migrateVersions } from "./migrate.ts";
import { applyLive, loadConfig, prListsBlock, reviewFor } from "./config.ts";
import { ignoring } from "../review/feedback.ts";
import type { TicketRow } from "../store/tickets.ts";
import { acquireLock, AlreadyRunning } from "./lock.ts";
import { createLogger } from "./log.ts";
import { Store, StoreTooNew } from "../store/store.ts";
import { Tickets } from "../store/tickets.ts";
import { Visits } from "../store/visits.ts";
import { Sessions } from "../store/sessions.ts";
import { Feedback } from "../store/feedback.ts";
import { PrLinks } from "../store/links.ts";
import { PullRequests } from "../review/github.ts";
import { Review } from "../review/review.ts";
import { Runs } from "../session/runs.ts";
import { Progress } from "../session/progress.ts";
import { Terminal } from "../session/terminal.ts";
import { createNotifier } from "../notify/notifier.ts";
import { Mirror } from "../tracker/mirror.ts";
import { Actions } from "../session/actions.ts";
import { Exits } from "../session/exits.ts";
import { Overrides } from "../session/overrides.ts";
import { Budgets } from "../budget/budgets.ts";
import { Queue } from "../session/queue.ts";
import { Teardown } from "../session/teardown.ts";
import { PipelineVersions } from "../store/versions.ts";
import { Tick } from "./tick.ts";
import { Changes } from "./changes.ts";
import { createApp } from "../api/app.ts";
import { Dashboard, DashboardMissing } from "../dashboard/page.ts";
import { findPackageRoot } from "../package-root.ts";
import { startupToolCheck } from "../tools/startup.ts";
import { chooseTerminal } from "../session/openers.ts";
import { VersionCheck, npmLatest } from "./version-check.ts";
import { ActionChecks } from "../artifact/action-check.ts";
import { Watch } from "../wait/watch.ts";
import { PrLists } from "../prs/lists.ts";
import { githubRepos } from "../prs/origins.ts";
import type { GitHubRepo } from "../prs/query.ts";
import { ghSearch } from "../prs/search.ts";
import { parseDuration } from "../duration.ts";

export interface ServeOptions {
  portFlag?: number;
}

/** The one foreground lasso process (ADR 0008). Resolves with the exit code once it has shut down. */
export async function serve(opts: ServeOptions): Promise<number> {
  // Lasso's own version and dashboard, found the same way from source and from an installed bundle.
  const pkg = findPackageRoot();
  let dashboard: Dashboard;
  try {
    dashboard = new Dashboard(pkg.dashboardDir, pkg.checkout);
  } catch (error) {
    if (error instanceof DashboardMissing) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const home = resolveHome();
  const defaults = ensureHome(home);
  // Before config or any Pipeline is read: tracker.transition moves into config (ADR 0010), runners into profiles (ADR 0011).
  const migrated = migrateHome(home);
  const config = loadConfig(home, { port: opts.portFlag });
  const log = createLogger(home.logFile);

  let releaseLock: () => void;
  try {
    releaseLock = acquireLock(home, config.port);
  } catch (error) {
    if (error instanceof AlreadyRunning) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  let store: Store;
  try {
    // Copies the store to backups/ before migrating it; refuses one a newer Lasso migrated.
    store = new Store(home.dbFile, { backupsDir: home.backupsDir });
  } catch (error) {
    if (error instanceof StoreTooNew) {
      releaseLock();
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  // Every write that the dashboard shows announces itself here; /api/events relays it (no polling).
  const changes = new Changes();
  const ticketChanged = (ticket: string) => changes.emit({ kind: "ticket", ticket });
  const tickets = new Tickets(store.db, ticketChanged);
  const versions = new PipelineVersions(store.db);
  const migratedVersions = migrateVersions(store.db, home.pipelinesDir);
  // A pinned Version may name a Runner no Pipeline file does any more; config.yaml gets its profile too.
  if (migrateConfigProfiles(home, migratedVersions.profiles)) {
    migrated.config = true;
    applyLive(config, loadConfig(home));
  }
  if (migrated.config || migrated.pipelines.length || migratedVersions.versions) log.info("migrated", { config: migrated.config, pipelines: migrated.pipelines.join(",") || null, versions: migratedVersions.versions });
  versions.pinUnpinned(tickets, home.pipelinesDir);
  const sessions = new Sessions(store.db, ticketChanged);
  const visits = new Visits(store.db, ticketChanged);
  const feedback = new Feedback(store.db, ticketChanged);
  // Each repo's GitHub owner/name, read from its checkout's origin. The read is async and PrLinks asks synchronously,
  // so PrLinks sees what the last read found: every repo at startup, and the Ticket's repo again before each link.
  const origins = new Map<string, GitHubRepo>();
  const githubOf = async (repo: string): Promise<GitHubRepo | null> => {
    const found = config.repos[repo] ? ((await githubRepos({ [repo]: config.repos[repo] }))[repo] ?? null) : null;
    if (found) origins.set(repo, found);
    else origins.delete(repo);
    return found;
  };
  const links = new PrLinks(store.db, ticketChanged, (repo) => origins.get(repo) ?? null);
  const notifier = createNotifier({ config: config.notifications, log, baseUrl: `http://localhost:${config.port}` });
  // Per-Ticket work that outlasted its tick and changed something kicks a tick, so what it made due starts now (LASSO-203).
  const late = () => tick.kick("late-work");
  const mirror = new Mirror({
    config,
    tickets,
    log,
    late,
    pipelineFor: (ticket) => {
      try {
        return versions.forTicket(ticket, home.pipelinesDir);
      } catch {
        return null;
      }
    },
  });
  const prs = new PullRequests(log);
  const teardown = new Teardown({ config, home, tickets, links, log, prs, late });
  const checks = new ActionChecks({ config, home, links, visits, log });
  const budgets = new Budgets({ config, sessions, links, visits });
  const upgrades = new Upgrades(store.db);
  const progress: Progress = new Progress({ home, tickets, versions, sessions, visits, links, budgets, upgrades, log, notifier, mirror, prProbe: (ticket) => () => review.probe(ticket), actionProbe: (ticket, stage) => checks.probe(ticket, stage), checkRun: (id) => checks.liveRun(id), teardown });
  // review: is read from the live config per Ticket, so a Config page save applies on the next poll; the gh login is read once.
  const ignored = async (ticket: TicketRow) => {
    const rules = reviewFor(config, ticket.repo);
    return ignoring(rules.ignore_self ? [...rules.ignore_authors, await prs.viewer()] : rules.ignore_authors);
  };
  const review: Review = new Review({ tickets, sessions, visits, feedback, links, progress, prs, checks, log, ignored, late });
  const watch = new Watch({ tickets, visits, progress, checks, log, late });
  const terminal = new Terminal({ config, home, sessions, visits, links, log, routeCounts: (ticket, stage) => budgets.routes(ticket, stage), flag: (ticket, reason, detail) => progress.flag(ticket, reason, detail) });
  const queue = new Queue({ home, tickets, sessions, progress, log, cap: config.concurrency });
  const runs = new Runs({ config, home, tickets, links, sessions, visits, log, progress, budgets, queue, review, checks, stdoutWritten: (ticket, session) => changes.emit({ kind: "stdout", ticket, session }), ended: () => tick.kick("session-end") });
  const actions = new Actions({
    config,
    home,
    tickets,
    sessions,
    visits,
    links,
    log,
    progress,
    budgets,
    stdoutWritten: (ticket, session) => changes.emit({ kind: "stdout", ticket, session }),
    ended: () => tick.kick("session-end"),
  });
  // The PR Lists read config live, so a pr_lists, pr_list_refresh, pr_page_layout or repos edit applies at once.
  // tick is a restart key, so config.tick is the running Tick's.
  const prLists = new PrLists({
    lists: () => Object.entries(config.pr_lists).map(([name, list]) => ({ name, ...list })),
    repos: () => githubRepos(config.repos),
    tickets: () =>
      tickets.list({ all: true }).map((t) => {
        const live = links.links(t.id);
        return { ...t, owned: live.flatMap((l) => (l.role === "owned" ? [l.url] : [])), referenced: live.flatMap((l) => (l.role === "referenced" ? [l.url] : [])) };
      }),
    search: ghSearch(),
    tickMs: () => config.tick * 1000,
    refreshMs: () => parseDuration(config.pr_list_refresh),
    changed: () => changes.emit({ kind: "prlists" }),
    layout: () => config.pr_page_layout,
    example: `pr_lists:\n${prListsBlock("").trimEnd().replace(/^/gm, "  ")}\n`,
  });
  // One tick: the PR Lists, which only start their fetches (a Tick never waits on a PR search), then owed mirror
  // pushes, then action Stages, then the PR poll (a Round it makes due starts below), then wait Stages' checks, then
  // headless starts, then the retention sweep. The mirror, PR poll, wait checks and sweep each handle every Ticket on its
  // own: one whose gh, git or Action outlasts the tick's patience finishes in the background and is skipped until it
  // ends, so it never holds up the other Tickets or the next tick (LASSO-203).
  const tick = new Tick(
    config.tick,
    log,
    async () => {
      // A PR List problem must never cost the Tick the rest of its work.
      await prLists.onTick().catch((error: unknown) => log.error("prlists.tick", { error: error instanceof Error ? error.message : String(error) }));
      return [...(await mirror.retryPending()), ...(await actions.runDue()), ...(await review.poll()), ...(await watch.poll()), ...(await runs.startRunnable()), ...(await teardown.sweep())];
    },
    () => changes.emit({ kind: "tick" }),
  );
  const overrides = new Overrides({ config, home, tickets, progress, log });
  const exits = new Exits({ tickets, sessions, log, progress, runs, terminal, budgets, tick, teardown, overrides });
  const upgrade = new VersionUpgrade({ home, tickets, versions, sessions, visits, progress, log, mirror });
  const missingTools = startupToolCheck(config, home, tickets, log);
  // The package on disk is read again at each check: after `npm update -g` it is newer than this process.
  const onDisk = () => {
    try {
      return findPackageRoot(pkg.root).version;
    } catch {
      return null;
    }
  };
  const versionCheck = new VersionCheck({ running: pkg.version, onDisk, latest: npmLatest, log, changed: () => changes.emit({ kind: "version" }) });
  const app = createApp({ config, home, tick, tickets, versions, sessions, visits, upgrades, upgrade, feedback, links, prs, githubOf, runs, progress, terminal, exits, overrides, budgets, queue, changes, prLists, dashboard, version: pkg.version, missingTools, versionNotice: () => versionCheck.current() });

  if (defaults.wroteConfig) log.info("config.written", { file: home.configFile });
  for (const name of defaults.wrotePipelines) log.info("pipeline.written", { name });

  const server = listen({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    releaseLock();
    store.close();
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE" ? `port ${config.port} is in use; pass --port or set port: in config.yaml` : String(error));
    return 1;
  }
  const url = `http://localhost:${config.port}`;
  log.info("started", { home: home.root, port: config.port, pid: process.pid, version: pkg.version });
  const opensIn = chooseTerminal(config.terminal, process.env);
  log.info("terminal", { terminal: opensIn.kind, why: opensIn.why });
  console.log(`lasso listening at ${url}`);
  versionCheck.start();

  // Ctrl-C is honoured from here on, before reconciliation and the startup tick: a shutdown that
  // lands inside them waits for them, so a Session the startup tick spawns is killed and recorded.
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  let shuttingDown = false;
  const startup = (async () => {
    // Origins are read alongside, not awaited: a slow git must not hold back the startup tick.
    for (const repo of Object.keys(config.repos)) void githubOf(repo).catch(() => undefined);
    await runs.reconcile();
    if (shuttingDown) return;
    actions.reconcile();
    mirror.markAllPending();
    await tick.run("startup");
    if (!shuttingDown) tick.start();
  })();
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", { signal });
    tick.stop();
    versionCheck.stop();
    // Open event streams would keep server.close waiting; ending them lets it finish.
    changes.close();
    const finished = new Promise<void>((done) => server.close(() => done()));
    // The ended streams leave keep-alive sockets behind once their last bytes are out; drop them then.
    setTimeout(() => (server as { closeIdleConnections?: () => void }).closeIdleConnections?.(), 50).unref();
    void startup.then(() => tick.settle()).then(() => Promise.all([review.settle(), watch.settle(), teardown.settle()])).then(() => Promise.all([runs.shutdown(), actions.shutdown(), checks.shutdown()])).then(() => mirror.settle()).then(() => finished).then(() => {
      store.close();
      releaseLock();
      resolveExit(0);
    });
    setTimeout(() => {
      releaseLock();
      resolveExit(0);
    }, 8000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await startup;
  return exited;
}
