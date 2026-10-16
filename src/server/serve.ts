import { serve as listen } from "@hono/node-server";
import { resolveHome, ensureHome } from "./home.ts";
import { migrateConfigProfiles, migrateHome, migrateVersions } from "./migrate.ts";
import { applyLive, loadConfig } from "./config.ts";
import { acquireLock, AlreadyRunning } from "./lock.ts";
import { createLogger } from "./log.ts";
import { Store, StoreTooNew } from "../store/store.ts";
import { Tickets } from "../store/tickets.ts";
import { Sessions } from "../store/sessions.ts";
import { Feedback } from "../store/feedback.ts";
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
import { PrLists } from "../prs/lists.ts";
import { githubRepos } from "../prs/origins.ts";
import { ghSearch } from "../prs/search.ts";

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
  const feedback = new Feedback(store.db, ticketChanged);
  const notifier = createNotifier({ config: config.notifications, log, baseUrl: `http://localhost:${config.port}` });
  const mirror = new Mirror({
    config,
    tickets,
    log,
    pipelineFor: (ticket) => {
      try {
        return versions.forTicket(ticket, home.pipelinesDir);
      } catch {
        return null;
      }
    },
  });
  const prs = new PullRequests(log);
  const teardown = new Teardown({ config, home, tickets, log, prs });
  const checks = new ActionChecks({ config, home, tickets, log });
  const progress: Progress = new Progress({ home, tickets, versions, sessions, log, notifier, mirror, prProbe: (ticket) => () => review.probe(ticket), actionProbe: (ticket, stage) => checks.probe(ticket, stage), teardown });
  const review: Review = new Review({ tickets, sessions, feedback, progress, prs, checks, log });
  const terminal = new Terminal({ config, home, sessions, log, flag: (ticket, reason, detail) => progress.flag(ticket, reason, detail) });
  const budgets = new Budgets({ config, sessions });
  const queue = new Queue({ home, tickets, sessions, progress, log, cap: config.concurrency });
  const runs = new Runs({ config, home, tickets, sessions, log, progress, budgets, queue, review, checks, stdoutWritten: (ticket, session) => changes.emit({ kind: "stdout", ticket, session }), ended: () => tick.kick("session-end") });
  const actions = new Actions({
    config,
    home,
    tickets,
    sessions,
    log,
    progress,
    stdoutWritten: (ticket, session) => changes.emit({ kind: "stdout", ticket, session }),
    ended: () => tick.kick("session-end"),
  });
  // One tick: owed mirror pushes, then action Stages, then the PR poll (a Round it makes due starts below), then headless starts, then the retention sweep.
  const tick = new Tick(config.tick, log, async () => [...(await mirror.retryPending()), ...(await actions.runDue()), ...(await review.poll()), ...(await runs.startRunnable()), ...(await teardown.sweep())], () => changes.emit({ kind: "tick" }));
  const overrides = new Overrides({ config, home, tickets, progress, log });
  const exits = new Exits({ tickets, sessions, log, progress, runs, terminal, budgets, tick, teardown, overrides });
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
  // The Pull Requests page reads config live, so a pr_lists or repos edit applies at its next read.
  const prLists = new PrLists({
    lists: () => Object.entries(config.pr_lists).map(([name, list]) => ({ name, ...list })),
    repos: () => githubRepos(config.repos),
    search: ghSearch(),
  });
  const app = createApp({ config, home, tick, tickets, versions, sessions, feedback, runs, progress, terminal, exits, overrides, budgets, queue, changes, prLists, dashboard, version: pkg.version, missingTools, versionNotice: () => versionCheck.current() });

  if (defaults.wroteConfig) log.info("config.written", { file: home.configFile });
  if (defaults.wrotePipeline) log.info("pipeline.written", { name: "default" });

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
    void startup.then(() => tick.settle()).then(() => Promise.all([runs.shutdown(), actions.shutdown(), checks.shutdown()])).then(() => mirror.settle()).then(() => finished).then(() => {
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
