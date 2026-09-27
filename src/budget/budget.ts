import type { Config } from "../server/config.ts";
import type { Pipeline, Stage } from "../pipeline/load.ts";
import type { TicketRow } from "../store/tickets.ts";
import type { SessionRow } from "../store/sessions.ts";
import { parseDuration } from "../duration.ts";

export type BudgetLayer = "global" | "pipeline" | "ticket";

/** One dimension as it stands for a Ticket: the winning value and the layer it came from. */
export interface Resolved<T> {
  value: T;
  source: BudgetLayer;
}

/** The four dimensions (CONTEXT.md: Budget), most specific layer winning per dimension. */
export interface Budget {
  rounds: Resolved<number>;
  attempts: Resolved<number>;
  wallTime: Resolved<string>;
  spend: Resolved<number>;
}

/** The Ticket layer as set: a null dimension defers to the Pipeline and the global default. */
export interface TicketBudget {
  rounds: number | null;
  attempts: number | null;
  wallTime: string | null;
  spend: number | null;
}

/** What the Ticket has consumed, derived from its Session rows and never reset. */
export interface Usage {
  /** Sessions of the repeating Stage: the current one when it repeats, else the Pipeline's first. */
  rounds: number;
  /** Sessions of the current Stage that count as tries. */
  attempts: number;
  /** How long the latest headless Session of the current Stage has run, or ran. */
  wallTimeMs: number;
  spend: number;
}

export interface Refusal {
  reason: "budget.rounds" | "budget.attempts" | "budget.cost";
  detail: string;
}

export function ticketBudget(ticket: TicketRow): TicketBudget {
  return { rounds: ticket.budget_rounds, attempts: ticket.budget_attempts, wallTime: ticket.budget_wall_time, spend: ticket.budget_spend };
}

export function resolveBudget(config: Config, pipeline: Pipeline | null, stage: Stage | null, ticket: TicketRow): Budget {
  const own = ticketBudget(ticket);
  const stageBudget = stage?.kind === "runner" ? stage.budget : {};
  return {
    rounds: pick(own.rounds, stageBudget.rounds, config.budget.rounds),
    attempts: pick(own.attempts, stageBudget.attempts, config.budget.attempts),
    wallTime: pick(own.wallTime, stageBudget.wallTime, config.budget.wallTime),
    spend: pick(own.spend, pipeline?.budget.spend, config.budget.spend),
  };
}

function pick<T>(ticket: T | null, pipeline: T | undefined, global: T): Resolved<T> {
  if (ticket !== null && ticket !== undefined) return { value: ticket, source: "ticket" };
  if (pipeline !== undefined) return { value: pipeline, source: "pipeline" };
  return { value: global, source: "global" };
}

/** The Sessions that count as tries at a Stage: a run cut off by shutdown is not one (spec: Budget). */
function triesOf(rows: SessionRow[], stage: string): SessionRow[] {
  return rows.filter((r) => r.stage === stage && r.mode !== "action" && r.ended_reason !== "shutdown");
}

/** The attempts at a Stage; in a repeating Stage, those of its latest Round, since each Round starts its attempts afresh. */
export function attemptsOf(rows: SessionRow[], stage: string): SessionRow[] {
  const tries = triesOf(rows, stage);
  const rounds = tries.map((r) => r.round).filter((n): n is number => n !== null);
  if (rounds.length === 0) return tries;
  const latest = Math.max(...rounds);
  return tries.filter((r) => r.round === latest);
}

/** Rounds of a repeating Stage that were opened: a retry re-runs the same Round, so it counts once (spec: Budget). */
export function roundsOf(rows: SessionRow[], stage: string): number {
  return new Set(triesOf(rows, stage).map((r) => r.round).filter((n): n is number => n !== null)).size;
}

export function spendOf(rows: SessionRow[]): number {
  return rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
}

export function usageOf(rows: SessionRow[], pipeline: Pipeline | null, stage: Stage | null, now: number = Date.now()): Usage {
  const repeating = stage?.kind === "runner" && stage.repeat ? stage : pipeline?.stages.find((s) => s.kind === "runner" && s.repeat) ?? null;
  const latest = stage ? rows.find((r) => r.stage === stage.name && r.mode === "headless") : undefined;
  const wallTimeMs = latest ? Math.max(0, (latest.ended_at ? new Date(latest.ended_at).getTime() : now) - new Date(latest.started_at).getTime()) : 0;
  return {
    rounds: repeating ? roundsOf(rows, repeating.name) : 0,
    attempts: stage ? attemptsOf(rows, stage.name).length : 0,
    wallTimeMs,
    spend: spendOf(rows),
  };
}

/**
 * Why the next Session of the Stage may not start, or null. Spend first; then
 * the Round it would open on a repeating Stage, whose attempts start afresh;
 * else attempts, which every Runner Stage has. Wall time is enforced on the
 * running Session instead.
 */
export function refusalOf(budget: Budget, usage: Usage, stage: Stage, opensRound = false): Refusal | null {
  if (usage.spend >= budget.spend.value) return { reason: "budget.cost", detail: `spend $${usage.spend.toFixed(2)} of $${budget.spend.value} used` };
  if (opensRound) {
    if (usage.rounds >= budget.rounds.value) return { reason: "budget.rounds", detail: `${stage.name}: ${usage.rounds} of ${budget.rounds.value} Rounds used` };
    return null;
  }
  if (usage.attempts >= budget.attempts.value) return { reason: "budget.attempts", detail: `${stage.name}: ${usage.attempts} of ${budget.attempts.value} attempts used` };
  return null;
}

export interface GaugeView {
  used: number;
  limit: number;
  source: BudgetLayer;
}

/** The four ring gauges plus the Ticket layer the inline editor edits. Wall time is in milliseconds. */
export interface BudgetView {
  rounds: GaugeView;
  attempts: GaugeView;
  wallTime: GaugeView & { limitText: string };
  spend: GaugeView;
  ticket: TicketBudget;
}

export function budgetView(budget: Budget, usage: Usage, ticket: TicketRow): BudgetView {
  return {
    rounds: { used: usage.rounds, limit: budget.rounds.value, source: budget.rounds.source },
    attempts: { used: usage.attempts, limit: budget.attempts.value, source: budget.attempts.source },
    wallTime: { used: usage.wallTimeMs, limit: parseDuration(budget.wallTime.value), source: budget.wallTime.source, limitText: budget.wallTime.value },
    spend: { used: usage.spend, limit: budget.spend.value, source: budget.spend.source },
    ticket: ticketBudget(ticket),
  };
}
