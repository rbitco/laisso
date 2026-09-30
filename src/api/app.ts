import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Changes, Change } from "../server/changes.ts";
import { ConfigError, patchConfigText, applyLive, RESTART_KEYS, parseConfig, currentActions, type Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Tick } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { PipelineVersions } from "../store/versions.ts";
import type { Sessions } from "../store/sessions.ts";
import type { Feedback } from "../store/feedback.ts";
import type { Runs } from "../session/runs.ts";
import { RunError } from "../session/runs.ts";
import { ArtifactWarning, TriggerError, type Progress } from "../session/progress.ts";
import { TerminalError, type Terminal } from "../session/terminal.ts";
import type { Exits, ExtendRequest } from "../session/exits.ts";
import type { Budgets } from "../budget/budgets.ts";
import type { Queue } from "../session/queue.ts";
import { Intake, IntakeError, type IntakeRequest } from "../intake/intake.ts";
import { PipelineError, type Pipeline } from "../pipeline/load.ts";
import { PipelineFiles } from "../pipeline/files.ts";
import { dashboardHtml, metroScript } from "../dashboard/page.ts";
import { ticketView, ticketDetail, sessionView, sortForLedger, pipelineListing, pipelineFileView, pipelineVersionView, type ViewContext, type IntakeResult, type ConfigFile } from "./views.ts";
import { readFileSync } from "node:fs";
import { replaceFile } from "../atomic-write.ts";

export interface AppDeps {
  config: Config;
  home: LassoHome;
  tick: Tick;
  tickets: Tickets;
  versions: PipelineVersions;
  sessions: Sessions;
  feedback: Feedback;
  runs: Runs;
  progress: Progress;
  terminal: Terminal;
  exits: Exits;
  budgets: Budgets;
  queue: Queue;
  changes: Changes;
  version: string;
}

/** How long /api/events gathers changes before sending: a burst of writes to one Ticket goes out as one event. */
const EVENT_GATHER_MS = 150;
/** A comment line this often keeps idle proxies and the browser from dropping the stream. */
const EVENT_KEEPALIVE_MS = 20_000;

