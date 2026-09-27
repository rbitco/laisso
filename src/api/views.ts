import { shortId, type TicketRow } from "../store/tickets.ts";
import type { SessionRow } from "../store/sessions.ts";
import type { Pipeline, Stage } from "../pipeline/load.ts";

export type DisplayState = "flagged" | "needs_you" | "holding" | "ready" | "running" | "queued" | "quiet" | "done" | "abandoned";

/** A lever the human can pull on a Ticket right now; the dashboard renders one button per Trigger. */
export interface Trigger {
  action: "terminal" | "done" | "skip" | "start";
  label: string;
}

/** Human wording for each display state, served so every client shows the same words. */
export const DISPLAY_LABEL: Record<DisplayState, string> = {
  flagged: "Flagged",
  needs_you: "Needs you",
  holding: "Holding",
  ready: "Ready to start",
  running: "Running",
  queued: "Queued",
  quiet: "Quiet",
  done: "Done",
  abandoned: "Abandoned",
};

export interface StageView {
  name: string;
  kind: Stage["kind"];
  /** What the Ledger and the stations show: the Stage name, or the tracker status for a transition. */
  label: string;
  human: boolean;
  index: number;
  total: number;
}

export interface TicketView {
  id: string;
  /** The last 8 characters of the id: what a prompt Ticket shows in place of a reference. */
  shortId: string;
  title: string;
  reference: string | null;
  origin: "tracker" | "prompt";
  /** The issue body pulled at intake, or the prompt text; what a Stage prompt gets to read. */
  body: string | null;
  repo: string;
  branch: string;
  worktree: string;
  pipeline: string;
  stage: StageView;
  state: TicketRow["state"];
  flag: { at: string; reason: string; detail: string | null } | null;
  pr: string | null;
  display: { state: DisplayState; label: string; why: string };
  triggers: Trigger[];
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface SessionView {
  id: string;
  ticket: string;
  stage: string;
  ordinal: number;
  mode: SessionRow["mode"];
  startedBy: SessionRow["started_by"];
  startedAt: string;
  endedAt: string | null;
  endedBy: SessionRow["ended_by"];
  endedReason: SessionRow["ended_reason"];
  outcome: SessionRow["outcome"];
  finalMessage: string | null;
  costUsd: number | null;
  usage: Record<string, unknown> | null;
  /** Which of the requested limits the Runner honoured itself. */
  limitsHonoured: string[];
  openedAt: string | null;
  stdoutPath: string | null;
  transcriptPath: string | null;
  running: boolean;
  /** Milliseconds so far, or to the end. */
  durationMs: number;
}

/** One Ticket with every Stage of its Pipeline and its Sessions, for the detail page. */
export interface TicketDetail extends TicketView {
  stages: Array<Pick<StageView, "name" | "kind" | "label" | "human">>;
  /** The latest Session: the pane shows it, running or not. */
  session: SessionView | null;
  /** The timeline, newest first. */
  sessions: SessionView[];
}

/** What intake returns: the new Ticket's view plus whether its branch was found rather than made. */
export interface IntakeResult extends TicketView {
  branchExisted: boolean;
}

export interface ViewContext {
  baseUrl: string;
  pipelineFor(ticket: TicketRow): Pipeline | null;
  /** A Ticket's Sessions, newest first. */
  sessionsFor(ticket: TicketRow): SessionRow[];
  latestSession(ticket: TicketRow): SessionRow | null;
}

/** The order the Ledger shows display states in: attention first. */
export const LEDGER_ORDER: DisplayState[] = ["flagged", "needs_you", "holding", "ready", "running", "queued", "quiet", "done", "abandoned"];

export function stageLabel(stage: Stage): string {
  return stage.kind === "action" ? stage.status : stage.name;
}

export function ticketView(ticket: TicketRow, ctx: ViewContext): TicketView {
  const pipeline = ctx.pipelineFor(ticket);
  const index = pipeline ? pipeline.stages.findIndex((s) => s.name === ticket.stage) : -1;
  const stage = index >= 0 ? pipeline!.stages[index]! : null;
  const human = stage?.kind === "runner" && stage.human;
  const latest = ctx.latestSession(ticket);
  const display = displayState(ticket, human, latest);
  const triggers = ticketTriggers(ticket, stage, latest);
  return {
    id: ticket.id,
    shortId: shortId(ticket.id),
    title: ticket.title,
    reference: ticket.reference,
    origin: ticket.origin,
    body: ticket.origin === "prompt" ? ticket.prompt : ticket.body,
    repo: ticket.repo,
    branch: ticket.branch,
    worktree: ticket.worktree,
    pipeline: ticket.pipeline,
    stage: {
      name: ticket.stage,
      kind: stage?.kind ?? "runner",
      label: stage ? stageLabel(stage) : ticket.stage,
      human,
      index,
      total: pipeline?.stages.length ?? 0,
    },
    state: ticket.state,
    flag: ticket.flagged_at ? { at: ticket.flagged_at, reason: ticket.flag_reason ?? "", detail: ticket.flag_detail } : null,
    pr: ticket.pr,
    display: { ...display, label: DISPLAY_LABEL[display.state] },
    triggers,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    url: `${ctx.baseUrl}/#${ticket.id}`,
  };
}

export function ticketDetail(ticket: TicketRow, ctx: ViewContext): TicketDetail {
  const pipeline = ctx.pipelineFor(ticket);
  const stages = (pipeline?.stages ?? []).map((s) => ({
    name: s.name,
    kind: s.kind,
    label: stageLabel(s),
    human: s.kind === "runner" && s.human,
  }));
  const sessions = ctx.sessionsFor(ticket).map(sessionView);
  return { ...ticketView(ticket, ctx), stages, session: sessions[0] ?? null, sessions };
}

export function sessionView(row: SessionRow, now: number = Date.now()): SessionView {
  const started = new Date(row.started_at).getTime();
  const ended = row.ended_at ? new Date(row.ended_at).getTime() : now;
  return {
    id: row.id,
    ticket: row.ticket,
    stage: row.stage,
    ordinal: row.ordinal,
    mode: row.mode,
    startedBy: row.started_by,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    endedReason: row.ended_reason,
    outcome: row.outcome,
    finalMessage: row.final_message,
    costUsd: row.cost_usd,
    usage: row.usage ? (JSON.parse(row.usage) as Record<string, unknown>) : null,
    limitsHonoured: row.limits_honoured ? (JSON.parse(row.limits_honoured) as string[]) : [],
    openedAt: row.opened_at,
    stdoutPath: row.stdout_path,
    transcriptPath: row.transcript_path,
    running: row.ended_at === null,
    durationMs: Math.max(0, ended - started),
  };
}

function displayState(ticket: TicketRow, human: boolean, latest: SessionRow | null): { state: DisplayState; why: string } {
  if (ticket.state === "done") return { state: "done", why: "done" };
  if (ticket.state === "abandoned") return { state: "abandoned", why: "abandoned" };
  if (ticket.flagged_at) return { state: "flagged", why: ticket.flag_reason ?? "flagged" };
  if (headlessRunning(latest)) return { state: "running", why: `${latest.stage}, run ${latest.ordinal}` };
  if (ticket.holding_since) return { state: "holding", why: `Start ${ticket.stage} when ready` };
  if (human) {
    const opened = latest && latest.ended_at === null && latest.mode === "terminal" && latest.stage === ticket.stage ? latest.opened_at : null;
    return { state: "needs_you", why: opened ? `terminal opened ${clockTime(opened)}` : "not started" };
  }
  return { state: "ready", why: `${ticket.stage} starts on the next tick` };
}

function ticketTriggers(ticket: TicketRow, stage: Stage | null, latest: SessionRow | null): Trigger[] {
  if (ticket.state !== "active" || ticket.flagged_at || !stage) return [];
  if (ticket.holding_since) return [{ action: "start", label: `Start ${stage.name}` }];
  if (stage.kind !== "runner" || !stage.human || headlessRunning(latest)) return [];
  return [
    { action: "terminal", label: "Open terminal" },
    { action: "done", label: `Mark ${stage.name} done` },
    { action: "skip", label: `Skip ${stage.name}` },
  ];
}

function headlessRunning(latest: SessionRow | null): latest is SessionRow & { mode: "headless"; ended_at: null } {
  return latest !== null && latest.ended_at === null && latest.mode === "headless";
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function sortForLedger(views: TicketView[]): TicketView[] {
  return [...views].sort((a, b) => {
    const order = LEDGER_ORDER.indexOf(a.display.state) - LEDGER_ORDER.indexOf(b.display.state);
    return order !== 0 ? order : b.updatedAt.localeCompare(a.updatedAt);
  });
}
