import { shortId, type TicketRow } from "../store/tickets.ts";
import type { SessionRow } from "../store/sessions.ts";
import { type Pipeline, type RunnerName, type Stage } from "../pipeline/load.ts";
import type { PipelineSource } from "../pipeline/files.ts";
import type { Drift, VersionRow } from "../store/versions.ts";
import type { ActionConfig, Config } from "../server/config.ts";
import type { BudgetView } from "../budget/budget.ts";
import { adapterFor } from "../runner/adapters.ts";
import type { FeedbackRow } from "../store/feedback.ts";
import { quietWhy } from "../review/review.ts";

export type DisplayState = "flagged" | "needs_you" | "holding" | "ready" | "running" | "queued" | "quiet" | "done" | "abandoned";

/** A lever the human can pull on a Ticket right now; the dashboard renders one button per Trigger. Flagged, the six exits. */
export interface Trigger {
  action: "terminal" | "done" | "skip" | "start" | "retry" | "resume" | "extend" | "abandon";
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
  /** Whether the Stage repeats on PR feedback: Rounds, the orbit, and Check PR now belong to it. */
  repeat: boolean;
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
  /** The Version of the Pipeline the Ticket runs (ADR 0009); null for a Ticket from before Versions that could not be pinned. */
  pipelineVersion: number | null;
  stage: StageView;
  state: TicketRow["state"];
  flag: { at: string; reason: string; detail: string | null } | null;
  pr: string | null;
  display: { state: DisplayState; label: string; why: string };
  /** Place in the line for a headless slot when Queued, else null. */
  queue: number | null;
  triggers: Trigger[];
  /** The four gauges as they stand, and the Ticket layer behind them. */
  budget: BudgetView;
  /** Every Stage of the Pipeline, for the Metro track and diagram; empty when the Pipeline does not load. */
  stages: Array<Pick<StageView, "name" | "kind" | "label" | "human">>;
  /** True while a label push to the tracker is owed and the tick will retry it. */
  mirrorPending: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
}

/** One Feedback item a Round was told about, and how it was addressed once the Round ended. */
export interface FeedbackView {
  kind: FeedbackRow["kind"];
  id: string;
  summary: string;
  url: string | null;
  path: string | null;
  line: number | null;
  addressed: string | null;
}

export interface SessionView {
  id: string;
  ticket: string;
  stage: string;
  ordinal: number;
  /** The Round this Session worked, in a repeating Stage. */
  round: number | null;
  /** The Round's Feedback snapshot; empty outside a repeating Stage. */
  feedback: FeedbackView[];
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
  /** The Runner's own id for the Session when it names its own (a Codex thread), for resuming by hand. */
  runnerSessionId: string | null;
  stdoutPath: string | null;
  transcriptPath: string | null;
  running: boolean;
  /** Milliseconds so far, or to the end. */
  durationMs: number;
}

/** One Ticket with every Stage of its Pipeline and its Sessions, for the detail page. */
export interface TicketDetail extends TicketView {
  /** The latest Session: the pane shows it, running or not. */
  session: SessionView | null;
  /** The timeline, newest first. */
  sessions: SessionView[];
  /** How the Pipeline file stands against the Ticket's Version (ADR 0009); null for a Ticket that runs the file itself. */
  pipelineDrift: Drift | null;
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
  /** A Round's Feedback snapshot as recorded. */
  feedbackFor(session: SessionRow): FeedbackRow[];
  budgetFor(ticket: TicketRow, pipeline: Pipeline | null, stage: Stage | null, rows: SessionRow[]): BudgetView;
  driftFor(ticket: TicketRow): Drift | null;
  /** The Ticket's place in the line for a headless slot, 1 first, or null when it is not in line. */
  queuePosition(ticket: TicketRow): number | null;
}

/** The order the Ledger shows display states in: attention first. */
export const LEDGER_ORDER: DisplayState[] = ["flagged", "needs_you", "holding", "ready", "running", "queued", "quiet", "done", "abandoned"];

/** A Pipeline as the editor sees it: every field of every Stage, action Stages included. */
export interface PipelineView {
  runner: RunnerName;
  budget: { spend?: number };
  stages: StageFields[];
}

export type StageFields =
  | { kind: "runner"; name: string; label: string; prompt: string | null; skills: string[]; runner: RunnerName | null; human: boolean; advance: boolean; artifact: string | null; repeat: "feedback" | null; budget: { rounds?: number; attempts?: number; wallTime?: string }; runnerOptions: Record<string, unknown> }
  | { kind: "action"; name: string; label: string; action: string; with: Record<string, string> };

export interface PipelineListing {
  name: string;
  file: string;
  stages: Array<{ name: string; kind: Stage["kind"]; label: string }>;
  problem: string | null;
}

