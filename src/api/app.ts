import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Changes, Change } from "../server/changes.ts";
import { ConfigError, patchConfigText, writeProfileText, deleteProfileText, repoDefaultText, profileNamers, applyLive, RESTART_KEYS, parseConfig, currentConfig, prListsBlock, prListsText, type Config } from "../server/config.ts";
import type { PrLists } from "../prs/lists.ts";
import type { LassoHome } from "../server/home.ts";
import type { Tick } from "../server/tick.ts";
import { parseName, type Tickets, type TicketRow } from "../store/tickets.ts";
import type { PipelineVersions } from "../store/versions.ts";
import type { Sessions } from "../store/sessions.ts";
import type { Feedback } from "../store/feedback.ts";
import type { Runs } from "../session/runs.ts";
import { RunError } from "../session/runs.ts";
import { ArtifactWarning, TriggerError, type Progress } from "../session/progress.ts";
import { TerminalError, type Terminal } from "../session/terminal.ts";
import type { Exits, ExtendRequest } from "../session/exits.ts";
import type { Overrides } from "../session/overrides.ts";
import type { Budgets } from "../budget/budgets.ts";
import type { Queue } from "../session/queue.ts";
import { Intake, IntakeError, type IntakeRequest } from "../intake/intake.ts";
import { PipelineError, type Pipeline } from "../pipeline/load.ts";
import { PipelineFiles } from "../pipeline/files.ts";
import type { Dashboard } from "../dashboard/page.ts";
import { ticketView, ticketDetail, sessionView, sortForLedger, pipelineListing, pipelineFileView, pipelineVersionView, actionListings, type LiveVersionView, type ViewContext, type IntakeResult, type ConfigFile, type PrListsYaml, type Health, type MissingTool, type VersionView } from "./views.ts";
import { readFileSync } from "node:fs";
import { isPlainObject } from "../fields.ts";
import { replaceFile } from "../atomic-write.ts";
import { noticeText, type VersionNotice } from "../version-notice.ts";

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
  overrides: Overrides;
  budgets: Budgets;
  queue: Queue;
  changes: Changes;
  /** The Pull Requests page's lists, cached in memory for every tab. */
  prLists: PrLists;
  dashboard: Dashboard;
  version: string;
  /** Needed tools PATH lacked at startup; the dashboard header lists them. */
  missingTools?: MissingTool[];
  /** The version notice as last checked (held by VersionCheck). */
  versionNotice: () => VersionNotice;
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
  const views: Omit<ViewContext, "queuePosition" | "profiles"> = {
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
  /** The view context for one request: queue positions and config.yaml are read once for every Ticket it renders. */
  const viewContext = (): ViewContext => {
    const positions = deps.queue.positions();
    return { ...views, queuePosition: (ticket) => positions.get(ticket.id) ?? null, profiles: currentConfig(deps.home, deps.config) };
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

  app.get("/api/health", (c) => c.json({ ok: true, pid: process.pid, version: deps.version, home: deps.home.root, missingTools: deps.missingTools ?? [] } satisfies Health));

  app.get("/api/version", (c) => {
    const notice = deps.versionNotice();
    return c.json({ version: deps.version, notice, text: noticeText(notice) } satisfies VersionView);
  });

  app.get("/api/tick", (c) => c.json(deps.tick.status()));

  // The dashboard's push channel (Server-Sent Events). Each event names what changed, never the data:
  // "ticket" {ticket}, "stdout" {ticket, session}, "tick" {the tick status}, "config" {} and "pipeline" {pipeline} after an edit through /api,
  // "version" {} when the version notice changes, "prlists" {} when a PR List starts or finishes fetching. The page re-reads what it shows through the ordinary routes, and
  // after a reconnect re-reads everything, as it may have missed some.
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
          const data = change.kind === "tick" ? deps.tick.status() : change.kind === "config" || change.kind === "version" || change.kind === "prlists" ? {} : change.kind === "pipeline" ? { pipeline: change.pipeline } : change.kind === "stdout" ? { ticket: change.ticket, session: change.session } : { ticket: change.ticket };
          await stream.writeSSE({ event: change.kind, data: JSON.stringify(data) });
        }
      };
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      const unsubscribe = deps.changes.subscribe((change) => {
        gathered.set(change.kind === "tick" || change.kind === "config" || change.kind === "version" || change.kind === "prlists" ? change.kind : change.kind === "pipeline" ? `pipeline:${change.pipeline}` : change.kind === "stdout" ? `stdout:${change.session}` : `ticket:${change.ticket}`, change);
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
  // Check now also refreshes every PR List, whether or not a Tick is already running to join.
  app.post("/api/check-now", async (c) => {
    await deps.prLists.checkNow();
    return c.json(await deps.tick.run("check-now"));
  });

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
    const { ticket, branchExisted } = await intake.admit({ input: body.input ?? "", repo: body.repo, pipeline: body.pipeline, name: body.name });
    await deps.progress.admitted(ticket);
    const result: IntakeResult = { ...ticketView(deps.tickets.get(ticket.id)!, viewContext()), branchExisted };
    return c.json(result, 201);
  });

  // Name a Ticket (LASSO-108): shown in place of its reference or short id; null or empty clears it. Any state may be renamed.
  app.put("/api/tickets/:id/name", async (c) => {
    const ticket = deps.tickets.find(c.req.param("id"));
    if (!ticket) return c.json({ error: `no Ticket matches ${c.req.param("id")}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const named = parseName(body.name);
    if ("problem" in named) return c.json({ error: named.problem }, 400);
    deps.tickets.update(ticket.id, { name: named.name });
    return c.json(ticketDetail(deps.tickets.get(ticket.id)!, viewContext()));
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
    const { pipeline, stage } = deps.progress.humanStage(ticket);
    await deps.terminal.open(ticket, pipeline, stage);
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
  // Retry with { profile } ("retry with…") sets the Stage's override to it first, then retries under it.
  trigger("retry", (ticket, body) => deps.exits.retry(ticket, body.profile));
  trigger("resume", (ticket) => deps.exits.resume(ticket));
  trigger("extend", (ticket, body) => deps.exits.extend(ticket, body as ExtendRequest));
  trigger("abandon", (ticket) => deps.exits.abandon(ticket));
  // A human steps into a headless Stage's Session in a terminal and hands it back, or reads the draft a gate holds before Start.
  trigger("takeover", (ticket) => deps.exits.takeOver(ticket));
  trigger("handback", (ticket) => deps.exits.handBack(ticket));
  trigger("draft", (ticket) => deps.exits.openDraft(ticket));

  // A human's profile for one Runner Stage of one Ticket (LASSO-75): it wins over the Pipeline's choice from the
  // Stage's next Session, retries and Rounds included, until cleared. A Session already running keeps its own.
  const stageRoute = "/api/tickets/:id/stages/:stage/profile";
  app.put(stageRoute, async (c) => {
    const ticket = deps.tickets.find(c.req.param("id"));
    if (!ticket) return c.json({ error: `no Ticket matches ${c.req.param("id")}` }, 404);
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { profile?: unknown };
    return c.json(ticketDetail(deps.overrides.set(ticket, c.req.param("stage"), body.profile), viewContext()));
  });
  app.delete(stageRoute, (c) => {
    const ticket = deps.tickets.find(c.req.param("id"));
    if (!ticket) return c.json({ error: `no Ticket matches ${c.req.param("id")}` }, 404);
    return c.json(ticketDetail(deps.overrides.clear(ticket, c.req.param("stage")), viewContext()));
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

  // Pipeline files, edited in place (spec: Lasso home and configuration). Nothing is written that does not parse.
  const pipelines = new PipelineFiles(deps.home.pipelinesDir, () => currentConfig(deps.home, deps.config));
  app.get("/api/pipelines", (c) => c.json(pipelines.list().map(pipelineListing)));
  app.get("/api/pipelines/:name", (c) => {
    const source = pipelines.read(c.req.param("name"));
    return source ? c.json(pipelineFileView(source)) : c.json({ error: `no Pipeline named ${c.req.param("name")}` }, 404);
  });
  // Versions (ADR 0009): read-only, and readable after the file is gone.
  app.get("/api/pipelines/:name/versions", (c) => c.json(deps.versions.live(c.req.param("name")).map((v): LiveVersionView => ({ version: v.version, createdAt: v.created_at, live: v.live }))));
  app.get("/api/pipelines/:name/versions/:version", (c) => {
    const name = c.req.param("name");
    const version = Number(c.req.param("version"));
    const row = Number.isInteger(version) ? deps.versions.row(name, version) : null;
    const pipeline = row ? deps.versions.get(name, version) : null;
    return row && pipeline ? c.json(pipelineVersionView(row, pipeline, pipelines.read(name) === null)) : c.json({ error: `no Version ${c.req.param("version")} of Pipeline ${name}` }, 404);
  });
  // Each write is announced by name, so an open Pipelines page reads its list again.
  const pipelineChanged = (pipeline: string) => deps.changes.emit({ kind: "pipeline", pipeline });
  app.put("/api/pipelines/:name", async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { text?: unknown; create?: unknown };
    const written = pipelines.write(c.req.param("name"), body.text, { create: body.create === true });
    pipelineChanged(written.name);
    return c.json(pipelineFileView(written));
  });
  app.patch("/api/pipelines/:name", async (c) => {
    const patch = await c.req.json().catch(() => null);
    const written = pipelines.patch(c.req.param("name"), patch);
    pipelineChanged(written.name);
    return c.json(pipelineFileView(written));
  });
  app.delete("/api/pipelines/:name", (c) => {
    if (!pipelines.remove(c.req.param("name"))) return c.json({ error: `no Pipeline named ${c.req.param("name")}` }, 404);
    pipelineChanged(c.req.param("name"));
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
  // The Actions a Pipeline's action Stages may run (ADR 0010), as config.yaml has them now; edited in the file.
  app.get("/api/actions", (c) => c.json(actionListings(currentConfig(deps.home, deps.config))));
  app.patch("/api/config", async (c) => {
    const patch = await c.req.json().catch(() => null);
    // Read, patch and write without yielding in between, so two edits cannot both start from the same text.
    const before = configText();
    const was = parseConfig(before, deps.home.configFile);
    const { text, config } = patchConfigText(before, deps.home.configFile, patch);
    replaceFile(deps.home.configFile, text);
    applyLive(deps.config, config);
    deps.changes.emit({ kind: "config" });
    return c.json(configFile(text, RESTART_KEYS.filter((key) => was[key] !== config[key])));
  });

  // Agent Profiles (ADR 0011), one global profile at a time, written into config.yaml in place and
  // checked as config load checks it. Like any config edit they apply at once: the next Session reads them.
  const writeConfig = (text: string, config: Config): ConfigFile => {
    replaceFile(deps.home.configFile, text);
    applyLive(deps.config, config);
    deps.changes.emit({ kind: "config" });
    return configFile(text);
  };
  app.put("/api/profiles/:name", async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { profile?: unknown; create?: unknown };
    const create = body.create === true;
    const { text, config } = writeProfileText(configText(), deps.home.configFile, c.req.param("name"), body.profile, { create });
    return c.json(writeConfig(text, config), create ? 201 : 200);
  });
  // PR Lists, edited on the Config page as their YAML block; like any config edit they apply at once.
  app.get("/api/config/pr-lists", (c) => c.json({ text: prListsBlock(configText()) } satisfies PrListsYaml));
  app.put("/api/config/pr-lists", async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { text?: unknown };
    if (typeof body.text !== "string") return c.json({ error: "text must be the pr_lists: block as YAML" }, 400);
    const { text, config } = prListsText(configText(), deps.home.configFile, body.text);
    writeConfig(text, config);
    return c.json({ text: prListsBlock(text) } satisfies PrListsYaml);
  });
  // The Pull Requests page: every PR List in config order, fetching any not fetched yet.
  app.get("/api/pr-lists", async (c) => c.json(await deps.prLists.read()));
  // What still names a profile is listed first and the delete waits for ?confirm=1, as those Stages would be Flagged at their next Session.
  app.delete("/api/profiles/:name", (c) => {
    const name = c.req.param("name");
    const before = configText();
    const current = parseConfig(before, deps.home.configFile);
    if (!current.profiles[name]) return c.json({ error: `no profile named ${name} in config.yaml` }, 404);
    const { text, config } = deleteProfileText(before, deps.home.configFile, name);
    const namers = [...profileNamers(current, name), ...pipelineNamers(name)];
    if (namers.length && c.req.query("confirm") !== "1") {
      return c.json({ error: `${name} is named by ${namers.join(", ")}; their next Sessions are Flagged once it is gone`, usedBy: namers, confirm: true }, 409);
    }
    return c.json(writeConfig(text, config));
  });
  // A repo's own profiles (LASSO-74): one replaces the global of its name whole for that repo's Tickets, so
  // creating one from a copy of the global and deleting it again are how the drawer overrides and restores.
  const knownRepo = (repo: string) => (parseConfig(configText(), deps.home.configFile).repos[repo] ? null : { error: `no repo named ${repo} in config.yaml` });
  app.put("/api/repos/:repo/profiles/:name", async (c) => {
    const repo = c.req.param("repo");
    const missing = knownRepo(repo);
    if (missing) return c.json(missing, 404);
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { profile?: unknown; create?: unknown };
    const create = body.create === true;
    const { text, config } = writeProfileText(configText(), deps.home.configFile, c.req.param("name"), body.profile, { create, repo });
    return c.json(writeConfig(text, config), create ? 201 : 200);
  });
  // Removing an override returns the repo to the global profile at once. A repo-only profile has no global to
  // fall back on, so a Pipeline still naming it is listed first and the delete waits for ?confirm=1.
  app.delete("/api/repos/:repo/profiles/:name", (c) => {
    const [repo, name] = [c.req.param("repo"), c.req.param("name")];
    const before = configText();
    const current = parseConfig(before, deps.home.configFile);
    if (!current.repos[repo]) return c.json({ error: `no repo named ${repo} in config.yaml` }, 404);
    if (!current.repos[repo].profiles[name]) return c.json({ error: `no profile named ${name} in repo ${repo}` }, 404);
    const { text, config } = deleteProfileText(before, deps.home.configFile, name, { repo });
    const namers = current.profiles[name] ? [] : pipelineNamers(name);
    if (namers.length && c.req.query("confirm") !== "1") {
      return c.json({ error: `${name} is named by ${namers.join(", ")}; their next Sessions in repo ${repo} are Flagged once it is gone`, usedBy: namers, confirm: true }, 409);
    }
    return c.json(writeConfig(text, config));
  });
  // A repo's default_profile: a profile its Tickets can reach, or null to fall back on config's.
  app.patch("/api/repos/:repo", async (c) => {
    const repo = c.req.param("repo");
    const missing = knownRepo(repo);
    if (missing) return c.json(missing, 404);
    const patch = await c.req.json().catch(() => null);
    if (!isPlainObject(patch) || Object.keys(patch).join() !== "default_profile") return c.json({ error: "only a repo's default_profile is set here; the rest of a repo is edited in config.yaml by hand" }, 400);
    const { text, config } = repoDefaultText(configText(), deps.home.configFile, repo, patch.default_profile);
    return c.json(writeConfig(text, config));
  });
  /** Each Pipeline and Stage that names a profile in its file. */
  const pipelineNamers = (name: string): string[] =>
    pipelines.list().flatMap(({ pipeline }) => {
      if (!pipeline) return [];
      const named = pipeline.profile === name ? [`Pipeline ${pipeline.name}`] : [];
      for (const s of pipeline.stages) if (s.kind === "runner" && s.profile === name) named.push(`${pipeline.name}/${s.name}`);
      return named;
    });

  // The built dashboard (ADR 0012): its page and the files Vite bundled beside it.
  app.get("*", (c, next) => {
    const file = deps.dashboard.file(c.req.path);
    return file ? c.body(new Uint8Array(file.body), 200, { "content-type": file.type }) : next();
  });

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("not found", 404)));

  return app;
}
