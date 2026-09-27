import { serve as listen } from "@hono/node-server";
import { createRequire } from "node:module";
import { resolveHome, ensureHome } from "./home.ts";
import { loadConfig } from "./config.ts";
import { acquireLock, AlreadyRunning } from "./lock.ts";
import { createLogger } from "./log.ts";
import { Store } from "../store/store.ts";
import { Tickets } from "../store/tickets.ts";
import { Sessions } from "../store/sessions.ts";
import { Runs } from "../session/runs.ts";
import { Progress } from "../session/progress.ts";
import { Terminal } from "../session/terminal.ts";
import { createNotifier } from "../notify/notifier.ts";
import { Tick } from "./tick.ts";
import { createApp } from "../api/app.ts";

const VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

export interface ServeOptions {
  portFlag?: number;
}

/** The one foreground lasso process (ADR 0008). Resolves with the exit code once it has shut down. */
export async function serve(opts: ServeOptions): Promise<number> {
  const home = resolveHome();
  const defaults = ensureHome(home);
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

  const store = new Store(home.dbFile);
  const tickets = new Tickets(store.db);
  const sessions = new Sessions(store.db);
  const notifier = createNotifier({ config: config.notifications, log, baseUrl: `http://localhost:${config.port}` });
  const progress = new Progress({ home, tickets, sessions, log, notifier });
  const terminal = new Terminal({ home, sessions, log });
  const runs = new Runs({ config, home, tickets, sessions, log, progress });
  const tick = new Tick(config.tick, log, () => runs.startRunnable());
  const app = createApp({ config, home, tick, tickets, sessions, runs, progress, terminal, version: VERSION });

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
  log.info("started", { home: home.root, port: config.port, pid: process.pid, version: VERSION });
  console.log(`lasso listening at ${url}`);

  runs.reconcile();
  await tick.run("startup");
  tick.start();

  return new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("shutdown", { signal });
      tick.stop();
      const finished = new Promise<void>((done) => server.close(() => done()));
      void runs.shutdown().then(() => finished).then(() => {
        store.close();
        releaseLock();
        resolve(0);
      });
      setTimeout(() => {
        releaseLock();
        resolve(0);
      }, 8000).unref();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}