export interface PipelineFile {
  name: string;
  file: string;
  text: string;
  pipeline: PipelineView | null;
  problem: string | null;
}

/** A frozen Version of a Pipeline, read-only, with how many active Tickets run it. */
export interface PipelineVersionView {
  name: string;
  version: number;
  createdAt: string;
  live: number;
  /** True once the Pipeline's file is gone; the Version still reads. */
  deleted: boolean;
  pipeline: PipelineView;
}

export interface ConfigFile {
  file: string;
  text: string;
  config: Config;
  /** Keys this edit changed whose new value applies only after a restart. */
  restart: string[];
}

/** One Action config.yaml defines: global when repo is null, else that repo's own (an override when a global one shares its name). */
export interface ActionListing {
  name: string;
  repo: string | null;
  params: string[];
  timeout: string;
  run: string;
}

/** Every Action in config, the global ones first, then each repo's, each set by name. */
export function actionListings(config: Config): ActionListing[] {
  const list = (actions: Record<string, ActionConfig>, repo: string | null) =>
    Object.entries(actions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, a]) => ({ name, repo, params: a.params, timeout: a.timeout, run: a.run }));
  return [...list(config.actions, null), ...Object.entries(config.repos).flatMap(([repo, r]) => list(r.actions, repo))];
}

export function pipelineListing(source: PipelineSource): PipelineListing {
  return { name: source.name, file: source.file, stages: (source.pipeline?.stages ?? []).map((s) => ({ name: s.name, kind: s.kind, label: stageLabel(s) })), problem: source.problem };
}

export function pipelineFileView(source: PipelineSource): PipelineFile {
  const pipeline = source.pipeline;
  return {
    name: source.name,
    file: source.file,
    text: source.text,
    pipeline: pipeline ? pipelineFields(pipeline) : null,
    problem: source.problem,
  };
}

export function pipelineVersionView(row: VersionRow, pipeline: Pipeline, deleted: boolean): PipelineVersionView {
  return { name: row.pipeline, version: row.version, createdAt: row.created_at, live: row.live, deleted, pipeline: pipelineFields(pipeline) };
}

function pipelineFields(pipeline: Pipeline): PipelineView {
  return { runner: pipeline.runner, budget: pipeline.budget, stages: pipeline.stages.map(stageFields) };
}

/** A Stage as the editor shows it: a runner it inherits from the Pipeline is null, so the form can say so. */
function stageFields(stage: Stage): StageFields {
  if (stage.kind === "action") return { ...stage, label: stageLabel(stage) };
  const { inheritsRunner, ...fields } = stage;
  return { ...fields, label: stageLabel(stage), runner: inheritsRunner ? null : stage.runner };
}

/** What the stepper calls a Stage: an action Stage with params by their values (a transition by its status), any other by its name. */
export function stageLabel(stage: Stage): string {
  const values = stage.kind === "action" ? Object.values(stage.with).filter(Boolean) : [];
  return values.length ? values.join(" ") : stage.name;
}

export function ticketView(ticket: TicketRow, ctx: ViewContext): TicketView {
  const pipeline = ctx.pipelineFor(ticket);
  const index = pipeline ? pipeline.stages.findIndex((s) => s.name === ticket.stage) : -1;
  const stage = index >= 0 ? pipeline!.stages[index]! : null;
  const human = stage?.kind === "runner" && stage.human;
  const rows = ctx.sessionsFor(ticket);
  const queue = ctx.queuePosition(ticket);
  const budget = ctx.budgetFor(ticket, pipeline, stage, rows);
  const display = displayState(ticket, stage, rows[0] ?? null, queue, budget.rounds.limit);
  const triggers = ticketTriggers(ticket, stage, rows);
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
    pipelineVersion: ticket.pipeline_version,
    stage: {
      name: ticket.stage,
      kind: stage?.kind ?? "runner",
      label: stage ? stageLabel(stage) : ticket.stage,
      human,
      index,
      total: pipeline?.stages.length ?? 0,
      repeat: stage?.kind === "runner" && stage.repeat === "feedback",
    },
    state: ticket.state,
    flag: ticket.flagged_at ? { at: ticket.flagged_at, reason: ticket.flag_reason ?? "", detail: ticket.flag_detail } : null,
    pr: ticket.pr,
    display: { ...display, label: DISPLAY_LABEL[display.state] },
    queue,
    triggers,
    budget,
    stages: (pipeline?.stages ?? []).map((s) => ({ name: s.name, kind: s.kind, label: stageLabel(s), human: s.kind === "runner" && s.human })),
    mirrorPending: ticket.mirror_pending !== null,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    url: `${ctx.baseUrl}/#${ticket.id}`,
  };
}