/** The one JSON API under /api. The dashboard page and the CLI are both clients of it. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const intake = new Intake({ config: deps.config, home: deps.home, tickets: deps.tickets, versions: deps.versions });
  const baseUrl = `http://localhost:${deps.config.port}`;
  const views: Omit<ViewContext, "queuePosition"> = {
    baseUrl,
    pipelineFor: (ticket: TicketRow): Pipeline | null => {
      try {
        return deps.versions.forTicket(ticket, deps.home.pipelinesDir);
      } catch {
        return null;
      }
    },
    driftFor: (ticket: TicketRow) => deps.versions.drift(ticket, deps.home.pipelinesDir),
    sessionsFor: (ticket: TicketRow) => deps.sessions.forTicket(ticket.id),
    feedbackFor: (session) => deps.feedback.forSession(session.id),
    budgetFor: (ticket, pipeline, stage, rows) => deps.budgets.view(ticket, pipeline, stage, rows),
  };
  /** The view context for one request: queue positions are computed once for every Ticket it renders. */
  const viewContext = (): ViewContext => {
    const positions = deps.queue.positions();
    return { ...views, queuePosition: (ticket) => positions.get(ticket.id) ?? null };
  };

  // Every response carries the version, so a client can tell Lasso from a stranger on the port.
  app.use("*", async (c, next) => {
    await next();
    c.header("x-lasso-version", deps.version);
  });

  app.onError((error, c) => {
    if (error instanceof IntakeError || error instanceof RunError || error instanceof TriggerError || error instanceof TerminalError || error instanceof PipelineError || error instanceof ConfigError) return c.json({ error: error.message }, 400);
    if (error instanceof ArtifactWarning) return c.json({ error: error.message, artifact: error.artifact, detail: error.detail, override: true }, 409);
    console.error(error);
    return c.json({ error: error.message }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, pid: process.pid, version: deps.version }));

  app.get("/api/tick", (c) => c.json(deps.tick.status()));

  // The dashboard's push channel (Server-Sent Events). Each event names what changed, never the data:
  // "ticket" {ticket}, "stdout" {ticket, session}, "tick" {the tick status}. The page re-reads what it
  // shows through the ordinary routes, and after a reconnect re-reads everything, as it may have missed some.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const gathered = new Map<string, Change>();
      let timer: NodeJS.Timeout | null = null;
      const flush = async () => {
        timer = null;
        const batch = [...gathered.values()];
        gathered.clear();
        for (const change of batch) {
          if (stream.aborted || stream.closed) return;
          const data = change.kind === "tick" ? deps.tick.status() : change.kind === "stdout" ? { ticket: change.ticket, session: change.session } : { ticket: change.ticket };
          await stream.writeSSE({ event: change.kind, data: JSON.stringify(data) });
        }
      };
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      const unsubscribe = deps.changes.subscribe((change) => {
        gathered.set(change.kind === "tick" ? "tick" : change.kind === "stdout" ? `stdout:${change.session}` : `ticket:${change.ticket}`, change);
        timer ??= setTimeout(() => void flush().catch(finish), EVENT_GATHER_MS);
      }, () => finish());
      stream.onAbort(() => finish());
      const keepalive = setInterval(() => void stream.write(": keepalive\n\n").catch(finish), EVENT_KEEPALIVE_MS);
      await stream.writeSSE({ event: "hello", data: JSON.stringify(deps.tick.status()) });
      await finished;
      unsubscribe();
      clearInterval(keepalive);
      if (timer) clearTimeout(timer);
    }),
  );
  app.post("/api/check-now", async (c) => c.json(await deps.tick.run("check-now")));

  app.post("/api/intake/detect", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { input?: string; repo?: string };
    if (!body.input?.trim()) return c.json({ error: "nothing to intake: paste a reference or type a prompt" }, 400);
    return c.json(await intake.detect(body.input, body.repo));
  });

  app.get("/api/tickets", (c) => {
    const all = c.req.query("all") === "1" || c.req.query("all") === "true";
    const ctx = viewContext();
    return c.json(sortForLedger(deps.tickets.list({ all }).map((t) => ticketView(t, ctx))));
  });

  app.post("/api/tickets", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<IntakeRequest>;
    const { ticket, branchExisted } = await intake.admit({ input: body.input ?? "", repo: body.repo, pipeline: body.pipeline });
    await deps.progress.admitted(ticket);
    const result: IntakeResult = { ...ticketView(deps.tickets.get(ticket.id)!, viewContext()), branchExisted };
    return c.json(result, 201);
  });

  app.get("/api/tickets/:id", (c) => {
    const ticket = deps.tickets.find(c.req.param("id"));
    if (!ticket) return c.json({ error: `no Ticket matches ${c.req.param("id")}` }, 404);
    return c.json(ticketDetail(ticket, viewContext()));
  });

  // The Triggers on a Ticket (spec: Triggers per Ticket). Each answers with the Ticket as it now stands.
  const trigger = (route: string, pull: (ticket: TicketRow, body: Record<string, unknown>) => Promise<TicketRow> | TicketRow) =>
    app.post(`/api/tickets/:id/${route}`, async (c) => {
      const ticket = deps.tickets.find(c.req.param("id"));
      if (!ticket) return c.json({ error: `no Ticket matches ${c.req.param("id")}` }, 404);
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      return c.json(ticketDetail(await pull(ticket, body), viewContext()));
    });

  trigger("terminal", async (ticket) => {
    await deps.terminal.open(ticket, deps.progress.humanStage(ticket).stage);
    return deps.tickets.get(ticket.id)!;
  });
  trigger("done", (ticket, body) => deps.progress.markDone(ticket, body.override === true));
  trigger("skip", (ticket) => deps.progress.skip(ticket));
  trigger("start", async (ticket) => {
    const released = deps.progress.start(ticket);
    await deps.tick.run("start");
    return deps.tickets.get(released.id)!;
  });
  // The six exits from a Flag; Mark done and Skip above accept a Flagged Ticket too, and Abandon any active one.
  trigger("retry", (ticket) => deps.exits.retry(ticket));
  trigger("resume", (ticket) => deps.exits.resume(ticket));
  trigger("extend", (ticket, body) => deps.exits.extend(ticket, body as ExtendRequest));
  trigger("abandon", (ticket) => deps.exits.abandon(ticket));

  // A Session of a Ticket, or the 404 that says which is unknown.
  const sessionOf = (ticketKey: string, sessionId: string) => {
    const ticket = deps.tickets.find(ticketKey);
    if (!ticket) return { error: `no Ticket matches ${ticketKey}` };
    const session = deps.sessions.get(sessionId);
    if (!session || session.ticket !== ticket.id) return { error: `no Session ${sessionId} on ${ticketKey}` };
    return { session };
  };

  app.get("/api/tickets/:id/sessions/:sid/stdout", (c) => {
    const found = sessionOf(c.req.param("id"), c.req.param("sid"));
    if ("error" in found) return c.json({ error: found.error }, 404);
    const offset = Number(c.req.query("offset") ?? 0) || 0;
    return c.json(deps.runs.readStdout(found.session, offset));
  });

  app.post("/api/tickets/:id/sessions/:sid/stop", async (c) => {
    const found = sessionOf(c.req.param("id"), c.req.param("sid"));
    if ("error" in found) return c.json({ error: found.error }, 404);
    return c.json(sessionView(await deps.runs.stop(found.session)));
  });

  // Pipeline files, edited in place (spec: Lasso home and configuration). Nothing is written that does not parse.
  const pipelines = new PipelineFiles(deps.home.pipelinesDir, () => currentActions(deps.home, deps.config));
  app.get("/api/pipelines", (c) => c.json(pipelines.list().map(pipelineListing)));
  app.get("/api/pipelines/:name", (c) => {
    const source = pipelines.read(c.req.param("name"));
    return source ? c.json(pipelineFileView(source)) : c.json({ error: `no Pipeline named ${c.req.param("name")}` }, 404);
  });
  // Versions (ADR 0009): read-only, and readable after the file is gone.
  app.get("/api/pipelines/:name/versions", (c) => c.json(deps.versions.live(c.req.param("name")).map((v) => ({ version: v.version, createdAt: v.created_at, live: v.live }))));
  app.get("/api/pipelines/:name/versions/:version", (c) => {
    const name = c.req.param("name");
    const version = Number(c.req.param("version"));
    const row = Number.isInteger(version) ? deps.versions.row(name, version) : null;
    const pipeline = row ? deps.versions.get(name, version) : null;
    return row && pipeline ? c.json(pipelineVersionView(row, pipeline, pipelines.read(name) === null)) : c.json({ error: `no Version ${c.req.param("version")} of Pipeline ${name}` }, 404);
  });
  app.put("/api/pipelines/:name", async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { text?: unknown; create?: unknown };
    return c.json(pipelineFileView(pipelines.write(c.req.param("name"), body.text, { create: body.create === true })));
  });
  app.patch("/api/pipelines/:name", async (c) => {
    const patch = await c.req.json().catch(() => null);
    return c.json(pipelineFileView(pipelines.patch(c.req.param("name"), patch)));
  });
  app.delete("/api/pipelines/:name", (c) => {
    if (!pipelines.remove(c.req.param("name"))) return c.json({ error: `no Pipeline named ${c.req.param("name")}` }, 404);
    return c.json({ ok: true });
  });

  // config.yaml, as the file has it: the running port and tick may differ until a restart.
  const configText = () => {
    try {
      return readFileSync(deps.home.configFile, "utf8");
    } catch {
      return "";
    }
  };
  const configFile = (text: string, restart: string[] = []): ConfigFile => ({ file: deps.home.configFile, text, config: parseConfig(text, deps.home.configFile), restart });
  app.get("/api/config", (c) => c.json(configFile(configText())));
  app.patch("/api/config", async (c) => {
    const patch = await c.req.json().catch(() => null);
    // Read, patch and write without yielding in between, so two edits cannot both start from the same text.
    const before = configText();
    const was = parseConfig(before, deps.home.configFile);
    const { text, config } = patchConfigText(before, deps.home.configFile, patch);
    replaceFile(deps.home.configFile, text);
    applyLive(deps.config, config);
    return c.json(configFile(text, RESTART_KEYS.filter((key) => was[key] !== config[key])));
  });

  app.get("/", (c) => c.html(dashboardHtml()));
  app.get("/metro.js", (c) => c.body(metroScript(), 200, { "content-type": "text/javascript; charset=utf-8" }));

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("not found", 404)));

  return app;
}
