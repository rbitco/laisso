import { Hono } from "hono";
import type { Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Tick } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import type { Runs } from "../session/runs.ts";
import { RunError } from "../session/runs.ts";
import { ArtifactWarning, TriggerError, type Progress } from "../session/progress.ts";
import { TerminalError, type Terminal } from "../session/terminal.ts";
import { Intake, IntakeError, type IntakeRequest } from "../intake/intake.ts";
import { loadPipeline, type Pipeline } from "../pipeline/load.ts";
import { dashboardHtml } from "../dashboard/page.ts";
import { ticketView, ticketDetail, sessionView, sortForLedger, type ViewContext, type IntakeResult } from "./views.ts";

export interface AppDeps {
  config: Config;
  home: LassoHome;
  tick: Tick;
  tickets: Tickets;
  sessions: Sessions;
  runs: Runs;
  progress: Progress;
  terminal: Terminal;
  version: string;
}

/** The one JSON API under /api. The dashboard page and the CLI are both clients of it. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const intake = new Intake({ config: deps.config, home: deps.home, tickets: deps.tickets });
  const baseUrl = `http://localhost:${deps.config.port}`;
  const viewContext: ViewContext = {
    baseUrl,
    pipelineFor: (ticket: TicketRow): Pipeline | null => {
      try {
        return loadPipeline(deps.home.pipelinesDir, ticket.pipeline);
      } catch {
        return null;
      }
    },
    sessionsFor: (ticket: TicketRow) => deps.sessions.forTicket(ticket.id),
    latestSession: (ticket: TicketRow) => deps.sessions.latest(ticket.id),
  };

  // Every response carries the version, so a client can tell Lasso from a stranger on the port.
  app.use("*", async (c, next) => {
    await next();
    c.header("x-lasso-version", deps.version);
  });

  app.onError((error, c) => {
    if (error instanceof IntakeError || error instanceof RunError || error instanceof TriggerError || error instanceof TerminalError) return c.json({ error: error.message }, 400);
    if (error instanceof ArtifactWarning) return c.json({ error: error.message, artifact: error.artifact, detail: error.detail, override: true }, 409);
    console.error(error);
    return c.json({ error: error.message }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, pid: process.pid, version: deps.version }));

  app.get("/api/tick", (c) => c.json(deps.tick.status()));
  app.post("/api/check-now", async (c) => c.json(await deps.tick.run("check-now")));

  app.post("/api/intake/detect", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { input?: string; repo?: string };
    if (!body.input?.trim()) return c.json({ error: "nothing to intake: paste a reference or type a prompt" }, 400);
    return c.json(await intake.detect(body.input, body.repo));
  });

  app.get("/api/tickets", (c) => {
    const all = c.req.query("all") === "1" || c.req.query("all") === "true";
    return c.json(sortForLedger(deps.tickets.list({ all }).map((t) => ticketView(t, viewContext))));
  });

  app.post("/api/tickets", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<IntakeRequest>;
    const { ticket, branchExisted } = await intake.admit({ input: body.input ?? "", repo: body.repo, pipeline: body.pipeline });
    const first = deps.progress.current(ticket);
    if (!("problem" in first)) deps.progress.entered(ticket, first.stage);
    const result: IntakeResult = { ...ticketView(ticket, viewContext), branchExisted };
    return c.json(result, 201);
  });

  app.get("/api/tickets/:id", (c) => {
    const ticket = deps.tickets.find(c.req.param("id"));
    if (!ticket) return c.json({ error: `no Ticket matches ${c.req.param("id")}` }, 404);
    return c.json(ticketDetail(ticket, viewContext));
  });

  // The Triggers on a Ticket (spec: Triggers per Ticket). Each answers with the Ticket as it now stands.
  const trigger = (route: string, pull: (ticket: TicketRow, body: Record<string, unknown>) => Promise<TicketRow> | TicketRow) =>
    app.post(`/api/tickets/:id/${route}`, async (c) => {
      const ticket = deps.tickets.find(c.req.param("id"));
      if (!ticket) return c.json({ error: `no Ticket matches ${c.req.param("id")}` }, 404);
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      return c.json(ticketDetail(await pull(ticket, body), viewContext));
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

  app.get("/", (c) => c.html(dashboardHtml()));

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("not found", 404)));

  return app;
}
