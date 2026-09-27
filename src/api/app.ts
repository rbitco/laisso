import { Hono } from "hono";
import type { Store } from "../store/store.ts";
import type { Config } from "../server/config.ts";
import type { Tick } from "../server/tick.ts";
import { dashboardHtml } from "../dashboard/page.ts";

export interface AppDeps {
  store: Store;
  config: Config;
  tick: Tick;
  version: string;
}

/** The one JSON API under /api. The dashboard page and the CLI are both clients of it. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Every response carries the version, so a client can tell Lasso from a stranger on the port.
  app.use("*", async (c, next) => {
    await next();
    c.header("x-lasso-version", deps.version);
  });

  app.get("/api/health", (c) => c.json({ ok: true, pid: process.pid, version: deps.version }));

  app.get("/api/tickets", (c) => c.json([]));

  app.get("/api/tickets/:id", (c) => c.json({ error: `no Ticket matches ${c.req.param("id")}` }, 404));

  app.get("/api/tick", (c) => c.json(deps.tick.status()));

  app.post("/api/check-now", async (c) => c.json(await deps.tick.run("check-now")));

  app.get("/", (c) => c.html(dashboardHtml()));

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("not found", 404)));

  return app;
}