export function ticketDetail(ticket: TicketRow, ctx: ViewContext): TicketDetail {
  const sessions = ctx.sessionsFor(ticket).map((row) => sessionView(row, Date.now(), ctx.feedbackFor(row)));
  return { ...ticketView(ticket, ctx), session: sessions[0] ?? null, sessions, pipelineDrift: ctx.driftFor(ticket) };
}

export function sessionView(row: SessionRow, now: number = Date.now(), feedback: FeedbackRow[] = []): SessionView {
  const started = new Date(row.started_at).getTime();
  const ended = row.ended_at ? new Date(row.ended_at).getTime() : now;
  return {
    id: row.id,
    ticket: row.ticket,
    stage: row.stage,
    ordinal: row.ordinal,
    round: row.round,
    feedback: feedback.map((f) => ({ kind: f.kind, id: f.source_id, summary: f.summary, url: f.url, path: f.path, line: f.line, addressed: f.addressed })),
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
    runnerSessionId: row.runner_session_id,
    stdoutPath: row.stdout_path,
    transcriptPath: row.transcript_path,
    running: row.ended_at === null,
    durationMs: Math.max(0, ended - started),
  };
}

function displayState(ticket: TicketRow, stage: Stage | null, latest: SessionRow | null, queue: number | null, rounds: number): { state: DisplayState; why: string } {
  const human = stage?.kind === "runner" && stage.human;
  const name = stage ? stageLabel(stage) : ticket.stage;
  if (ticket.state === "done") return { state: "done", why: "done" };
  if (ticket.state === "abandoned") return { state: "abandoned", why: "abandoned" };
  if (ticket.flagged_at) return { state: "flagged", why: ticket.flag_reason ?? "flagged" };
  if (latest?.ended_at === null && latest.mode === "action") return { state: "running", why: `${latest.stage}, running its command` };
  if (headlessRunning(latest)) return { state: "running", why: latest.round !== null ? `${latest.stage}, Round ${latest.round} of ${rounds}` : `${latest.stage}, run ${latest.ordinal}` };
  if (ticket.holding_since) return { state: "holding", why: `Start ${name} when ready` };
  if (human) {
    const opened = latest && latest.ended_at === null && latest.mode === "terminal" && latest.stage === ticket.stage ? latest.opened_at : null;
    return { state: "needs_you", why: opened ? `terminal opened ${clockTime(opened)}` : "not started" };
  }
  if (queue !== null) return { state: "queued", why: `${queue} in line; ${name} starts when a slot frees` };
  // A repeating Stage with no Round due waits on its PR: quiet (spec: Review loop).
  if (stage?.kind === "runner" && stage.repeat && !ticket.feedback_due) return { state: "quiet", why: quietWhy(ticket, name) };
  return { state: "ready", why: `${name} starts on the next tick` };
}

function resumableHeadless(rows: SessionRow[], stage: string, runner: RunnerName): boolean {
  const last = rows.find((r) => r.stage === stage && r.mode === "headless");
  return last !== undefined && (adapterFor(runner).sessionIds === "lasso" || last.runner_session_id !== null);
}

function ticketTriggers(ticket: TicketRow, stage: Stage | null, rows: SessionRow[]): Trigger[] {
  if (ticket.state !== "active") return [];
  const abandon: Trigger = { action: "abandon", label: "Abandon" };
  if (!stage) return [abandon];
  if (ticket.flagged_at) {
    // Resume needs something to re-enter: a terminal window that opened, or the last headless Session of this
    // Stage, which a Runner that names its own sessions must have reported an id for.
    const resumable = stage.kind === "runner" && (stage.human ? rows.some((r) => r.stage === stage.name && r.mode === "terminal" && r.ended_at === null && r.opened_at !== null) : resumableHeadless(rows, stage.name, stage.runner));
    return [
      { action: "retry", label: `Retry ${stage.name}` },
      ...(resumable ? [{ action: "resume" as const, label: `Resume ${stage.name}` }] : []),
      { action: "extend", label: "Extend Budget" },
      { action: "done", label: `Mark ${stage.name} done` },
      { action: "skip", label: `Skip ${stage.name}` },
      abandon,
    ];
  }
  if (ticket.holding_since) return [{ action: "start", label: `Start ${stage.name}` }, abandon];
  if (stage.kind !== "runner" || !stage.human || headlessRunning(rows[0] ?? null)) return [abandon];
  return [
    { action: "terminal", label: "Open terminal" },
    { action: "done", label: `Mark ${stage.name} done` },
    { action: "skip", label: `Skip ${stage.name}` },
    abandon,
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
    if (order !== 0) return order;
    // Queued rows by their place in line; every other group most recent activity first.
    if (a.queue !== null && b.queue !== null) return a.queue - b.queue;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
