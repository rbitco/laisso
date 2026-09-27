import type { TicketRow } from "../store/tickets.ts";
import type { Pipeline, Stage } from "../pipeline/load.ts";

export type DisplayState = "flagged" | "needs_you" | "ready" | "running" | "queued" | "quiet" | "done" | "abandoned";

/** Human wording for each display state, served so every client shows the same words. */
export const DISPLAY_LABEL: Record<DisplayState, string> = {
  flagged: "Flagged",
  needs_you: "Needs you",
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
  createdAt: string;
  updatedAt: string;
  url: string;
}

/** One Ticket with every Stage of its Pipeline, for the detail page. */
export interface TicketDetail extends TicketView {
  stages: Array<Pick<StageView, "name" | "kind" | "label" | "human">>;
}

/** What intake returns: the new Ticket's view plus whether its branch was found rather than made. */
export interface IntakeResult extends TicketView {
  branchExisted: boolean;
}

export interface ViewContext {
  baseUrl: string;
  pipelineFor(ticket: TicketRow): Pipeline | null;
}

/** The order the Ledger shows display states in: attention first. */
export const LEDGER_ORDER: DisplayState[] = ["flagged", "needs_you", "ready", "running", "queued", "quiet", "done", "abandoned"];

export function stageLabel(stage: Stage): string {
  return stage.kind === "action" ? stage.status : stage.name;
}

export function ticketView(ticket: TicketRow, ctx: ViewContext): TicketView {
  const pipeline = ctx.pipelineFor(ticket);
  const index = pipeline ? pipeline.stages.findIndex((s) => s.name === ticket.stage) : -1;
  const stage = index >= 0 ? pipeline!.stages[index]! : null;
  const human = stage?.kind === "runner" && stage.human;
  const display = displayState(ticket, human);
  return {
    id: ticket.id,
    shortId: ticket.id.slice(-8),
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
  return { ...ticketView(ticket, ctx), stages };
}

function displayState(ticket: TicketRow, human: boolean): { state: DisplayState; why: string } {
  if (ticket.state === "done") return { state: "done", why: "done" };
  if (ticket.state === "abandoned") return { state: "abandoned", why: "abandoned" };
  if (ticket.flagged_at) return { state: "flagged", why: ticket.flag_reason ?? "flagged" };
  if (human) return { state: "needs_you", why: "not started" };
  return { state: "ready", why: `waiting to start ${ticket.stage}` };
}

export function sortForLedger(views: TicketView[]): TicketView[] {
  return [...views].sort((a, b) => {
    const order = LEDGER_ORDER.indexOf(a.display.state) - LEDGER_ORDER.indexOf(b.display.state);
    return order !== 0 ? order : b.updatedAt.localeCompare(a.updatedAt);
  });
}
